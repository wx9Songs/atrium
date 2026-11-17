package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Session info: what the page's Info panel shows next to a conversation. How
// full the context window is and what fills it, the model in use, the MCP
// servers, and during a turn the background tasks the agent has started.
//
// For Claude the CLI itself answers (control requests on the stream it already
// speaks): during a turn the running process is asked, and for a session at
// rest a CLI is started on it without sending a message, which costs no tokens
// and writes nothing. For Codex the figures are read from the session file.

// slimContext keeps what the page shows from Claude's get_context_usage answer.
func slimContext(x map[string]any) map[string]any {
	if x == nil {
		return nil
	}
	cats := []map[string]any{}
	if list, _ := x["categories"].([]any); list != nil {
		for _, it := range list {
			c, _ := it.(map[string]any)
			if c == nil {
				continue
			}
			cats = append(cats, map[string]any{"id": str(c, "id"), "name": str(c, "name"), "tokens": c["tokens"], "kind": str(c, "kind")})
		}
	}
	if len(cats) == 0 {
		return nil
	}
	out := map[string]any{
		"used": x["totalTokens"], "max": x["maxTokens"], "percent": x["percentage"], "model": str(x, "model"),
		"categories": cats, "auto_compact": x["isAutoCompactEnabled"], "compact_at": x["autoCompactThreshold"],
	}
	if list, _ := x["memoryFiles"].([]any); len(list) > 0 {
		files := []map[string]any{}
		for _, it := range list {
			if f, _ := it.(map[string]any); f != nil && len(files) < 20 {
				files = append(files, map[string]any{"path": str(f, "path"), "type": str(f, "type"), "tokens": f["tokens"]})
			}
		}
		out["memory"] = files
	}
	if s, _ := x["skills"].(map[string]any); s != nil {
		out["skills"] = map[string]any{"count": s["includedSkills"], "tokens": s["tokens"]}
	}
	// MCP tools, added up by server.
	if list, _ := x["mcpTools"].([]any); len(list) > 0 {
		type agg struct {
			tools, loaded int
			tokens        float64
		}
		by := map[string]*agg{}
		var names []string
		for _, it := range list {
			tl, _ := it.(map[string]any)
			if tl == nil {
				continue
			}
			name := str(tl, "serverName")
			a := by[name]
			if a == nil {
				a = &agg{}
				by[name] = a
				names = append(names, name)
			}
			a.tools++
			if n, _ := tl["tokens"].(float64); n > 0 {
				a.tokens += n
			}
			if on, _ := tl["isLoaded"].(bool); on {
				a.loaded++
			}
		}
		sort.Strings(names)
		servers := []map[string]any{}
		for _, n := range names {
			servers = append(servers, map[string]any{"server": n, "tools": by[n].tools, "loaded": by[n].loaded, "tokens": by[n].tokens})
		}
		out["mcp_tools"] = servers
	}
	if b, _ := x["messageBreakdown"].(map[string]any); b != nil {
		out["messages"] = map[string]any{
			"user": b["userMessageTokens"], "assistant": b["assistantMessageTokens"], "tool_calls": b["toolCallTokens"],
			"tool_results": b["toolResultTokens"], "attachments": b["attachmentTokens"],
		}
	}
	return out
}

// slimMCP keeps the name and state of each MCP server from Claude's mcp_status answer.
func slimMCP(x map[string]any) []map[string]any {
	out := []map[string]any{}
	list, _ := x["mcpServers"].([]any)
	for _, it := range list {
		if s, _ := it.(map[string]any); s != nil && len(out) < 40 {
			out = append(out, map[string]any{"name": clipRunes(str(s, "name"), 60), "status": str(s, "status"), "scope": str(s, "scope")})
		}
	}
	return out
}

// ---------- background tasks of a running turn ----------

type bgTask struct {
	ID          string `json:"id"`
	Type        string `json:"type"` // local_bash, local_agent, monitor, …: the CLI's own word
	Description string `json:"description"`
	Status      string `json:"status"` // running | completed | failed | killed | …
	Started     int64  `json:"started,omitempty"`
	Ended       int64  `json:"ended,omitempty"`
	Summary     string `json:"summary,omitempty"`
	// Output: the CLI keeps the task's output in a file, which the page can ask
	// for (see taskOutput). The path itself stays on the machine.
	Output    bool   `json:"output,omitempty"`
	toolUseID string // the tool call that started it
	file      string
}

// taskFiles maps task ids to their output files, also after the process that
// ran them has ended, so the page can still show what a task printed.
var taskFiles sync.Map

var outputFileRe = regexp.MustCompile(`Output is being written to: (\S+\.output)`)

func (t *bgTask) setFile(path string) {
	if path == "" || !strings.HasSuffix(path, ".output") {
		return
	}
	t.file, t.Output = path, true
	taskFiles.Store(t.ID, path)
}

// taskBook follows the tasks a Claude process reports. The CLI names the ones
// still going (background_tasks_changed) and tells how each ended.
type taskBook struct {
	mu     sync.Mutex
	order  []string
	byID   map[string]*bgTask
	active int
	files  map[string]string // tool call id → output file, when the result came before the task
}

func (tb *taskBook) get(id string) *bgTask {
	if tb.byID == nil {
		tb.byID = map[string]*bgTask{}
	}
	t := tb.byID[id]
	if t == nil {
		t = &bgTask{ID: id, Status: "running", Started: time.Now().UnixMilli()}
		tb.byID[id] = t
		tb.order = append(tb.order, id)
	}
	return t
}

// noteResult reads where a background command writes its output from the result
// of the tool call that started it, and reports whether that told anything new.
func (tb *taskBook) noteResult(toolUseID, text string) bool {
	mm := outputFileRe.FindStringSubmatch(text)
	if toolUseID == "" || mm == nil {
		return false
	}
	tb.mu.Lock()
	defer tb.mu.Unlock()
	for _, t := range tb.byID {
		if t.toolUseID == toolUseID {
			if t.file == mm[1] {
				return false
			}
			t.setFile(mm[1])
			return true
		}
	}
	if tb.files == nil {
		tb.files = map[string]string{}
	}
	tb.files[toolUseID] = mm[1]
	return false
}

// resultText is a tool result's text, given as a string or as text blocks.
func resultText(c any) string {
	switch v := c.(type) {
	case string:
		return v
	case []any:
		var sb strings.Builder
		for _, part := range v {
			if pm, _ := part.(map[string]any); str(pm, "type") == "text" {
				sb.WriteString(str(pm, "text"))
			}
		}
		return sb.String()
	}
	return ""
}

// taskOutput is the end of what a background task has printed so far.
func taskOutput(taskID string) (map[string]any, error) {
	v, ok := taskFiles.Load(taskID)
	if !ok {
		return nil, bi("这个任务的输出在这台机器上找不到（runner 重启过，或者它不写输出文件）", "This task's output cannot be found on this machine (the runner restarted, or the task writes no output file)")
	}
	f, err := os.Open(v.(string))
	if err != nil {
		return nil, bif("读不到任务输出：%v", "Could not read the task's output: %v", err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	const max = 64 << 10
	from := st.Size() - max
	if from < 0 {
		from = 0
	}
	b := make([]byte, st.Size()-from)
	n, _ := f.ReadAt(b, from)
	b = b[:n]
	if from > 0 { // start at a whole line and a whole character
		if i := bytes.IndexByte(b, '\n'); i >= 0 && i < 4096 {
			b = b[i+1:]
		}
	}
	return map[string]any{"text": strings.ToValidUTF8(string(b), "�"), "size": st.Size(), "cut": from > 0}, nil
}

// apply takes one "system" event about tasks and reports whether anything changed.
func (tb *taskBook) apply(m map[string]any) bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()
	switch str(m, "subtype") {
	case "background_tasks_changed":
		list, _ := m["tasks"].([]any)
		live := map[string]bool{}
		for _, it := range list {
			x, _ := it.(map[string]any)
			if x == nil || str(x, "task_id") == "" {
				continue
			}
			t := tb.get(str(x, "task_id"))
			live[t.ID] = true
			t.Type, t.Description = str(x, "task_type"), clipRunes(str(x, "description"), 200)
			if t.Ended == 0 {
				t.Status = "running"
			}
		}
		for _, t := range tb.byID {
			if !live[t.ID] && t.Status == "running" {
				t.Status, t.Ended = "completed", time.Now().UnixMilli()
			}
		}
		tb.active = len(live)
	case "task_started":
		if bg, _ := m["is_backgrounded"].(bool); !bg {
			return false // a foreground sub-agent: the conversation shows it
		}
		t := tb.get(str(m, "task_id"))
		t.Type, t.Description = str(m, "task_type"), clipRunes(str(m, "description"), 200)
		t.toolUseID = str(m, "tool_use_id")
		if f := tb.files[t.toolUseID]; f != "" && t.file == "" {
			t.setFile(f)
		}
	case "task_updated":
		t := tb.byID[str(m, "task_id")]
		patch, _ := m["patch"].(map[string]any)
		if t == nil || patch == nil {
			return false
		}
		if s := str(patch, "status"); s != "" {
			t.Status = s
		}
		if n, _ := patch["end_time"].(float64); n > 0 {
			t.Ended = int64(n)
		}
	case "task_notification":
		t := tb.byID[str(m, "task_id")]
		if t == nil {
			return false
		}
		if s := str(m, "status"); s != "" {
			t.Status = s
		}
		t.Summary = clipRunes(str(m, "summary"), 300)
		t.setFile(str(m, "output_file"))
		if t.Ended == 0 && t.Status != "running" {
			t.Ended = time.Now().UnixMilli()
		}
	default:
		return false
	}
	return true
}

func (tb *taskBook) list() []bgTask {
	tb.mu.Lock()
	defer tb.mu.Unlock()
	out := []bgTask{}
	for _, id := range tb.order {
		out = append(out, *tb.byID[id])
	}
	if len(out) > 30 {
		out = out[len(out)-30:]
	}
	return out
}

func (tb *taskBook) running() int {
	tb.mu.Lock()
	defer tb.mu.Unlock()
	return tb.active
}

// ---------- a session at rest ----------

type infoEntry struct {
	stamp string
	data  map[string]any
}

var infoCache = struct {
	sync.Mutex
	m map[string]infoEntry
}{m: map[string]infoEntry{}}

func fileStamp(path string) string {
	fi, err := os.Stat(path)
	if err != nil {
		return ""
	}
	return fi.ModTime().UTC().Format(time.RFC3339Nano) + "/" + itoa(fi.Size())
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// sessionInfo answers the page's question about one session.
func (r *Runner) sessionInfo(agent, id string) (any, error) {
	if id == "" {
		return nil, bi("缺少会话 ID", "Missing session ID")
	}
	var file string
	switch agent {
	case "claude":
		file, _ = r.findClaudeSession(id)
	case "codex":
		file, _ = r.findCodexSession(id)
	default:
		return nil, bif("不支持的助手：%s", "Unsupported agent: %s", agent)
	}
	if file == "" {
		return nil, bi("在这台机器上找不到这个会话的记录文件", "This session's transcript is not on this machine")
	}
	key, stamp := agent+":"+id, fileStamp(file)
	infoCache.Lock()
	if e, ok := infoCache.m[key]; ok && e.stamp == stamp {
		infoCache.Unlock()
		return e.data, nil
	}
	infoCache.Unlock()

	var data map[string]any
	var err error
	if agent == "claude" {
		data, err = r.claudeSessionInfo(id, file)
	} else {
		data = codexSessionInfo(file)
		if data == nil {
			err = bi("这个会话的记录里还没有用量信息", "This session's transcript has no usage figures yet")
		}
	}
	if err != nil {
		return nil, err
	}
	data["agent"], data["at"] = agent, time.Now().UnixMilli()
	infoCache.Lock()
	if len(infoCache.m) > 200 {
		infoCache.m = map[string]infoEntry{}
	}
	infoCache.m[key] = infoEntry{stamp: stamp, data: data}
	infoCache.Unlock()
	return data, nil
}

// claudeSessionInfo starts the CLI on the session without sending it anything
// and asks it for its context usage, MCP servers and settings. Nothing is
// saved (--no-session-persistence) and no model is called.
func (r *Runner) claudeSessionInfo(id, file string) (map[string]any, error) {
	bin, err := exec.LookPath("claude")
	if err != nil {
		return nil, bi("这台机器上找不到 claude 命令", "The claude command was not found on this machine")
	}
	_, store := r.findClaudeSession(id)
	env := os.Environ()
	if store = r.usableClaudeStore(file, store); store == filepath.Join(r.home, ".claude") {
		env = setEnv(env, "CLAUDE_CONFIG_DIR", "")
	} else {
		env = setEnv(env, "CLAUDE_CONFIG_DIR", store)
	}
	cwd := claudeCwd(file)
	if cwd == "" || !isDir(cwd) {
		cwd = r.home
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--permission-prompt-tool", "stdio", "--no-session-persistence", "--resume", id)
	cmd.Dir, cmd.Env = cwd, env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, bif("启动 claude 失败：%v", "Could not start claude: %v", err)
	}
	defer endCLI(stdin, cmd)
	for _, sub := range []string{"get_context_usage", "mcp_status", "get_settings"} {
		req, _ := json.Marshal(map[string]any{"type": "control_request", "request_id": sub, "request": map[string]any{"subtype": sub}})
		stdin.Write(append(req, '\n'))
	}
	out := map[string]any{}
	left := 3
	rd := bufio.NewReaderSize(stdout, 1<<16)
	for left > 0 {
		line, err := rd.ReadBytes('\n')
		if len(line) > 1 {
			var m struct {
				Type     string `json:"type"`
				Response struct {
					RequestID string         `json:"request_id"`
					Response  map[string]any `json:"response"`
				} `json:"response"`
			}
			if json.Unmarshal(line, &m) == nil && m.Type == "control_response" {
				left--
				switch m.Response.RequestID {
				case "get_context_usage":
					if c := slimContext(m.Response.Response); c != nil {
						out["context"] = c
					}
				case "mcp_status":
					out["mcp"] = slimMCP(m.Response.Response)
				case "get_settings":
					if a, _ := m.Response.Response["applied"].(map[string]any); a != nil {
						out["session"] = map[string]any{"model": str(a, "model"), "effort": str(a, "effort")}
					}
				}
			}
		}
		if err != nil {
			break
		}
	}
	if out["context"] == nil {
		return nil, bi("没能从 Claude 读到这个会话的上下文用量", "Could not read this session's context usage from Claude")
	}
	return out, nil
}

// codexSessionInfo reads a Codex session file: the last token count (how much
// of the context window the latest request used) and the turn's settings.
func codexSessionInfo(path string) map[string]any {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var usage, turn map[string]any
	rd := bufio.NewReaderSize(f, 1<<16)
	for {
		line, err := rd.ReadBytes('\n')
		if len(line) > 1 {
			var d struct {
				Type    string         `json:"type"`
				Payload map[string]any `json:"payload"`
			}
			if json.Unmarshal(line, &d) == nil && d.Payload != nil {
				switch {
				case d.Type == "turn_context":
					turn = d.Payload
				case d.Type == "event_msg" && str(d.Payload, "type") == "token_count":
					if info, _ := d.Payload["info"].(map[string]any); info != nil {
						usage = info
					}
				}
			}
		}
		if err != nil {
			break
		}
	}
	if usage == nil && turn == nil {
		return nil
	}
	out := map[string]any{}
	if turn != nil {
		s := map[string]any{"model": str(turn, "model"), "effort": str(turn, "effort"), "approval": str(turn, "approval_policy")}
		if sb, _ := turn["sandbox_policy"].(map[string]any); sb != nil {
			s["sandbox"] = str(sb, "type")
		}
		out["session"] = s
	}
	if usage != nil {
		last, _ := usage["last_token_usage"].(map[string]any)
		total, _ := usage["total_token_usage"].(map[string]any)
		max, _ := usage["model_context_window"].(float64)
		if last == nil {
			last = total
		}
		used, _ := last["total_tokens"].(float64)
		if used == 0 {
			in, _ := last["input_tokens"].(float64)
			o, _ := last["output_tokens"].(float64)
			used = in + o
		}
		c := map[string]any{"used": used, "categories": []map[string]any{{"id": "messages", "name": "Conversation", "tokens": used, "kind": "used"}}}
		if max > 0 {
			c["max"] = max
			c["percent"] = int(used*100/max + 0.5)
			if free := max - used; free > 0 {
				c["categories"] = append(c["categories"].([]map[string]any), map[string]any{"id": "free_space", "name": "Free space", "tokens": free, "kind": "free"})
			}
		}
		if turn != nil {
			c["model"] = str(turn, "model")
		}
		out["context"] = c
		if total != nil {
			out["totals"] = map[string]any{
				"input": total["input_tokens"], "cached": total["cached_input_tokens"], "output": total["output_tokens"], "reasoning": total["reasoning_output_tokens"],
			}
		}
	}
	return out
}

// slimModelUsage keeps, per model of a finished turn, its tokens and cost.
func slimModelUsage(v any) []map[string]any {
	by, _ := v.(map[string]any)
	names := make([]string, 0, len(by))
	for n := range by {
		names = append(names, n)
	}
	sort.Strings(names)
	out := []map[string]any{}
	for _, n := range names {
		u, _ := by[n].(map[string]any)
		if u == nil {
			continue
		}
		out = append(out, map[string]any{
			"model": n, "in": u["inputTokens"], "out": u["outputTokens"], "cache_read": u["cacheReadInputTokens"],
			"cache_write": u["cacheCreationInputTokens"], "cost": u["costUSD"], "window": u["contextWindow"],
		})
	}
	return out
}

// stopTask asks the running CLI to stop one of its background tasks.
func (p *proc) stopTask(id string) {
	p.write(map[string]any{"type": "control_request", "request_id": "stoptask_" + id, "request": map[string]any{"subtype": "stop_task", "task_id": id}})
}

// endCLI lets a CLI that was only asked questions leave on its own: its input
// is closed and it gets a few seconds. Killing it at once could catch it while
// it renews its sign-in (the old token already spent, the new one not yet
// saved), which signs the machine out.
func endCLI(stdin interface{ Close() error }, cmd *exec.Cmd) {
	stdin.Close()
	done := make(chan struct{})
	go func() {
		cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		cmd.Process.Kill()
		<-done
	}
}
