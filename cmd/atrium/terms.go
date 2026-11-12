package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"sort"
	"sync"
	"time"
)

// Terminals and files: a pass-through between the page and a machine's runner,
// for machines whose runner config allows it ("allow_shell": true). The hub
// keeps the recent output of each open terminal so a reloaded page, or a
// second window, can pick the same terminal up where it is.

const termScrollback = 256 << 10

type Term struct {
	ID      string `json:"id"`
	Machine string `json:"machine"`
	Key     string `json:"key"` // what the page opened it for (a session id)
	Cwd     string `json:"cwd"`
	Created int64  `json:"created"`
	Exited  bool   `json:"exited,omitempty"`
	Code    int    `json:"code,omitempty"`
	Error   string `json:"error,omitempty"`
	ErrorZh string `json:"error_zh,omitempty"`

	buf    []byte
	end    int64 // bytes of output so far; buf holds the last part of them
	active int64 // last time something was typed into it or came out of it
}

// A machine keeps this many terminals open at most; opening one more closes the one unused for longest.
const maxTermsPerMachine = 12

type Terms struct {
	mu sync.Mutex
	m  map[string]*Term
}

func newTerms() *Terms { return &Terms{m: map[string]*Term{}} }

func (ts *Terms) get(id string) (Term, bool) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	t, ok := ts.m[id]
	if !ok {
		return Term{}, false
	}
	return *t, true
}

func (ts *Terms) list() []Term {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	out := make([]Term, 0, len(ts.m))
	for _, t := range ts.m {
		c := *t
		c.buf = nil
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created < out[j].Created })
	return out
}

// append records output and returns the offset it starts at.
func (ts *Terms) append(id string, data []byte) (int64, bool) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	t := ts.m[id]
	if t == nil || t.Exited {
		return 0, false
	}
	off := t.end
	t.active = time.Now().UnixMilli()
	t.end += int64(len(data))
	t.buf = append(t.buf, data...)
	if len(t.buf) > termScrollback {
		t.buf = append([]byte(nil), t.buf[len(t.buf)-termScrollback:]...)
	}
	return off, true
}

func (ts *Terms) exit(id string, code int, en, zh string) bool {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	t := ts.m[id]
	if t == nil || t.Exited {
		return false
	}
	t.Exited, t.Code, t.Error, t.ErrorZh = true, code, en, zh
	return true
}

func (ts *Terms) touch(id string) {
	ts.mu.Lock()
	if t := ts.m[id]; t != nil {
		t.active = time.Now().UnixMilli()
	}
	ts.mu.Unlock()
}

// stalest returns the open terminal on a machine that has been quiet for longest, once the machine is at its limit.
func (ts *Terms) stalest(machine string) (string, bool) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	n, id, at := 0, "", int64(0)
	for _, t := range ts.m {
		if t.Machine != machine || t.Exited {
			continue
		}
		n++
		if id == "" || t.active < at {
			id, at = t.ID, t.active
		}
	}
	return id, n >= maxTermsPerMachine
}

// prune forgets terminals that ended a while ago.
func (ts *Terms) prune() {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	for id, t := range ts.m {
		if t.Exited && len(ts.m) > 4 {
			delete(ts.m, id)
		}
	}
}

// applyTermEvent takes terminal output (or its end) from a runner and passes it on to the page.
func (s *Server) applyTermEvent(machine string, ev inEvent) {
	t, ok := s.terms.get(ev.RunID)
	if !ok || t.Machine != machine {
		return
	}
	switch ev.T {
	case "term_out":
		var d struct {
			Data string `json:"data"`
		}
		if json.Unmarshal(ev.Data, &d) != nil {
			return
		}
		raw, err := base64.StdEncoding.DecodeString(d.Data)
		if err != nil || len(raw) == 0 {
			return
		}
		if off, ok := s.terms.append(ev.RunID, raw); ok {
			s.bus.Publish("term", map[string]any{"id": ev.RunID, "off": off, "data": d.Data})
		}
	case "term_exit":
		var d struct {
			Code    int    `json:"code"`
			Error   string `json:"error"`
			ErrorZh string `json:"error_zh"`
		}
		json.Unmarshal(ev.Data, &d)
		if s.terms.exit(ev.RunID, d.Code, d.Error, d.ErrorZh) {
			s.bus.Publish("term", map[string]any{"id": ev.RunID, "exit": true, "code": d.Code, "error": d.Error, "error_zh": d.ErrorZh})
		}
	}
}

// reconcileTerms runs when a runner says hello: terminals the hub has that the
// runner lost (it restarted) are closed here, and ones the runner has that the
// hub lost (the hub restarted) are closed there.
func (s *Server) reconcileTerms(machine string, alive []string) {
	have := map[string]bool{}
	for _, id := range alive {
		have[id] = true
		if _, ok := s.terms.get(id); !ok {
			s.mach.enqueue(machine, map[string]any{"id": "c" + randToken(9), "type": "term_close", "term_id": id})
		}
	}
	for _, t := range s.terms.list() {
		if t.Machine == machine && !t.Exited && !have[t.ID] && time.Now().UnixMilli()-t.Created > 5000 {
			if s.terms.exit(t.ID, -1, "The runner on this machine restarted", "这台机器上的 runner 重启了") {
				s.bus.Publish("term", map[string]any{"id": t.ID, "exit": true, "code": -1, "error": "The runner on this machine restarted", "error_zh": "这台机器上的 runner 重启了"})
			}
		}
	}
}

// shellMachine checks that a machine is online and has its terminal and files turned on.
func (s *Server) shellMachine(w http.ResponseWriter, r *http.Request, machine string) bool {
	if !s.mach.online(machine) {
		writeErr(w, http.StatusConflict, L(r, "这台机器现在不在线", "This machine is offline"))
		return false
	}
	if !s.mach.allowsShell(machine) {
		writeErr(w, http.StatusConflict, L(r, "这台机器没有开启终端和文件", "The terminal and files are off on this machine"))
		return false
	}
	return true
}

func (s *Server) handleTermList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"terms": s.terms.list()})
}

func (s *Server) handleTermOpen(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Machine string `json:"machine"`
		Key     string `json:"key"`
		Cwd     string `json:"cwd"`
		Cols    int    `json:"cols"`
		Rows    int    `json:"rows"`
	}
	if err := readJSON(r, &body, 1<<14); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if !s.shellMachine(w, r, body.Machine) {
		return
	}
	if !s.mach.supports(body.Machine, "term") {
		writeErr(w, http.StatusConflict, L(r, "这台机器上的 runner 版本太旧，还没有终端。更新 runner 后再试。", "The runner on this machine is too old to have a terminal. Update it and try again."))
		return
	}
	s.terms.prune()
	if old, full := s.terms.stalest(body.Machine); full {
		s.mach.enqueue(body.Machine, map[string]any{"id": "c" + randToken(9), "type": "term_close", "term_id": old})
	}
	now := time.Now().UnixMilli()
	t := &Term{ID: "t" + randToken(9), Machine: body.Machine, Key: body.Key, Cwd: body.Cwd, Created: now, active: now}
	s.terms.mu.Lock()
	s.terms.m[t.ID] = t
	s.terms.mu.Unlock()
	err := s.mach.enqueue(body.Machine, map[string]any{"id": "c" + randToken(9), "type": "term_open", "term_id": t.ID, "cwd": body.Cwd, "cols": body.Cols, "rows": body.Rows})
	if err != nil {
		s.terms.exit(t.ID, -1, "", "")
		writeErr(w, http.StatusConflict, errText(r, err))
		return
	}
	writeJSON(w, 200, map[string]any{"term": t})
}

// handleTermGet returns a terminal with the output the hub still holds.
func (s *Server) handleTermGet(w http.ResponseWriter, r *http.Request) {
	t, ok := s.terms.get(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, "terminal not found")
		return
	}
	writeJSON(w, 200, map[string]any{"term": t, "data": base64.StdEncoding.EncodeToString(t.buf), "end": t.end})
}

func (s *Server) handleTermCommand(w http.ResponseWriter, r *http.Request) {
	t, ok := s.terms.get(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, "terminal not found")
		return
	}
	var body struct {
		Data string `json:"data"`
		Cols int    `json:"cols"`
		Rows int    `json:"rows"`
	}
	if err := readJSON(r, &body, 1<<20); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	cmd := map[string]any{"id": "c" + randToken(9), "term_id": t.ID}
	switch r.PathValue("op") {
	case "input":
		if t.Exited || body.Data == "" {
			writeJSON(w, 200, map[string]any{"ok": true})
			return
		}
		cmd["type"], cmd["data"] = "term_in", body.Data
		s.terms.touch(t.ID)
	case "resize":
		cmd["type"], cmd["cols"], cmd["rows"] = "term_resize", body.Cols, body.Rows
	case "close":
		cmd["type"] = "term_close"
		if !s.mach.online(t.Machine) && s.terms.exit(t.ID, 0, "", "") {
			s.bus.Publish("term", map[string]any{"id": t.ID, "exit": true})
		}
	default:
		writeErr(w, 404, "not found")
		return
	}
	if err := s.mach.enqueue(t.Machine, cmd); err != nil {
		writeErr(w, http.StatusConflict, errText(r, err))
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// handleFs passes a file request (list, read, write) to the machine's runner.
func (s *Server) handleFs(w http.ResponseWriter, r *http.Request) {
	op := r.PathValue("op")
	if op != "list" && op != "read" && op != "write" {
		writeErr(w, 404, "not found")
		return
	}
	var body struct {
		Machine string `json:"machine"`
		Path    string `json:"path"`
		Content string `json:"content"`
		Mtime   int64  `json:"mtime"`
	}
	if err := readJSON(r, &body, 6<<20); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if !s.shellMachine(w, r, body.Machine) {
		return
	}
	if !s.mach.supports(body.Machine, "files") {
		writeErr(w, http.StatusConflict, L(r, "这台机器上的 runner 版本太旧，还不能浏览文件。更新 runner 后再试。", "The runner on this machine is too old to browse files. Update it and try again."))
		return
	}
	cmd := map[string]any{"type": "fs_" + op, "path": body.Path}
	if op == "write" {
		cmd["content"], cmd["mtime"] = body.Content, body.Mtime
	}
	data, err := s.mach.rpc(r.Context(), body.Machine, cmd, 20*time.Second)
	if err != nil {
		writeErr(w, http.StatusConflict, errText(r, err))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}
