//go:build unix

// atrium-runner runs on every machine that has coding-agent sessions.
// It only makes outbound requests to the hub: it long-polls for commands
// (start a turn, answer a permission request, stop, list a directory) and
// posts the agent's output back as events.
//
// It can start exactly two programs, `claude` and `codex`, in their
// non-interactive modes. It has no general "run this command" ability unless
// the machine's own config sets "allow_shell": true, which turns on the page's
// Terminal and Files panels for this machine.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

var version = "0.1.2"

type Config struct {
	Hub   string `json:"hub"`   // e.g. http://127.0.0.1:13005 (through the SSH tunnel)
	Token string `json:"token"` // this machine's runner token
	// SyncCmd is run after every turn so the archive picks the new messages up quickly.
	SyncCmd string `json:"sync_cmd,omitempty"`
	// Extra places to look for session files, besides $CLAUDE_CONFIG_DIR / ~/.claude and $CODEX_HOME / ~/.codex.
	ClaudeDirs []string `json:"claude_dirs,omitempty"`
	CodexHomes []string `json:"codex_homes,omitempty"`
	// AllowShell turns on the page's Terminal panel (a login shell on this
	// machine) and its Files panel (browse, read and save files). Off unless
	// you turn it on here: without it the runner can only ever start `claude`
	// and `codex`, reads nothing but folder names for the new-session picker,
	// and writes nothing but the attachments of a message, into its own cache folder.
	AllowShell bool `json:"allow_shell,omitempty"`
	// RootSandbox lets "Allow everything" work when the runner is root. Claude
	// Code refuses to skip permission prompts as root unless it is told the
	// machine is a sandbox (IS_SANDBOX=1); with this on, the runner tells it so.
	// Only for a throwaway machine such as a container. Off by default.
	RootSandbox bool `json:"root_sandbox,omitempty"`
}

type Job struct {
	ID       string `json:"id"`
	Agent    string `json:"agent"`
	NativeID string `json:"native_id"`
	Cwd      string `json:"cwd"`
	Prompt   string `json:"prompt"`
	Mode     string `json:"mode"`
	Model    string `json:"model"`
	Effort   string `json:"effort"` // reasoning effort, in the agent\'s own words ("high", "xhigh"…); empty = its default
	IsNew    bool   `json:"is_new"`
	// Fork continues a copy of session NativeID instead of the session itself,
	// so the original transcript is left alone. With ForkBefore*, the copy ends
	// just before that user message (edit a message, try an answer again).
	Fork           bool   `json:"fork"`
	ForkBeforeTS   string `json:"fork_before_ts"`
	ForkBeforeText string `json:"fork_before_text"`
	// Rewind continues session NativeID itself from just before that user
	// message (ForkBefore*): what was said from there on stays in the transcript
	// as a branch the session no longer follows, the way the CLI's own rewind does.
	Rewind bool `json:"rewind"`
	// Files are the attachments the prompt names (see upload.go).
	Files []string `json:"files"`
}

type outEvent struct {
	RunID string `json:"run_id"`
	T     string `json:"t"`
	TS    int64  `json:"ts"`
	Data  any    `json:"data,omitempty"`
}

type Runner struct {
	cfg  Config
	hc   *http.Client
	home string
	boot string

	mu    sync.Mutex
	procs map[string]*proc
	terms map[string]*term
	caps  map[string]string // agent -> last capability report sent to the hub

	out  chan outEvent
	fast chan outEvent // terminal output: its own lane, so typing never waits behind a run's events

	syncMu      sync.Mutex
	syncRunning bool
	syncAgain   bool
}

func main() {
	def := ""
	if h, err := os.UserHomeDir(); err == nil {
		def = filepath.Join(h, ".config", "atrium", "runner.json")
	}
	cfgPath := flag.String("config", def, "runner config file")
	showVersion := flag.Bool("version", false, "print version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	b, err := os.ReadFile(*cfgPath)
	if err != nil && *cfgPath == def {
		// Installs made before the project was renamed keep their config here.
		if h, e := os.UserHomeDir(); e == nil {
			if old, e2 := os.ReadFile(filepath.Join(h, ".config", "sessionhub", "runner.json")); e2 == nil {
				b, err = old, nil
			}
		}
	}
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	var cfg Config
	if err := json.Unmarshal(b, &cfg); err != nil {
		log.Fatalf("config: %v", err)
	}
	cfg.Hub = strings.TrimRight(cfg.Hub, "/")
	if cfg.Hub == "" || cfg.Token == "" {
		log.Fatal("config needs hub and token")
	}
	home, _ := os.UserHomeDir()
	bb := make([]byte, 8)
	rand.Read(bb)
	r := &Runner{
		cfg: cfg, home: home, boot: hex.EncodeToString(bb),
		hc:    &http.Client{Timeout: 60 * time.Second},
		procs: map[string]*proc{}, terms: map[string]*term{}, caps: map[string]string{},
		out:  make(chan outEvent, 8192),
		fast: make(chan outEvent, 1024),
	}
	log.Printf("atrium-runner %s, hub %s", version, cfg.Hub)
	go r.flusher(r.out, 120*time.Millisecond)
	go r.flusher(r.fast, 5*time.Millisecond)
	r.loop()
}

// ---------- hub transport ----------

func (r *Runner) request(method, path string, body any, out any, timeout time.Duration) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, r.cfg.Hub+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+r.cfg.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	hc := *r.hc
	hc.Timeout = timeout
	res, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 300))
		return fmt.Errorf("hub: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(b)))
	}
	if out != nil {
		return json.NewDecoder(res.Body).Decode(out)
	}
	io.Copy(io.Discard, res.Body)
	return nil
}

func (r *Runner) loop() {
	needHello := true
	lastHello := time.Time{}
	lastProbe := time.Time{}
	fail := 0
	for {
		if needHello || time.Since(lastHello) > 10*time.Minute {
			if err := r.hello(); err != nil {
				fail++
				if fail == 1 || fail%20 == 0 {
					log.Printf("cannot reach hub: %v", err)
				}
				time.Sleep(backoff(fail))
				continue
			}
			if fail > 0 || lastHello.IsZero() {
				log.Printf("connected to hub")
			}
			needHello, lastHello, fail = false, time.Now(), 0
			go r.reportLimits("codex", codexLimits(r.codexHomes()))
			if time.Since(lastProbe) > 6*time.Hour {
				lastProbe = time.Now()
				go r.probeCaps()
			}
		}
		var res struct {
			Commands []json.RawMessage `json:"commands"`
		}
		if err := r.request("GET", "/api/runner/poll?wait=25", nil, &res, 45*time.Second); err != nil {
			fail++
			needHello = true
			time.Sleep(backoff(fail))
			continue
		}
		for _, raw := range res.Commands {
			// Keystrokes must reach the terminal in the order they were typed.
			if bytes.Contains(raw, []byte(`"type":"term_`)) {
				r.handle(raw)
			} else {
				go r.handle(raw)
			}
		}
	}
}

func backoff(n int) time.Duration {
	d := time.Duration(n) * 2 * time.Second
	if d > 15*time.Second {
		d = 15 * time.Second
	}
	return d
}

func (r *Runner) emit(runID, t string, data any) {
	r.out <- outEvent{RunID: runID, T: t, TS: time.Now().UnixMilli(), Data: data}
}

func (r *Runner) emitFast(id, t string, data any) {
	r.fast <- outEvent{RunID: id, T: t, TS: time.Now().UnixMilli(), Data: data}
}

// flusher sends events in order, in small batches, retrying until the hub takes them.
func (r *Runner) flusher(ch chan outEvent, gather time.Duration) {
	for {
		batch := []outEvent{<-ch}
		timer := time.NewTimer(gather)
	collect:
		for len(batch) < 100 {
			select {
			case e := <-ch:
				batch = append(batch, e)
			case <-timer.C:
				break collect
			}
		}
		timer.Stop()
		for attempt := 1; ; attempt++ {
			err := r.request("POST", "/api/runner/events", map[string]any{"events": batch}, nil, 30*time.Second)
			if err == nil {
				break
			}
			if attempt == 1 {
				log.Printf("posting events failed, retrying: %v", err)
			}
			time.Sleep(backoff(attempt))
		}
	}
}

func (r *Runner) reply(id string, data any, err error) {
	rep := map[string]any{"id": id, "ok": err == nil, "data": data}
	if err != nil {
		rep["error_zh"], rep["error"] = both(err)
	}
	if e := r.request("POST", "/api/runner/reply", rep, nil, 20*time.Second); e != nil {
		log.Printf("reply failed: %v", e)
	}
}

// ---------- hello ----------

func agentInfo(name string) map[string]any {
	p, err := exec.LookPath(name)
	if err != nil {
		return map[string]any{}
	}
	info := map[string]any{"path": p}
	cmd := exec.Command(p, "--version")
	done := make(chan []byte, 1)
	go func() {
		b, _ := cmd.Output()
		done <- b
	}()
	select {
	case b := <-done:
		info["version"] = strings.TrimSpace(strings.SplitN(string(b), "\n", 2)[0])
	case <-time.After(15 * time.Second):
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
	}
	return info
}

func (r *Runner) hello() error {
	host, _ := os.Hostname()
	uname := ""
	if u, err := user.Current(); err == nil {
		uname = u.Username
	}
	r.mu.Lock()
	active := make([]string, 0, len(r.procs))
	for id := range r.procs {
		active = append(active, id)
	}
	terms := make([]string, 0, len(r.terms))
	for id := range r.terms {
		terms = append(terms, id)
	}
	r.mu.Unlock()
	body := map[string]any{
		"boot": r.boot, "version": version, "os": runtime.GOOS, "arch": runtime.GOARCH,
		"hostname": host, "home": r.home, "user": uname, "active": active,
		"agents": map[string]any{"claude": agentInfo("claude"), "codex": agentInfo("codex")},
		"stores": map[string]any{"claude": r.claudeStores(), "codex": r.codexHomes()},
		"shell":  r.cfg.AllowShell,
		"terms":  terms,
		// What this runner understands, so the page only offers what will work.
		"features": []string{"fork", "caps", "term", "files", "effort", "rewind", "limits", "upload"},
	}
	if err := r.request("POST", "/api/runner/hello", body, nil, 30*time.Second); err != nil {
		return err
	}
	r.mu.Lock()
	r.caps = map[string]string{} // a restarted hub has forgotten them: report again
	r.mu.Unlock()
	return nil
}

// ---------- commands ----------

func (r *Runner) handle(raw json.RawMessage) {
	var c struct {
		ID        string          `json:"id"`
		Type      string          `json:"type"`
		Run       Job             `json:"run"`
		RunID     string          `json:"run_id"`
		RequestID string          `json:"request_id"`
		Behavior  string          `json:"behavior"`
		Message   string          `json:"message"`
		Always    bool            `json:"always"`
		Input     json.RawMessage `json:"input"`
		Path      string          `json:"path"`
		TermID    string          `json:"term_id"`
		Cwd       string          `json:"cwd"`
		Cols      int             `json:"cols"`
		Rows      int             `json:"rows"`
		Data      string          `json:"data"`
		Content   string          `json:"content"`
		Mtime     int64           `json:"mtime"`
		Blob      string          `json:"blob"`
		Name      string          `json:"name"`
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return
	}
	switch c.Type {
	case "start":
		r.start(c.Run)
	case "permission":
		if p := r.proc(c.RunID); p != nil {
			p.answer(c.RequestID, c.Behavior, c.Message, c.Always, c.Input)
		}
	case "stop":
		if p := r.proc(c.RunID); p != nil {
			p.stop()
		} else {
			// Nothing to stop here (never started, or already gone): close it on the hub.
			r.emit(c.RunID, "exit", map[string]any{"stopped": true})
		}
	case "ls":
		data, err := r.ls(c.Path)
		r.reply(c.ID, data, err)
	case "caps":
		r.probeCaps()
		r.reply(c.ID, map[string]any{"ok": true}, nil)
	case "term_open":
		r.termOpen(c.TermID, c.Cwd, c.Cols, c.Rows)
	case "term_in":
		r.termInput(c.TermID, c.Data)
	case "term_resize":
		r.termResize(c.TermID, c.Cols, c.Rows)
	case "term_close":
		r.termClose(c.TermID)
	case "upload":
		data, err := r.upload(c.Blob, c.Name)
		r.reply(c.ID, data, err)
	case "fs_list":
		data, err := r.fsList(c.Path)
		r.reply(c.ID, data, err)
	case "fs_read":
		data, err := r.fsRead(c.Path)
		r.reply(c.ID, data, err)
	case "fs_write":
		data, err := r.fsWrite(c.Path, c.Content, c.Mtime)
		r.reply(c.ID, data, err)
	}
}

func (r *Runner) proc(id string) *proc {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.procs[id]
}

// continues tells whether the job carries on an existing session in place (not a new one, not a copy).
func (j Job) continues() bool { return !j.IsNew && !j.Fork && j.NativeID != "" }

func (r *Runner) start(job Job) {
	r.mu.Lock()
	if _, dup := r.procs[job.ID]; dup {
		r.mu.Unlock()
		return
	}
	// Two agents continuing one session at once would write over each other and
	// do the work twice. The hub does not ask for that; this is the last line of
	// defence for when it has lost track of a run that is still going on here.
	if job.continues() {
		for _, x := range r.procs {
			if x.job.continues() && x.job.Agent == job.Agent && x.job.NativeID == job.NativeID {
				r.mu.Unlock()
				zh, en := both(bi("这个会话在这台机器上还在运行，等它结束或先停止它", "This session is still running on this machine. Wait for it to finish or stop it first"))
				r.emit(job.ID, "exit", map[string]any{"stopped": false, "error_zh": zh, "error": en})
				return
			}
		}
	}
	p := &proc{r: r, job: job, pending: map[string]pendingPerm{}}
	r.procs[job.ID] = p
	r.mu.Unlock()

	var err error
	switch job.Agent {
	case "claude":
		err = p.runClaude()
	case "codex":
		err = p.runCodex()
		r.reportLimits("codex", codexLimits(r.codexHomes())) // the turn just wrote a new reading
	default:
		err = bif("不支持的助手：%s", "Unsupported agent: %s", job.Agent)
	}

	r.mu.Lock()
	delete(r.procs, job.ID)
	r.mu.Unlock()

	exit := map[string]any{"stopped": p.isStopped()}
	if err != nil && !p.isStopped() {
		exit["error_zh"], exit["error"] = both(err)
	}
	r.emit(job.ID, "exit", exit)
	r.sync()
}

// sync pushes fresh transcripts to the archive right after a turn.
func (r *Runner) sync() {
	if r.cfg.SyncCmd == "" {
		return
	}
	r.syncMu.Lock()
	if r.syncRunning {
		r.syncAgain = true
		r.syncMu.Unlock()
		return
	}
	r.syncRunning = true
	r.syncMu.Unlock()
	go func() {
		for {
			cmd := exec.Command("/bin/sh", "-c", r.cfg.SyncCmd)
			done := make(chan struct{})
			go func() { cmd.Run(); close(done) }()
			select {
			case <-done:
			case <-time.After(3 * time.Minute):
				if cmd.Process != nil {
					cmd.Process.Kill()
				}
			}
			r.syncMu.Lock()
			if !r.syncAgain {
				r.syncRunning = false
				r.syncMu.Unlock()
				return
			}
			r.syncAgain = false
			r.syncMu.Unlock()
		}
	}()
}

// ---------- directory listing (for the "new session" folder picker) ----------

func (r *Runner) ls(path string) (any, error) {
	if path == "" || path == "~" {
		path = r.home
	}
	if strings.HasPrefix(path, "~/") {
		path = filepath.Join(r.home, path[2:])
	}
	path = filepath.Clean(path)
	if !filepath.IsAbs(path) {
		return nil, bi("需要绝对路径", "An absolute path is required")
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		// Fall back to the closest existing parent so the picker stays usable.
		for p := filepath.Dir(path); ; p = filepath.Dir(p) {
			if es, e2 := os.ReadDir(p); e2 == nil {
				path, entries, err = p, es, nil
				break
			}
			if p == "/" || p == "." {
				break
			}
		}
		if err != nil {
			return nil, bif("读不了这个目录：%v", "Cannot read this folder: %v", err)
		}
	}
	names := []map[string]string{}
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, ".") {
			continue
		}
		isDir := e.IsDir()
		if !isDir && e.Type()&os.ModeSymlink != 0 {
			if fi, err := os.Stat(filepath.Join(path, n)); err == nil && fi.IsDir() {
				isDir = true
			}
		}
		if isDir {
			names = append(names, map[string]string{"name": n})
		}
		if len(names) >= 500 {
			break
		}
	}
	sort.Slice(names, func(i, j int) bool { return strings.ToLower(names[i]["name"]) < strings.ToLower(names[j]["name"]) })
	return map[string]any{"path": path, "parent": filepath.Dir(path), "home": r.home, "entries": names}, nil
}

// ---------- where sessions live ----------

func uniq(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, p := range in {
		if p == "" {
			continue
		}
		p = filepath.Clean(p)
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

func (r *Runner) claudeStores() []string {
	return uniq(append([]string{os.Getenv("CLAUDE_CONFIG_DIR"), filepath.Join(r.home, ".claude")}, r.cfg.ClaudeDirs...))
}

func (r *Runner) codexHomes() []string {
	return uniq(append([]string{os.Getenv("CODEX_HOME"), filepath.Join(r.home, ".codex")}, r.cfg.CodexHomes...))
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// setEnv returns env with key set to val, or removed when val is empty.
func setEnv(env []string, key, val string) []string {
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if !strings.HasPrefix(kv, key+"=") {
			out = append(out, kv)
		}
	}
	if val != "" {
		out = append(out, key+"="+val)
	}
	return out
}
