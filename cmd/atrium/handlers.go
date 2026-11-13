package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"version": version, "machines": s.machineList(r.Context())})
}

// recentRuns are the runs the page may still need: anything live, anything
// that finished recently (its messages may not be in the archive yet), and
// sessions started here that the archive has not picked up.
func (s *Server) recentRuns() []Run {
	now := time.Now().UnixMilli()
	return s.runs.List(func(r *Run) bool {
		if !terminal(r.Status) {
			return true
		}
		if now-r.Ended < 24*3600*1000 {
			return true
		}
		return r.IsNew && now-r.Created < 7*24*3600*1000
	})
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	list, etag, err := s.arc.Sessions(r.Context(), r.URL.Query().Get("fresh") == "1")
	if err != nil {
		writeErr(w, http.StatusBadGateway, L(r, "存档服务暂时连不上：", "The archive is unreachable: ")+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"sessions": list, "etag": etag, "meta": s.meta.All(),
		"runs": s.recentRuns(), "machines": s.machineList(r.Context()),
	})
}

func intParam(r *http.Request, name string, def int) int {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	limit := intParam(r, "limit", 80)
	if limit < 1 || limit > 400 {
		limit = 80
	}
	var page MsgPage
	var err error
	if r.URL.Query().Has("after") {
		page, err = s.arc.After(r.Context(), id, intParam(r, "after", -1), limit)
	} else {
		page, err = s.arc.Latest(r.Context(), id, intParam(r, "before", -1), limit)
	}
	if err != nil {
		var ae *archiveError
		if errors.As(err, &ae) && ae.Status == 404 {
			writeJSON(w, 200, map[string]any{"messages": []Msg{}, "more": false, "missing": true})
			return
		}
		writeErr(w, http.StatusBadGateway, L(r, "读取会话内容失败：", "Could not read the session: ")+err.Error())
		return
	}
	if page.Messages == nil {
		page.Messages = []Msg{}
	}
	writeJSON(w, 200, page)
}

func (s *Server) handleTool(w http.ResponseWriter, r *http.Request) {
	t, err := s.arc.ToolFull(r.Context(), r.PathValue("id"), intParam(r, "ord", -1), intParam(r, "i", -1))
	if err != nil {
		writeErr(w, 404, err.Error())
		return
	}
	writeJSON(w, 200, t)
}

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Pinned *bool   `json:"pinned"`
		Title  *string `json:"title"`
		Hidden *bool   `json:"hidden"`
	}
	if err := readJSON(r, &body, 1<<16); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	id := r.PathValue("id")
	m := s.meta.Patch(id, func(m *Meta) {
		if body.Pinned != nil {
			m.Pinned = *body.Pinned
		}
		if body.Title != nil {
			m.Title = strings.TrimSpace(*body.Title)
		}
		if body.Hidden != nil {
			m.Hidden = *body.Hidden
		}
	})
	s.bus.Publish("meta", map[string]any{"id": id, "meta": m})
	writeJSON(w, 200, m)
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, 200, map[string]any{"hits": []SearchHit{}})
		return
	}
	hits, err := s.arc.Search(r.Context(), q, 40)
	if err != nil {
		writeErr(w, http.StatusBadGateway, L(r, "搜索失败：", "Search failed: ")+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"hits": hits})
}

// ---------- runs ----------

func (s *Server) handleRuns(w http.ResponseWriter, r *http.Request) {
	sid := r.URL.Query().Get("session")
	if sid == "" {
		writeJSON(w, 200, map[string]any{"runs": s.recentRuns()})
		return
	}
	writeJSON(w, 200, map[string]any{"runs": s.runs.List(func(x *Run) bool { return x.SessionID == sid })})
}

func (s *Server) handleRunEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	run, ok := s.runs.Get(id)
	if !ok {
		writeErr(w, 404, "run not found")
		return
	}
	ev, _ := s.runs.Events(id, intParam(r, "after", 0))
	writeJSON(w, 200, map[string]any{"run": run, "events": ev})
}

// A reasoning effort is one of the agent's own level names ("low", "xhigh"…): a short word, passed through as is.
var effortRe = regexp.MustCompile(`^[a-z]{0,16}$`)

var validForkKinds = map[string]bool{"branch": true, "edit": true, "retry": true, "side": true}

// sessionRef finds a session by archive id: in the archive, or, for one
// started here that the archive has not indexed yet, from its runs.
func (s *Server) sessionRef(r *http.Request, id string) (Session, bool) {
	if id == "" {
		return Session{}, false
	}
	if sess, ok := s.arc.Find(r.Context(), id); ok {
		return sess, true
	}
	prev := s.runs.List(func(x *Run) bool { return x.SessionID == id && x.NativeID != "" })
	if len(prev) == 0 {
		return Session{}, false
	}
	p := prev[len(prev)-1]
	return Session{ID: p.SessionID, NativeID: p.NativeID, Agent: p.Agent, Machine: p.Machine, Cwd: p.Cwd}, true
}

var validModes = map[string]bool{"": true, "machine": true, "ask": true, "plan": true, "edits": true, "full": true, "readonly": true}

func (s *Server) handleCreateRun(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID string `json:"session_id"`
		Machine   string `json:"machine"`
		Agent     string `json:"agent"`
		Cwd       string `json:"cwd"`
		Prompt    string `json:"prompt"`
		Mode      string `json:"mode"`
		Model     string `json:"model"`
		Effort    string `json:"effort"`
		// Fork: continue a copy of a session instead of the session itself.
		Fork *struct {
			SessionID  string `json:"session_id"`
			Kind       string `json:"kind"`
			BeforeTS   string `json:"before_ts"`
			BeforeText string `json:"before_text"`
			BeforeOrd  *int   `json:"before_ord"`
			Title      string `json:"title"`
		} `json:"fork"`
		// Rewind: continue session_id itself from just before one of its messages.
		Rewind *struct {
			BeforeTS   string `json:"before_ts"`
			BeforeText string `json:"before_text"`
		} `json:"rewind"`
	}
	if err := readJSON(r, &body, 4<<20); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if strings.TrimSpace(body.Prompt) == "" {
		writeErr(w, 400, L(r, "消息不能为空", "The message is empty"))
		return
	}
	if !effortRe.MatchString(body.Effort) {
		writeErr(w, 400, "bad effort")
		return
	}
	if !validModes[body.Mode] {
		writeErr(w, 400, L(r, "未知的权限模式", "Unknown permission mode"))
		return
	}
	run := Run{
		ID: "r" + randToken(9), Prompt: body.Prompt, Mode: body.Mode, Model: body.Model, Effort: body.Effort,
		Status: "queued", Created: time.Now().UnixMilli(),
	}
	var forkCmd, rewindCmd map[string]any
	if f := body.Fork; f != nil {
		if !validForkKinds[f.Kind] {
			writeErr(w, 400, "bad fork kind")
			return
		}
		parent, ok := s.sessionRef(r, f.SessionID)
		if !ok {
			writeErr(w, 404, L(r, "找不到这个会话", "Session not found"))
			return
		}
		cut := f.BeforeTS != "" || f.BeforeText != ""
		if cut && parent.Agent != "claude" {
			writeErr(w, 400, L(r, "这种会话只能从末尾分叉", "This kind of session can only be forked from its end"))
			return
		}
		run.IsNew, run.ForkOf, run.ForkKind, run.Title = true, parent.ID, f.Kind, clip(f.Title, 120)
		run.Agent, run.Machine, run.Cwd = parent.Agent, parent.Machine, parent.Cwd
		if cut {
			run.ForkOrd = f.BeforeOrd
		}
		forkCmd = map[string]any{"native_id": parent.NativeID, "is_new": false, "fork": true,
			"fork_before_ts": f.BeforeTS, "fork_before_text": clip(f.BeforeText, 400)}
	} else if body.SessionID != "" {
		if sess, ok := s.arc.Find(r.Context(), body.SessionID); ok {
			run.SessionID, run.NativeID, run.Agent, run.Machine, run.Cwd = sess.ID, sess.NativeID, sess.Agent, sess.Machine, sess.Cwd
		} else {
			// A session started here that the archive has not indexed yet.
			prev := s.runs.List(func(x *Run) bool { return x.SessionID == body.SessionID && x.NativeID != "" })
			if len(prev) == 0 {
				writeErr(w, 404, L(r, "找不到这个会话", "Session not found"))
				return
			}
			p := prev[len(prev)-1]
			run.SessionID, run.NativeID, run.Agent, run.Machine, run.Cwd = p.SessionID, p.NativeID, p.Agent, p.Machine, p.Cwd
		}
		busy := s.runs.List(func(x *Run) bool { return x.SessionID == run.SessionID && !terminal(x.Status) })
		if len(busy) > 0 {
			writeErr(w, http.StatusConflict, L(r, "这个会话正在运行中，请等它结束或先停止", "This session is running. Wait for it to finish or stop it first"))
			return
		}
		if rw := body.Rewind; rw != nil {
			if rw.BeforeTS == "" && rw.BeforeText == "" {
				writeErr(w, 400, "bad rewind")
				return
			}
			if run.Agent != "claude" {
				writeErr(w, 400, L(r, "这种会话不能改写中间的消息", "Messages in the middle of this kind of session cannot be rewritten"))
				return
			}
			run.Rewind = true
			rewindCmd = map[string]any{"rewind": true, "fork_before_ts": rw.BeforeTS, "fork_before_text": clip(rw.BeforeText, 400)}
		}
	} else {
		if body.Agent != "claude" && body.Agent != "codex" {
			writeErr(w, 400, L(r, "请选择 Claude 或 Codex", "Choose Claude or Codex"))
			return
		}
		if strings.TrimSpace(body.Cwd) == "" {
			writeErr(w, 400, L(r, "请选择工作目录", "Choose a working directory"))
			return
		}
		run.IsNew, run.Agent, run.Machine, run.Cwd = true, body.Agent, body.Machine, strings.TrimSpace(body.Cwd)
	}
	if run.Agent != "claude" && run.Agent != "codex" {
		writeErr(w, 400, L(r, "暂不支持操控这种会话：", "This kind of session cannot be continued yet: ")+run.Agent)
		return
	}
	if !s.mach.has(run.Machine) {
		writeErr(w, http.StatusConflict, L(r, "这台机器没有接入操控，只能查看历史", "This machine has no runner, so it is history only"))
		return
	}
	if !s.mach.online(run.Machine) {
		writeErr(w, http.StatusConflict, L(r, "这台机器现在不在线", "This machine is offline"))
		return
	}
	if forkCmd != nil && !s.mach.supports(run.Machine, "fork") {
		writeErr(w, http.StatusConflict, L(r, "这台机器上的 runner 版本太旧，还不支持分叉。更新 runner 后再试。", "The runner on this machine is too old to fork sessions. Update it and try again."))
		return
	}
	if rewindCmd != nil && !s.mach.supports(run.Machine, "rewind") {
		// An older runner would ignore "rewind" and add the message to the end of the session.
		writeErr(w, http.StatusConflict, L(r, "这台机器上的 runner 版本太旧，还不能在原会话里改写消息。更新 runner 后再试。", "The runner on this machine is too old to rewrite a message in place. Update it and try again."))
		return
	}
	run = s.runs.Create(run)
	job := map[string]any{
		"id": run.ID, "agent": run.Agent, "native_id": run.NativeID, "cwd": run.Cwd,
		"prompt": run.Prompt, "mode": run.Mode, "model": run.Model, "effort": run.Effort, "is_new": run.IsNew,
	}
	for k, v := range forkCmd {
		job[k] = v
	}
	for k, v := range rewindCmd {
		job[k] = v
	}
	cmd := map[string]any{"id": "c" + randToken(9), "type": "start", "run": job}
	if err := s.mach.enqueue(run.Machine, cmd); err != nil {
		zh, en := both(err)
		run, _, _ = s.runs.Append(run.ID, "exit", time.Now().UnixMilli(), nil, func(x *Run) {
			x.Status, x.Error, x.ErrorZh, x.Ended = "error", en, zh, time.Now().UnixMilli()
		})
		writeErr(w, http.StatusConflict, errText(r, err))
		return
	}
	s.bus.Publish("run", map[string]any{"run": run})
	writeJSON(w, 200, map[string]any{"run": run})
}

func (s *Server) handlePermission(w http.ResponseWriter, r *http.Request) {
	run, ok := s.runs.Get(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, "run not found")
		return
	}
	var body struct {
		RequestID string          `json:"request_id"`
		Behavior  string          `json:"behavior"` // allow | deny
		Message   string          `json:"message"`
		Always    bool            `json:"always"`
		Input     json.RawMessage `json:"input"` // optional replacement input (answers to a question)
	}
	if err := readJSON(r, &body, 1<<20); err != nil || (body.Behavior != "allow" && body.Behavior != "deny") {
		writeErr(w, 400, "bad request")
		return
	}
	if run.Perm == nil || run.Perm.RequestID != body.RequestID {
		writeErr(w, http.StatusConflict, L(r, "这个请求已经处理过了", "This request was already answered"))
		return
	}
	err := s.mach.enqueue(run.Machine, map[string]any{
		"id": "c" + randToken(9), "type": "permission", "run_id": run.ID, "request_id": body.RequestID,
		"behavior": body.Behavior, "message": body.Message, "always": body.Always, "input": body.Input,
	})
	if err != nil {
		writeErr(w, http.StatusConflict, errText(r, err))
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	run, ok := s.runs.Get(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, "run not found")
		return
	}
	if terminal(run.Status) {
		writeJSON(w, 200, map[string]any{"run": run})
		return
	}
	if run.Status == "queued" {
		s.mach.removeQueued(run.Machine, func(c map[string]any) bool {
			rr, _ := c["run"].(map[string]any)
			return c["type"] == "start" && rr != nil && rr["id"] == run.ID
		})
	}
	s.mach.enqueue(run.Machine, map[string]any{"id": "c" + randToken(9), "type": "stop", "run_id": run.ID})
	if run.Status == "queued" || !s.mach.online(run.Machine) {
		// Nothing on the machine will answer: close the run here.
		s.finishRun(run.ID, "stopped", nil)
	}
	run, _ = s.runs.Get(run.ID)
	writeJSON(w, 200, map[string]any{"run": run})
}

func (s *Server) finishRun(id, status string, cause error) {
	now := time.Now().UnixMilli()
	zh, en := "", ""
	if cause != nil {
		zh, en = both(cause)
	}
	data, _ := json.Marshal(map[string]any{"error": en, "error_zh": zh, "by": "hub"})
	run, ev, ok := s.runs.Append(id, "exit", now, data, func(x *Run) {
		if terminal(x.Status) {
			return
		}
		x.Status, x.Error, x.ErrorZh, x.Ended, x.Perm = status, en, zh, now, nil
	})
	if ok {
		s.bus.Publish("run", map[string]any{"run": run, "event": ev})
	}
}

// handleCapsRefresh asks a machine's runner to read its agents' models and commands again.
func (s *Server) handleCapsRefresh(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !s.mach.supports(name, "effort") {
		writeErr(w, http.StatusConflict, L(r, "这台机器上的 runner 版本较旧，还不能读取模型列表", "The runner on this machine is too old to report its models"))
		return
	}
	if _, err := s.mach.rpc(r.Context(), name, map[string]any{"type": "caps"}, 60*time.Second); err != nil {
		writeErr(w, http.StatusConflict, errText(r, err))
		return
	}
	writeJSON(w, 200, map[string]any{"machines": s.machineList(r.Context())})
}

func (s *Server) handleLs(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Machine string `json:"machine"`
		Path    string `json:"path"`
	}
	if err := readJSON(r, &body, 1<<16); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	data, err := s.mach.rpc(r.Context(), body.Machine, map[string]any{"type": "ls", "path": body.Path}, 12*time.Second)
	if err != nil {
		writeErr(w, http.StatusConflict, errText(r, err))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write(data)
}

// ---------- runner side ----------

func (s *Server) handleRunnerHello(w http.ResponseWriter, r *http.Request) {
	name := machineOf(r)
	var raw json.RawMessage
	if err := readJSON(r, &raw, 1<<20); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	var hello struct {
		Active []string `json:"active"`
		Terms  []string `json:"terms"`
	}
	json.Unmarshal(raw, &hello)
	s.mach.setInfo(name, raw)
	s.reconcileTerms(name, hello.Terms)
	active := map[string]bool{}
	for _, id := range hello.Active {
		active[id] = true
	}
	// Runs the hub believes are in flight on this machine but the runner no
	// longer has (it restarted) cannot finish: close them.
	for _, run := range s.runs.List(func(x *Run) bool {
		return x.Machine == name && (x.Status == "starting" || x.Status == "running" || x.Status == "permission")
	}) {
		if !active[run.ID] {
			s.finishRun(run.ID, "lost", bi("这台机器上的后台程序重启了，这次运行被中断", "The runner on this machine restarted and the run was interrupted"))
		}
	}
	s.bus.Publish("machines", s.machineList(r.Context()))
	writeJSON(w, 200, map[string]any{"ok": true, "machine": name, "version": version})
}

func (s *Server) handleRunnerPoll(w http.ResponseWriter, r *http.Request) {
	wait := intParam(r, "wait", 25)
	if wait < 1 || wait > 50 {
		wait = 25
	}
	name := machineOf(r)
	// After a hub restart a runner may keep polling without noticing. The hub then knows
	// nothing about the machine (its agents, what its runner supports), so ask it to say
	// hello again: a runner treats any error here as "reconnect", and reconnecting starts with hello.
	if !s.mach.introduced(name) {
		s.mach.touch(name)
		writeErr(w, http.StatusConflict, "say hello first")
		return
	}
	cmds := s.mach.poll(r.Context(), name, time.Duration(wait)*time.Second)
	s.mach.touch(name)
	if cmds == nil {
		cmds = []json.RawMessage{}
	}
	writeJSON(w, 200, map[string]any{"commands": cmds})
}

type inEvent struct {
	RunID string          `json:"run_id"`
	T     string          `json:"t"`
	TS    int64           `json:"ts"`
	Data  json.RawMessage `json:"data"`
}

func (s *Server) handleRunnerEvents(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Events []inEvent `json:"events"`
	}
	if err := readJSON(r, &body, 32<<20); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	name := machineOf(r)
	for _, ev := range body.Events {
		switch {
		case ev.T == "caps":
			if s.mach.setCaps(name, ev.Data) {
				s.bus.Publish("machines", s.machineList(r.Context()))
			}
		case strings.HasPrefix(ev.T, "term_"):
			s.applyTermEvent(name, ev)
		default:
			s.applyRunEvent(name, ev)
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func setRunSession(x *Run, native string) {
	if native == "" || (!x.IsNew && x.NativeID != "") {
		return
	}
	x.NativeID = native
	if x.Agent == "codex" {
		x.SessionID = "codex:" + native
	} else {
		x.SessionID = native
	}
}

func (s *Server) applyRunEvent(machine string, ev inEvent) {
	run, ok := s.runs.Get(ev.RunID)
	if !ok || run.Machine != machine || terminal(run.Status) {
		return
	}
	now := time.Now().UnixMilli()
	mutate := func(x *Run) {
		switch ev.T {
		case "status":
			var d struct {
				State     string `json:"state"`
				SessionID string `json:"session_id"`
				StartedTS int64  `json:"started_ts"`
			}
			json.Unmarshal(ev.Data, &d)
			if (d.State == "starting" || d.State == "running") && x.Status != "permission" {
				x.Status = d.State
			}
			setRunSession(x, d.SessionID)
			if d.StartedTS > 0 {
				x.StartedTS = d.StartedTS
			}
		case "agent":
			var d struct {
				Type      string `json:"type"`
				Subtype   string `json:"subtype"`
				SessionID string `json:"session_id"`
				ThreadID  string `json:"thread_id"`
			}
			json.Unmarshal(ev.Data, &d)
			if d.Type == "system" && d.Subtype == "init" {
				setRunSession(x, d.SessionID)
			}
			if d.Type == "thread.started" {
				setRunSession(x, d.ThreadID)
			}
			x.LastTS = ev.TS
			if x.Status == "starting" || x.Status == "queued" {
				x.Status = "running"
			}
		case "permission":
			var p PermReq
			if json.Unmarshal(ev.Data, &p) == nil && p.RequestID != "" {
				x.Perm, x.Status = &p, "permission"
			}
		case "permission_done":
			x.Perm = nil
			if x.Status == "permission" {
				x.Status = "running"
			}
		case "exit":
			var d struct {
				Error   string `json:"error"`
				ErrorZh string `json:"error_zh"`
				Stopped bool   `json:"stopped"`
			}
			json.Unmarshal(ev.Data, &d)
			if d.ErrorZh == "" {
				d.ErrorZh = d.Error
			}
			x.Perm, x.Ended, x.Error, x.ErrorZh = nil, now, d.Error, d.ErrorZh
			switch {
			case d.Stopped:
				x.Status = "stopped"
			case d.Error != "":
				x.Status = "error"
			default:
				x.Status = "done"
			}
		}
	}
	run, e, ok := s.runs.Append(ev.RunID, ev.T, ev.TS, ev.Data, mutate)
	if ok {
		s.noteFork(run)
		if ev.T == "rewind" {
			s.noteRewind(run, ev.Data)
		}
		s.bus.Publish("run", map[string]any{"run": run, "event": e})
	}
}

// noteFork records, once the forked session has reported its own id, where it
// came from. The archive will list it like any other session; this note is
// what lets the page show it as a branch or a side chat of its parent.
func (s *Server) noteFork(run Run) {
	if run.ForkOf == "" || run.SessionID == "" || s.meta.Get(run.SessionID).ForkOf != "" {
		return
	}
	m := s.meta.Patch(run.SessionID, func(m *Meta) {
		m.ForkOf, m.ForkKind, m.ForkTS = run.ForkOf, run.ForkKind, run.StartedTS
		if m.Title == "" {
			m.Title = run.Title
		}
	})
	s.bus.Publish("meta", map[string]any{"id": run.SessionID, "meta": m})
}

// noteRewind records that a session went on from before one of its messages:
// the runner says which stretch of the transcript it left behind. The archive
// lists a transcript in the order it was written, so this note is what lets the
// page fold that stretch away instead of showing both versions one after the other.
func (s *Server) noteRewind(run Run, data json.RawMessage) {
	var d struct {
		From int64 `json:"from"`
		To   int64 `json:"to"`
	}
	if !run.Rewind || run.SessionID == "" || json.Unmarshal(data, &d) != nil || d.From <= 0 || d.To <= d.From {
		return
	}
	m := s.meta.Patch(run.SessionID, func(m *Meta) {
		for _, x := range m.Rewinds {
			if x.Run == run.ID {
				return
			}
		}
		m.Rewinds = append(m.Rewinds, Rewind{Run: run.ID, From: d.From, To: d.To})
		if n := len(m.Rewinds); n > 200 {
			m.Rewinds = append([]Rewind(nil), m.Rewinds[n-200:]...)
		}
	})
	s.bus.Publish("meta", map[string]any{"id": run.SessionID, "meta": m})
}

func (s *Server) handleRunnerReply(w http.ResponseWriter, r *http.Request) {
	var rep rpcReply
	if err := readJSON(r, &rep, 8<<20); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	s.mach.resolve(rep)
	writeJSON(w, 200, map[string]any{"ok": true})
}
