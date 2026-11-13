//go:build unix

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

type pendingPerm struct {
	Input       json.RawMessage
	Suggestions json.RawMessage
}

// proc is one agent process handling one turn.
type proc struct {
	r   *Runner
	job Job

	mu          sync.Mutex
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	stdinClosed bool
	stopped     bool
	pending     map[string]pendingPerm
}

func (p *proc) isStopped() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stopped
}

func (p *proc) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stdin == nil || p.stdinClosed {
		return errors.New("stdin closed")
	}
	_, err = p.stdin.Write(append(b, '\n'))
	return err
}

func (p *proc) closeStdin() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stdin != nil && !p.stdinClosed {
		p.stdinClosed = true
		p.stdin.Close()
	}
}

// tail keeps the last few KB written to it (for error messages).
type tail struct {
	mu sync.Mutex
	b  []byte
}

func (t *tail) Write(b []byte) (int, error) {
	t.mu.Lock()
	t.b = append(t.b, b...)
	if len(t.b) > 4096 {
		t.b = t.b[len(t.b)-4096:]
	}
	t.mu.Unlock()
	return len(b), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(string(t.b))
}

// launch starts the agent in its own process group and feeds stdout lines to onLine.
func (p *proc) launch(bin string, args []string, cwd string, env []string, withStdin bool, onLine func(map[string]any)) (stderrText string, waitErr error, startErr error) {
	cmd := exec.Command(bin, args...)
	cmd.Dir = cwd
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	errTail := &tail{}
	cmd.Stderr = errTail
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", nil, err
	}
	var stdin io.WriteCloser
	if withStdin {
		if stdin, err = cmd.StdinPipe(); err != nil {
			return "", nil, err
		}
	}
	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return "", nil, errors.New("stopped before start")
	}
	if err := cmd.Start(); err != nil {
		p.mu.Unlock()
		return "", nil, err
	}
	p.cmd, p.stdin = cmd, stdin
	p.mu.Unlock()

	p.r.emit(p.job.ID, "status", map[string]any{"state": "starting", "started_ts": time.Now().UnixMilli(), "pid": cmd.Process.Pid})

	rd := bufio.NewReaderSize(stdout, 1<<16)
	for {
		line, err := rd.ReadBytes('\n')
		if len(line) > 1 {
			var m map[string]any
			if json.Unmarshal(line, &m) == nil {
				onLine(m)
			}
		}
		if err != nil {
			break
		}
	}
	waitErr = cmd.Wait()
	return errTail.String(), waitErr, nil
}

func (p *proc) stop() {
	p.mu.Lock()
	p.stopped = true
	cmd := p.cmd
	p.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	if p.job.Agent == "claude" {
		p.write(map[string]any{"type": "control_request", "request_id": "stop_" + p.job.ID, "request": map[string]any{"subtype": "interrupt"}})
	} else {
		syscall.Kill(-pid, syscall.SIGINT)
	}
	go func() {
		time.Sleep(4 * time.Second)
		if cmd.ProcessState == nil {
			p.closeStdin()
			syscall.Kill(-pid, syscall.SIGTERM)
		}
		time.Sleep(3 * time.Second)
		if cmd.ProcessState == nil {
			syscall.Kill(-pid, syscall.SIGKILL)
		}
	}()
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func clipText(s string, max int) string {
	if len(s) <= max {
		return s
	}
	head := max * 3 / 4
	tailN := max - head
	for head > 0 && s[head]&0xC0 == 0x80 {
		head--
	}
	start := len(s) - tailN
	for start < len(s) && s[start]&0xC0 == 0x80 {
		start++
	}
	return s[:head] + fmt.Sprintf("\n… (%d bytes omitted) …\n", len(s)-head-(len(s)-start)) + s[start:]
}

// ====================================================================
// Claude Code
// ====================================================================

// findClaudeSession looks for <store>/projects/*/<id>.jsonl in every known store.
func (r *Runner) findClaudeSession(id string) (file, store string) {
	var newest time.Time
	for _, st := range r.claudeStores() {
		matches, _ := filepath.Glob(filepath.Join(st, "projects", "*", id+".jsonl"))
		for _, m := range matches {
			if fi, err := os.Stat(m); err == nil && (file == "" || fi.ModTime().After(newest)) {
				file, store, newest = m, st, fi.ModTime()
			}
		}
	}
	return
}

// claudeCwd reads the working directory a session was started in.
func claudeCwd(file string) string {
	f, err := os.Open(file)
	if err != nil {
		return ""
	}
	defer f.Close()
	rd := bufio.NewReaderSize(f, 1<<16)
	for i := 0; i < 400; i++ {
		line, err := rd.ReadBytes('\n')
		if len(line) > 2 {
			var m struct {
				Cwd string `json:"cwd"`
			}
			if json.Unmarshal(line, &m) == nil && m.Cwd != "" {
				return m.Cwd
			}
		}
		if err != nil {
			break
		}
	}
	return ""
}

// usableClaudeStore: a session file can sit in a config directory the CLI is
// not signed in to (Claude Desktop's remote sessions use ~/.claude while the
// terminal uses another directory). In that case the transcript is copied into
// the signed-in directory and resumed there.
func (r *Runner) usableClaudeStore(file, store string) string {
	if runtime.GOOS != "linux" || claudeSignedIn(store) {
		return store
	}
	for _, other := range r.claudeStores() {
		if other == store || !claudeSignedIn(other) {
			continue
		}
		dst := filepath.Join(other, "projects", filepath.Base(filepath.Dir(file)), filepath.Base(file))
		src, err := os.ReadFile(file)
		if err != nil {
			return store
		}
		if cur, err := os.Stat(dst); err == nil {
			if fi, _ := os.Stat(file); fi != nil && !fi.ModTime().After(cur.ModTime()) {
				return other // the copy there is already the newer one
			}
		}
		if os.MkdirAll(filepath.Dir(dst), 0o700) != nil || os.WriteFile(dst, src, 0o600) != nil {
			return store
		}
		return other
	}
	return store
}

// claudeSignedIn: does this config directory hold a sign-in the CLI can still
// use? The file alone says little: after a sign-in lapses the CLI leaves it
// behind with the tokens blanked or long expired, and every run from that
// directory then fails with "OAuth session expired".
func claudeSignedIn(store string) bool {
	b, err := os.ReadFile(filepath.Join(store, ".credentials.json"))
	if err != nil {
		return false
	}
	var c struct {
		OAuth *struct {
			AccessToken           string `json:"accessToken"`
			RefreshToken          string `json:"refreshToken"`
			ExpiresAt             int64  `json:"expiresAt"`
			RefreshTokenExpiresAt int64  `json:"refreshTokenExpiresAt"`
		} `json:"claudeAiOauth"`
	}
	if json.Unmarshal(b, &c) != nil {
		return true // not a layout we know: leave the decision to the CLI
	}
	if c.OAuth == nil {
		return false
	}
	now := time.Now().UnixMilli()
	if c.OAuth.RefreshToken != "" && (c.OAuth.RefreshTokenExpiresAt == 0 || c.OAuth.RefreshTokenExpiresAt > now) {
		return true
	}
	return c.OAuth.AccessToken != "" && c.OAuth.ExpiresAt > now
}

func (p *proc) runClaude() error {
	r, job := p.r, p.job
	bin, err := exec.LookPath("claude")
	if err != nil {
		return bi("这台机器上找不到 claude 命令", "The claude command was not found on this machine")
	}
	env := os.Environ()
	cwd := job.Cwd
	resume := !job.IsNew
	cutAt := ""         // with a fork or a rewind: keep what was said up to and including this assistant message
	var rewound *rewind // a rewind: the stretch of the transcript the session stops following
	if resume {
		if job.NativeID == "" {
			return bi("缺少会话 ID", "Missing session ID")
		}
		file, store := r.findClaudeSession(job.NativeID)
		if file == "" {
			return bi("在这台机器上找不到这个会话的记录文件（可能已被清理，或者它是在别的机器上产生的）", "This session's transcript is not on this machine (it may have been cleaned up, or it was made on another machine)")
		}
		if c := claudeCwd(file); c != "" {
			cwd = c
		}
		if (job.Fork || job.Rewind) && (job.ForkBeforeTS != "" || job.ForkBeforeText != "") {
			at, from, found := claudeCut(file, job.ForkBeforeTS, job.ForkBeforeText)
			if !found {
				return bi("在这台机器的记录里找不到要改写的那条消息（它可能还没写入，或者会话被压缩过）", "That message was not found in this machine's transcript (it may not be written yet, or the session was compacted)")
			}
			if at == "" && job.Rewind {
				return bi("会话的第一条消息没法在原会话里改写，请新建一个会话", "The first message of a session cannot be rewritten in place. Start a new session instead")
			}
			if at == "" {
				resume = false // nothing before it: this is simply a new session in the same folder
			}
			cutAt = at
			if job.Rewind {
				rewound = &rewind{From: from.UnixMilli(), To: time.Now().UnixMilli()}
			}
		} else if job.Rewind {
			return bi("缺少要改写的那条消息", "The message to rewrite is missing")
		}
		store = r.usableClaudeStore(file, store)
		if store == filepath.Join(r.home, ".claude") {
			env = setEnv(env, "CLAUDE_CONFIG_DIR", "")
		} else {
			env = setEnv(env, "CLAUDE_CONFIG_DIR", store)
		}
	}
	if cwd == "" || !isDir(cwd) {
		return bif("工作目录不存在：%s", "The working directory does not exist: %s", cwd)
	}
	args := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio"}
	if resume {
		args = append(args, "--resume", job.NativeID)
		if job.Fork {
			args = append(args, "--fork-session")
		}
		if cutAt != "" {
			args = append(args, "--resume-session-at", cutAt)
		}
	}
	switch job.Mode {
	case "ask":
		args = append(args, "--permission-mode", "default")
	case "plan":
		args = append(args, "--permission-mode", "plan")
	case "edits":
		args = append(args, "--permission-mode", "acceptEdits")
	case "full":
		args = append(args, "--permission-mode", "bypassPermissions")
	}
	if job.Model != "" {
		args = append(args, "--model", job.Model)
	}
	if job.Effort != "" {
		args = append(args, "--effort", job.Effort)
	}

	gotResult := false
	resultErr := ""
	sent := false
	send := func() {
		if sent {
			return
		}
		sent = true
		p.write(map[string]any{"type": "control_request", "request_id": "init_" + job.ID, "request": map[string]any{"subtype": "initialize", "hooks": nil}})
		p.write(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": job.Prompt}, "parent_tool_use_id": nil})
	}

	onLine := func(m map[string]any) {
		switch str(m, "type") {
		case "control_response":
			// The answer to "initialize" lists this install's slash commands and models.
			resp, _ := m["response"].(map[string]any)
			if resp != nil && str(resp, "request_id") == "init_"+job.ID {
				if inner, _ := resp["response"].(map[string]any); inner != nil {
					r.reportCaps("claude", claudeCaps(inner))
				}
			}
		case "control_request":
			req, _ := m["request"].(map[string]any)
			id := str(m, "request_id")
			if req != nil && str(req, "subtype") == "can_use_tool" {
				in, _ := json.Marshal(req["input"])
				sug, _ := json.Marshal(req["permission_suggestions"])
				p.mu.Lock()
				p.pending[id] = pendingPerm{Input: in, Suggestions: sug}
				p.mu.Unlock()
				r.emit(job.ID, "permission", map[string]any{
					"request_id": id, "tool_name": str(req, "tool_name"), "input": req["input"],
					"description": str(req, "description"), "suggestions": req["permission_suggestions"],
					"blocked_path": str(req, "blocked_path"),
				})
			} else {
				// A request this runner does not implement: answer so the CLI does not wait forever.
				p.write(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "error", "request_id": id, "error": "not supported by this client"}})
			}
		case "control_cancel_request":
			id := str(m, "request_id")
			p.mu.Lock()
			_, had := p.pending[id]
			delete(p.pending, id)
			p.mu.Unlock()
			if had {
				r.emit(job.ID, "permission_done", map[string]any{"request_id": id})
			}
		case "system":
			switch str(m, "subtype") {
			case "init":
				if rewound != nil {
					r.emit(job.ID, "rewind", rewound) // from here on the session follows the new branch
					rewound = nil
				}
				r.emit(job.ID, "status", map[string]any{"state": "running", "session_id": str(m, "session_id")})
				r.emit(job.ID, "agent", map[string]any{
					"type": "system", "subtype": "init", "session_id": str(m, "session_id"), "model": m["model"],
					"cwd": m["cwd"], "permissionMode": m["permissionMode"], "version": m["claude_code_version"],
				})
			case "compact_boundary":
				r.emit(job.ID, "agent", map[string]any{"type": "system", "subtype": "compact_boundary"})
			}
		case "assistant", "user":
			if m["parent_tool_use_id"] != nil {
				return // inside a sub-agent; the main thread shows its result
			}
			if s := slimClaude(m); s != nil {
				r.emit(job.ID, "agent", s)
			}
		case "result":
			gotResult = true
			isErr, _ := m["is_error"].(bool)
			res := clipText(str(m, "result"), 4000)
			if isErr {
				resultErr = res
				if resultErr == "" {
					resultErr = "run failed (" + str(m, "subtype") + ")"
				}
			}
			r.emit(job.ID, "agent", map[string]any{
				"type": "result", "subtype": m["subtype"], "is_error": isErr, "result": res,
				"duration_ms": m["duration_ms"], "total_cost_usd": m["total_cost_usd"], "num_turns": m["num_turns"],
				"session_id": m["session_id"],
			})
			p.closeStdin() // one turn per process
		}
	}

	// The CLI prints nothing until it gets input, so write right after start.
	go func() {
		for i := 0; i < 200; i++ {
			p.mu.Lock()
			ready := p.stdin != nil
			p.mu.Unlock()
			if ready {
				send()
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
	}()

	stderrText, waitErr, startErr := p.launch(bin, args, cwd, env, true, onLine)
	if startErr != nil {
		return bif("启动 claude 失败：%v", "Could not start claude: %v", startErr)
	}
	if resultErr != "" {
		if strings.Contains(resultErr, "/login") {
			return bi("这台机器上的 Claude 命令行还没有登录。请在那台机器的终端里运行 claude 并完成 /login，然后再试。", "The Claude CLI on this machine is not signed in. Run claude in a terminal there, complete /login, then try again.")
		}
		return errors.New(resultErr)
	}
	if !gotResult {
		if stderrText != "" {
			return bif("claude 意外退出：%s", "claude exited unexpectedly: %s", clipText(stderrText, 1500))
		}
		if waitErr != nil {
			return bif("claude 意外退出：%v", "claude exited unexpectedly: %v", waitErr)
		}
		return bi("claude 没有返回结果就退出了", "claude exited without a result")
	}
	return nil
}

func (p *proc) answer(reqID, behavior, message string, always bool, input json.RawMessage) {
	p.mu.Lock()
	pend, ok := p.pending[reqID]
	delete(p.pending, reqID)
	p.mu.Unlock()
	if !ok {
		return
	}
	var resp map[string]any
	if behavior == "allow" {
		in := pend.Input
		if len(input) > 0 && string(input) != "null" {
			in = input
		}
		resp = map[string]any{"behavior": "allow", "updatedInput": in}
		if always && len(pend.Suggestions) > 0 && string(pend.Suggestions) != "null" {
			resp["updatedPermissions"] = pend.Suggestions
		}
	} else {
		if message == "" {
			message = "The user denied this action."
		}
		resp = map[string]any{"behavior": "deny", "message": message}
	}
	p.write(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": reqID, "response": resp}})
	p.r.emit(p.job.ID, "permission_done", map[string]any{"request_id": reqID})
}

// rewind is the stretch of a transcript a session stopped following when one
// of its messages was rewritten: everything from that message (From) up to the
// moment of the rewrite (To), both in milliseconds on this machine's clock,
// which is the clock the transcript's own timestamps come from.
type rewind struct {
	From int64 `json:"from"`
	To   int64 `json:"to"`
}

// claudeCut finds where a fork or a rewind should end: just before the user
// message sent at beforeTS (or, failing that, the last one with that text). It
// returns the id of the assistant message that one answers to ("" when it is
// the first of the session) and the time it was sent. The page only knows
// messages by time and text, the CLI wants a transcript id, so the transcript
// on this machine is the translator.
//
// A transcript is a tree, not a list: after a rewind the entry written just
// above a message in the file can belong to a branch the session left behind.
// So the answer is found by walking up from the message through its parents.
func claudeCut(file, beforeTS, beforeText string) (assistantID string, sent time.Time, found bool) {
	f, err := os.Open(file)
	if err != nil {
		return "", time.Time{}, false
	}
	defer f.Close()
	type entry struct {
		Type        string `json:"type"`
		UUID        string `json:"uuid"`
		Parent      string `json:"parentUuid"`
		Timestamp   string `json:"timestamp"`
		IsSidechain bool   `json:"isSidechain"`
		IsMeta      bool   `json:"isMeta"`
		Message     struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	type node struct {
		parent    string
		assistant bool
	}
	nodes := map[string]node{}
	want, wantOK := time.Time{}, false
	if t, err := time.Parse(time.RFC3339Nano, beforeTS); err == nil {
		want, wantOK = t, true
	}
	wantText := squash(beforeText)
	lastAssistant := ""
	// The message, and the last assistant entry above it in the file: the answer
	// when the chain of parents is broken (a compacted session).
	type hit struct {
		uuid, above string
		at          time.Time
	}
	var exact, byText *hit
	rd := bufio.NewReaderSize(f, 1<<16)
	for {
		line, err := rd.ReadBytes('\n')
		if len(line) > 2 {
			var e entry
			if json.Unmarshal(line, &e) == nil && e.UUID != "" {
				nodes[e.UUID] = node{parent: e.Parent, assistant: e.Type == "assistant" && !e.IsSidechain}
				if !e.IsSidechain && exact == nil {
					switch e.Type {
					case "assistant":
						lastAssistant = e.UUID
					case "user":
						text, isPrompt := promptText(e.Message.Content)
						if !isPrompt || e.IsMeta {
							break
						}
						t, terr := time.Parse(time.RFC3339Nano, e.Timestamp)
						if wantOK && terr == nil && t.Sub(want).Abs() <= time.Millisecond {
							exact = &hit{e.UUID, lastAssistant, t}
							break
						}
						if got := squash(text); wantText != "" && (got == wantText ||
							(len(wantText) >= 40 && strings.HasPrefix(got, wantText)) || (len(got) >= 40 && strings.HasPrefix(wantText, got))) {
							byText = &hit{e.UUID, lastAssistant, t} // keep going: the last match wins
						}
					}
				}
			}
		}
		if err != nil {
			break
		}
	}
	h := exact
	if h == nil {
		h = byText
	}
	if h == nil {
		return "", time.Time{}, false
	}
	at := ""
	for id, steps := nodes[h.uuid].parent, 0; id != "" && steps < len(nodes); steps++ {
		n, ok := nodes[id]
		if !ok {
			break // the parent is not in this file
		}
		if n.assistant {
			at = id
			break
		}
		id = n.parent
	}
	if at == "" {
		at = h.above // no parents recorded, or the chain stops at a compaction
	}
	return at, h.at, true
}

// promptText returns the text of a user entry, and false for entries that are
// tool results rather than something the person typed.
func promptText(content json.RawMessage) (string, bool) {
	var s string
	if json.Unmarshal(content, &s) == nil {
		return s, true
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(content, &parts) != nil {
		return "", false
	}
	var sb strings.Builder
	for _, p := range parts {
		switch p.Type {
		case "tool_result":
			return "", false
		case "text":
			sb.WriteString(p.Text)
		}
	}
	return sb.String(), sb.Len() > 0
}

func squash(s string) string { return strings.Join(strings.Fields(s), " ") }

// claudeCaps keeps the parts of the CLI's "initialize" answer the page uses:
// slash commands (for the "/" menu) and models (for the model picker).
func claudeCaps(resp map[string]any) map[string]any {
	out := map[string]any{}
	if list, _ := resp["commands"].([]any); len(list) > 0 {
		cmds := make([]any, 0, len(list))
		for _, x := range list {
			c, _ := x.(map[string]any)
			if c == nil || str(c, "name") == "" || strings.HasPrefix(str(c, "name"), "__") {
				continue
			}
			cmds = append(cmds, map[string]any{"name": str(c, "name"), "description": clipRunes(str(c, "description"), 140), "hint": clipRunes(str(c, "argumentHint"), 60)})
			if len(cmds) >= 300 {
				break
			}
		}
		out["commands"] = cmds
	}
	if list, _ := resp["models"].([]any); len(list) > 0 {
		models := make([]any, 0, len(list))
		for _, x := range list {
			c, _ := x.(map[string]any)
			if c == nil || str(c, "value") == "" {
				continue
			}
			efforts := []string{}
			if list, _ := c["supportedEffortLevels"].([]any); c["supportsEffort"] == true {
				for _, e := range list {
					if s, ok := e.(string); ok {
						efforts = append(efforts, s)
					}
				}
			}
			models = append(models, map[string]any{"value": str(c, "value"), "name": clipRunes(str(c, "displayName"), 60), "description": clipRunes(str(c, "description"), 120), "efforts": efforts})
		}
		out["models"] = models
	}
	return out
}

func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// reportCaps tells the hub what an agent on this machine offers, once per change.
func (r *Runner) reportCaps(agent string, caps map[string]any) {
	if len(caps) == 0 {
		return
	}
	caps["agent"] = agent
	b, err := json.Marshal(caps)
	if err != nil {
		return
	}
	r.mu.Lock()
	same := r.caps[agent] == string(b)
	r.caps[agent] = string(b)
	r.mu.Unlock()
	if !same {
		r.emit("", "caps", caps)
	}
}

// slimClaude keeps what the page renders and drops bulky extras
// (thinking signatures, token accounting, image data, duplicate tool results).
func slimClaude(m map[string]any) map[string]any {
	msg, _ := m["message"].(map[string]any)
	if msg == nil {
		return nil
	}
	out := map[string]any{"type": m["type"]}
	sm := map[string]any{"role": msg["role"]}
	if id, ok := msg["id"]; ok {
		sm["id"] = id
	}
	if model, ok := msg["model"]; ok {
		sm["model"] = model
	}
	switch c := msg["content"].(type) {
	case string:
		sm["content"] = clipText(c, 24000)
	case []any:
		blocks := make([]any, 0, len(c))
		for _, b := range c {
			bm, _ := b.(map[string]any)
			if bm == nil {
				continue
			}
			switch str(bm, "type") {
			case "thinking":
				blocks = append(blocks, map[string]any{"type": "thinking", "thinking": clipText(str(bm, "thinking"), 12000)})
			case "redacted_thinking":
			case "text":
				blocks = append(blocks, map[string]any{"type": "text", "text": str(bm, "text")})
			case "tool_use":
				blocks = append(blocks, map[string]any{"type": "tool_use", "id": bm["id"], "name": bm["name"], "input": bm["input"]})
			case "tool_result":
				tr := map[string]any{"type": "tool_result", "tool_use_id": bm["tool_use_id"]}
				if e, ok := bm["is_error"].(bool); ok && e {
					tr["is_error"] = true
				}
				switch rc := bm["content"].(type) {
				case string:
					tr["content"] = clipText(rc, 24000)
				case []any:
					var sb strings.Builder
					for _, part := range rc {
						pm, _ := part.(map[string]any)
						if pm == nil {
							continue
						}
						if str(pm, "type") == "text" {
							sb.WriteString(str(pm, "text"))
						} else if str(pm, "type") == "image" {
							sb.WriteString("[image]")
						}
					}
					tr["content"] = clipText(sb.String(), 24000)
				}
				blocks = append(blocks, tr)
			case "image":
				blocks = append(blocks, map[string]any{"type": "text", "text": "[image]"})
			}
		}
		if len(blocks) == 0 {
			return nil
		}
		sm["content"] = blocks
	default:
		return nil
	}
	out["message"] = sm
	return out
}

// ====================================================================
// Codex
// ====================================================================

// findCodexSession looks for a rollout file whose name carries the session id.
func (r *Runner) findCodexSession(id string) (file, home string) {
	for _, h := range r.codexHomes() {
		for _, sub := range []string{"sessions", "archived_sessions"} {
			root := filepath.Join(h, sub)
			filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
				if err != nil {
					return nil
				}
				if !d.IsDir() && strings.Contains(d.Name(), id) {
					file, home = path, h
					return fs.SkipAll
				}
				return nil
			})
			if file != "" {
				return
			}
		}
	}
	return
}

// usableCodexHome: like usableClaudeStore. A rollout can sit in a Codex home
// that is not signed in (sessions created by a remote desktop client) while
// the terminal's home is. The rollout is copied there and resumed from it.
func (r *Runner) usableCodexHome(file, home string) string {
	if exists(filepath.Join(home, "auth.json")) {
		return home
	}
	for _, other := range r.codexHomes() {
		if other == home || !exists(filepath.Join(other, "auth.json")) {
			continue
		}
		rel, err := filepath.Rel(home, file)
		if err != nil {
			return home
		}
		dst := filepath.Join(other, rel)
		if cur, err := os.Stat(dst); err == nil {
			if fi, _ := os.Stat(file); fi != nil && !fi.ModTime().After(cur.ModTime()) {
				return other
			}
		}
		src, err := os.ReadFile(file)
		if err != nil || os.MkdirAll(filepath.Dir(dst), 0o700) != nil || os.WriteFile(dst, src, 0o600) != nil {
			return home
		}
		return other
	}
	return home
}

func (p *proc) runCodex() error {
	r, job := p.r, p.job
	bin, err := exec.LookPath("codex")
	if err != nil {
		return bi("这台机器上找不到 codex 命令", "The codex command was not found on this machine")
	}
	env := os.Environ()
	sandbox := map[string]string{"readonly": "read-only", "edits": "workspace-write", "full": "danger-full-access"}[job.Mode]
	var args []string
	if job.IsNew {
		args = []string{"exec", "--json", "--skip-git-repo-check", "-C", job.Cwd}
		if sandbox != "" {
			args = append(args, "-s", sandbox)
		}
	} else {
		if job.NativeID == "" {
			return bi("缺少会话 ID", "Missing session ID")
		}
		if job.Rewind || job.Fork && (job.ForkBeforeTS != "" || job.ForkBeforeText != "") {
			return bi("Codex 只能从会话末尾分叉，不能从中间某条消息改写", "Codex can only fork from the end of a session, not from a message in the middle")
		}
		file, home := r.findCodexSession(job.NativeID)
		if file == "" {
			return bi("在这台机器上找不到这个会话的记录文件（可能已被清理，或者它是在别的机器上产生的）", "This session's transcript is not on this machine (it may have been cleaned up, or it was made on another machine)")
		}
		home = r.usableCodexHome(file, home)
		if home == filepath.Join(r.home, ".codex") {
			env = setEnv(env, "CODEX_HOME", "")
		} else {
			env = setEnv(env, "CODEX_HOME", home)
		}
		args = []string{"exec", "resume", "--json", "--skip-git-repo-check"}
		if job.Fork {
			args[1] = "fork" // same arguments, new thread id; the original rollout is untouched
		}
		if sandbox != "" {
			args = append(args, "-c", fmt.Sprintf("sandbox_mode=%q", sandbox))
		}
	}
	if job.Model != "" {
		args = append(args, "-m", job.Model)
	}
	if job.Effort != "" {
		args = append(args, "-c", fmt.Sprintf("model_reasoning_effort=%q", job.Effort))
	}
	args = append(args, "--")
	if !job.IsNew {
		args = append(args, job.NativeID)
	}
	args = append(args, job.Prompt)
	if job.Cwd == "" || !isDir(job.Cwd) {
		return bif("工作目录不存在：%s", "The working directory does not exist: %s", job.Cwd)
	}

	turnErr := ""
	completed := false
	onLine := func(m map[string]any) {
		switch str(m, "type") {
		case "thread.started":
			r.emit(job.ID, "status", map[string]any{"state": "running", "session_id": str(m, "thread_id")})
		case "turn.completed":
			completed = true
		case "turn.failed":
			if e, _ := m["error"].(map[string]any); e != nil {
				turnErr = str(e, "message")
			}
		case "error":
			if turnErr == "" {
				turnErr = str(m, "message")
			}
		}
		if it, _ := m["item"].(map[string]any); it != nil {
			if s, ok := it["aggregated_output"].(string); ok {
				it["aggregated_output"] = clipText(s, 24000)
			}
		}
		r.emit(job.ID, "agent", m)
	}
	stderrText, waitErr, startErr := p.launch(bin, args, job.Cwd, env, false, onLine)
	if startErr != nil {
		return bif("启动 codex 失败：%v", "Could not start codex: %v", startErr)
	}
	if turnErr != "" {
		return errors.New(clipText(turnErr, 1500))
	}
	if !completed {
		if stderrText != "" {
			return bif("codex 意外退出：%s", "codex exited unexpectedly: %s", clipText(stderrText, 1500))
		}
		if waitErr != nil {
			return bif("codex 意外退出：%v", "codex exited unexpectedly: %v", waitErr)
		}
		return bi("codex 没有完成这一轮就退出了", "codex exited before finishing the turn")
	}
	return nil
}
