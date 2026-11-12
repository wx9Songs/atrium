package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// A Run is one turn sent from the web page to an agent on a machine: either a
// follow-up message to an existing session or the first message of a new one.

type PermReq struct {
	RequestID   string          `json:"request_id"`
	ToolName    string          `json:"tool_name"`
	Input       json.RawMessage `json:"input,omitempty"`
	Description string          `json:"description,omitempty"`
	Suggestions json.RawMessage `json:"suggestions,omitempty"`
	BlockedPath string          `json:"blocked_path,omitempty"`
}

type Run struct {
	ID        string `json:"id"`
	SessionID string `json:"session_id"` // archive id; empty until a new session reports its id
	NativeID  string `json:"native_id"`
	Agent     string `json:"agent"`
	Machine   string `json:"machine"`
	Cwd       string `json:"cwd"`
	Prompt    string `json:"prompt"`
	Mode      string `json:"mode"`
	Model     string `json:"model,omitempty"`
	IsNew     bool   `json:"is_new"`
	// queued → starting → running ⇄ permission → done | error | stopped | lost
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
	ErrorZh string `json:"error_zh,omitempty"`
	Created int64  `json:"created"`         // hub clock, ms
	Ended   int64  `json:"ended,omitempty"` // hub clock, ms
	// Machine-clock timestamps. The transcript on the machine is stamped by the
	// same clock, so the page can tell which archived messages belong to this run.
	StartedTS int64    `json:"started_ts,omitempty"`
	LastTS    int64    `json:"last_ts,omitempty"`
	Perm      *PermReq `json:"perm,omitempty"`
	Seq       int      `json:"seq"`
}

type RunEvent struct {
	Seq  int             `json:"seq"`
	T    string          `json:"t"`
	TS   int64           `json:"ts"`
	Data json.RawMessage `json:"data,omitempty"`
}

func terminal(status string) bool {
	return status == "done" || status == "error" || status == "stopped" || status == "lost"
}

type runState struct {
	run    Run
	events []RunEvent
	loaded bool
}

type RunStore struct {
	mu    sync.Mutex
	dir   string
	m     map[string]*runState
	order []string
}

func newRunStore(dir string) *RunStore {
	os.MkdirAll(dir, 0o700)
	rs := &RunStore{dir: dir, m: map[string]*runState{}}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var r Run
		if json.Unmarshal(b, &r) != nil || r.ID == "" {
			continue
		}
		st := &runState{run: r}
		if !terminal(r.Status) {
			st.run.Status = "lost"
			st.run.Error = "The server restarted and lost track of this run"
			st.run.ErrorZh = "服务重启时这次运行的状态丢失了"
			st.run.Perm = nil
			st.run.Ended = time.Now().UnixMilli()
			rs.persist(st)
		}
		rs.m[r.ID] = st
		rs.order = append(rs.order, r.ID)
	}
	sort.Slice(rs.order, func(i, j int) bool { return rs.m[rs.order[i]].run.Created < rs.m[rs.order[j]].run.Created })
	return rs
}

func (rs *RunStore) persist(st *runState) {
	b, _ := json.Marshal(st.run)
	writeFileAtomic(filepath.Join(rs.dir, st.run.ID+".json"), b, 0o600)
}

func (rs *RunStore) eventsPath(id string) string { return filepath.Join(rs.dir, id+".events.jsonl") }

func (rs *RunStore) loadEvents(st *runState) {
	if st.loaded {
		return
	}
	st.loaded = true
	f, err := os.Open(rs.eventsPath(st.run.ID))
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<16), 16<<20)
	for sc.Scan() {
		var e RunEvent
		if json.Unmarshal(sc.Bytes(), &e) == nil {
			st.events = append(st.events, e)
		}
	}
}

func (rs *RunStore) Create(r Run) Run {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	st := &runState{run: r, loaded: true}
	rs.m[r.ID] = st
	rs.order = append(rs.order, r.ID)
	rs.persist(st)
	return st.run
}

func (rs *RunStore) Get(id string) (Run, bool) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	st, ok := rs.m[id]
	if !ok {
		return Run{}, false
	}
	return st.run, true
}

func (rs *RunStore) List(pred func(*Run) bool) []Run {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	out := []Run{}
	for _, id := range rs.order {
		st := rs.m[id]
		if pred == nil || pred(&st.run) {
			out = append(out, st.run)
		}
	}
	return out
}

// Append records an event, lets fn update the run, and persists both.
func (rs *RunStore) Append(id, t string, ts int64, data json.RawMessage, fn func(*Run)) (Run, RunEvent, bool) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	st, ok := rs.m[id]
	if !ok {
		return Run{}, RunEvent{}, false
	}
	rs.loadEvents(st)
	st.run.Seq++
	e := RunEvent{Seq: st.run.Seq, T: t, TS: ts, Data: data}
	st.events = append(st.events, e)
	if fn != nil {
		fn(&st.run)
	}
	if b, err := json.Marshal(e); err == nil {
		if f, err := os.OpenFile(rs.eventsPath(id), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			f.Write(append(b, '\n'))
			f.Close()
		}
	}
	rs.persist(st)
	return st.run, e, true
}

func (rs *RunStore) Events(id string, after int) ([]RunEvent, bool) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	st, ok := rs.m[id]
	if !ok {
		return nil, false
	}
	rs.loadEvents(st)
	out := []RunEvent{}
	for _, e := range st.events {
		if e.Seq > after {
			out = append(out, e)
		}
	}
	return out, true
}

// prune drops the oldest finished runs beyond keep and frees the in-memory
// event logs of runs that finished a while ago (they reload from disk on demand).
func (rs *RunStore) prune(keep int) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	now := time.Now().UnixMilli()
	for _, st := range rs.m {
		if terminal(st.run.Status) && st.loaded && now-st.run.Ended > 30*60*1000 {
			st.events, st.loaded = nil, false
		}
	}
	for len(rs.order) > keep {
		id := rs.order[0]
		if !terminal(rs.m[id].run.Status) {
			break
		}
		os.Remove(filepath.Join(rs.dir, id+".json"))
		os.Remove(rs.eventsPath(id))
		delete(rs.m, id)
		rs.order = rs.order[1:]
	}
}

// ---------- per-session notes kept by the hub (pin, rename, hide) ----------

type Meta struct {
	Pinned bool   `json:"pinned,omitempty"`
	Title  string `json:"title,omitempty"`
	Hidden bool   `json:"hidden,omitempty"`
}

type MetaStore struct {
	mu   sync.Mutex
	path string
	m    map[string]Meta
}

func newMetaStore(path string) *MetaStore {
	ms := &MetaStore{path: path, m: map[string]Meta{}}
	if b, err := os.ReadFile(path); err == nil {
		json.Unmarshal(b, &ms.m)
	}
	return ms
}

func (ms *MetaStore) All() map[string]Meta {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	out := make(map[string]Meta, len(ms.m))
	for k, v := range ms.m {
		out[k] = v
	}
	return out
}

func (ms *MetaStore) Patch(id string, fn func(*Meta)) Meta {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	v := ms.m[id]
	fn(&v)
	if v == (Meta{}) {
		delete(ms.m, id)
	} else {
		ms.m[id] = v
	}
	b, _ := json.MarshalIndent(ms.m, "", " ")
	writeFileAtomic(ms.path, b, 0o600)
	return v
}
