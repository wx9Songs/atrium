package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Machines tracks the runner on each machine. Runners only make outbound
// requests: they long-poll for commands and post events back.

type Machine struct {
	Name      string
	LastSeen  time.Time
	Info      json.RawMessage
	Caps      map[string]json.RawMessage // per agent: slash commands and models, as its CLI reports them
	queue     []json.RawMessage
	wake      chan struct{}
	wasOnline bool
}

type rpcReply struct {
	ID      string          `json:"id"`
	OK      bool            `json:"ok"`
	Data    json.RawMessage `json:"data,omitempty"`
	Error   string          `json:"error,omitempty"`
	ErrorZh string          `json:"error_zh,omitempty"`
}

type Machines struct {
	mu       sync.Mutex
	cfg      *Config
	m        map[string]*Machine
	pending  map[string]chan rpcReply
	reloaded time.Time
	capsPath string
}

func newMachines(cfg *Config, capsPath string) *Machines {
	ms := &Machines{cfg: cfg, m: map[string]*Machine{}, pending: map[string]chan rpcReply{}, capsPath: capsPath}
	saved := map[string]map[string]json.RawMessage{}
	if b, err := os.ReadFile(capsPath); err == nil {
		json.Unmarshal(b, &saved)
	}
	for name := range cfg.Machines {
		ms.m[name] = &Machine{Name: name, wake: make(chan struct{}, 1), Caps: saved[name]}
	}
	return ms
}

// setCaps stores what an agent on a machine offers (kept across restarts, so
// the "/" menu is complete before the first run) and reports whether it changed.
func (ms *Machines) setCaps(name string, data json.RawMessage) bool {
	var d struct {
		Agent string `json:"agent"`
	}
	if json.Unmarshal(data, &d) != nil || d.Agent == "" || len(data) > 256<<10 {
		return false
	}
	ms.mu.Lock()
	defer ms.mu.Unlock()
	m := ms.m[name]
	if m == nil || bytes.Equal(m.Caps[d.Agent], data) {
		return false
	}
	if m.Caps == nil {
		m.Caps = map[string]json.RawMessage{}
	}
	m.Caps[d.Agent] = data
	all := map[string]map[string]json.RawMessage{}
	for n, x := range ms.m {
		if len(x.Caps) > 0 {
			all[n] = x.Caps
		}
	}
	if b, err := json.Marshal(all); err == nil {
		writeFileAtomic(ms.capsPath, b, 0o600)
	}
	return true
}

// allowsShell tells whether the machine's runner said its terminal is on.
func (ms *Machines) allowsShell(name string) bool {
	return ms.hello(name).Shell
}

// supports tells whether the machine's runner understands a newer command.
// A runner from before forks existed would quietly drop the "fork" part of a
// job and write into the original session, so the hub must not send it one.
func (ms *Machines) supports(name, feature string) bool {
	for _, f := range ms.hello(name).Features {
		if f == feature {
			return true
		}
	}
	return false
}

type helloInfo struct {
	Shell    bool     `json:"shell"`
	Features []string `json:"features"`
}

func (ms *Machines) hello(name string) (info helloInfo) {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	if m := ms.m[name]; m != nil {
		json.Unmarshal(m.Info, &info)
	}
	return
}

const onlineWindow = 50 * time.Second

// byToken maps a runner token to its machine. Machines added with
// `atrium add-machine` while the server runs are picked up from the config file.
func (ms *Machines) byToken(tok string) (string, bool) {
	h := sha256hex(tok)
	ms.mu.Lock()
	defer ms.mu.Unlock()
	find := func() (string, bool) {
		for name, mc := range ms.cfg.Machines {
			if subtle.ConstantTimeCompare([]byte(mc.TokenHash), []byte(h)) == 1 {
				if ms.m[name] == nil {
					ms.m[name] = &Machine{Name: name, wake: make(chan struct{}, 1)}
				}
				return name, true
			}
		}
		return "", false
	}
	if name, ok := find(); ok {
		return name, true
	}
	if time.Since(ms.reloaded) > 5*time.Second {
		ms.reloaded = time.Now()
		if fresh, err := loadConfig(ms.cfg.path); err == nil {
			ms.cfg.Machines = fresh.Machines
			ms.cfg.Labels = fresh.Labels
			return find()
		}
	}
	return "", false
}

func (ms *Machines) touch(name string) {
	ms.mu.Lock()
	if m := ms.m[name]; m != nil {
		m.LastSeen = time.Now()
	}
	ms.mu.Unlock()
}

func (ms *Machines) has(name string) bool {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	return ms.m[name] != nil
}

func (ms *Machines) online(name string) bool {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	m := ms.m[name]
	return m != nil && time.Since(m.LastSeen) < onlineWindow
}

func (ms *Machines) setInfo(name string, info json.RawMessage) {
	ms.mu.Lock()
	if m := ms.m[name]; m != nil {
		m.Info = info
		m.LastSeen = time.Now()
	}
	ms.mu.Unlock()
}

func (ms *Machines) enqueue(name string, cmd any) error {
	b, err := json.Marshal(cmd)
	if err != nil {
		return err
	}
	ms.mu.Lock()
	defer ms.mu.Unlock()
	m := ms.m[name]
	if m == nil {
		return bi("这台机器没有接入", "This machine is not connected")
	}
	m.queue = append(m.queue, b)
	select {
	case m.wake <- struct{}{}:
	default:
	}
	return nil
}

// removeQueued drops commands that have not been picked up yet.
func (ms *Machines) removeQueued(name string, pred func(map[string]any) bool) {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	m := ms.m[name]
	if m == nil {
		return
	}
	keep := m.queue[:0]
	for _, raw := range m.queue {
		var c map[string]any
		if json.Unmarshal(raw, &c) == nil && pred(c) {
			continue
		}
		keep = append(keep, raw)
	}
	m.queue = keep
}

func (ms *Machines) poll(ctx context.Context, name string, wait time.Duration) []json.RawMessage {
	take := func() []json.RawMessage {
		ms.mu.Lock()
		defer ms.mu.Unlock()
		m := ms.m[name]
		if m == nil {
			return nil
		}
		m.LastSeen = time.Now()
		q := m.queue
		m.queue = nil
		return q
	}
	if q := take(); len(q) > 0 {
		return q
	}
	ms.mu.Lock()
	m := ms.m[name]
	ms.mu.Unlock()
	if m == nil {
		return nil
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	case <-m.wake:
	}
	if q := take(); q != nil {
		return q
	}
	return []json.RawMessage{}
}

func (ms *Machines) rpc(ctx context.Context, name string, cmd map[string]any, timeout time.Duration) (json.RawMessage, error) {
	if !ms.online(name) {
		return nil, bi("这台机器不在线", "This machine is offline")
	}
	id := "c" + randToken(9)
	cmd["id"] = id
	ch := make(chan rpcReply, 1)
	ms.mu.Lock()
	ms.pending[id] = ch
	ms.mu.Unlock()
	defer func() {
		ms.mu.Lock()
		delete(ms.pending, id)
		ms.mu.Unlock()
	}()
	if err := ms.enqueue(name, cmd); err != nil {
		return nil, err
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case rep := <-ch:
		if !rep.OK {
			if rep.ErrorZh != "" {
				return nil, bi(rep.ErrorZh, rep.Error)
			}
			return nil, errors.New(rep.Error)
		}
		return rep.Data, nil
	case <-t.C:
		return nil, bi("机器没有在限定时间内回应", "The machine did not answer in time")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (ms *Machines) resolve(rep rpcReply) {
	ms.mu.Lock()
	ch := ms.pending[rep.ID]
	ms.mu.Unlock()
	if ch != nil {
		select {
		case ch <- rep:
		default:
		}
	}
}

func (ms *Machines) presenceChanged() bool {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	changed := false
	for _, m := range ms.m {
		on := time.Since(m.LastSeen) < onlineWindow
		if on != m.wasOnline {
			m.wasOnline = on
			changed = true
		}
	}
	return changed
}

type MachineView struct {
	Name     string                     `json:"name"`
	Label    string                     `json:"label"`
	Runner   bool                       `json:"runner"`
	Online   bool                       `json:"online"`
	LastSeen int64                      `json:"last_seen,omitempty"`
	Info     json.RawMessage            `json:"info,omitempty"`
	Caps     map[string]json.RawMessage `json:"caps,omitempty"`
}

// machineList merges machines that have a runner with machines that only
// appear in the archive (history is visible, but they cannot be driven).
func (s *Server) machineList(ctx context.Context) []MachineView {
	ms := s.mach
	ms.mu.Lock()
	seen := map[string]bool{}
	out := []MachineView{}
	label := func(n string) string {
		if l := ms.cfg.Labels[n]; l != "" {
			return l
		}
		return n
	}
	for name, m := range ms.m {
		v := MachineView{Name: name, Label: label(name), Runner: true, Info: m.Info, Caps: m.Caps,
			Online: time.Since(m.LastSeen) < onlineWindow}
		if !m.LastSeen.IsZero() {
			v.LastSeen = m.LastSeen.UnixMilli()
		}
		out = append(out, v)
		seen[name] = true
	}
	ms.mu.Unlock()
	if list, _, err := s.arc.Sessions(ctx, false); err == nil {
		for _, x := range list {
			if !seen[x.Machine] {
				seen[x.Machine] = true
				ms.mu.Lock()
				l := label(x.Machine)
				ms.mu.Unlock()
				out = append(out, MachineView{Name: x.Machine, Label: l})
			}
		}
	}
	return out
}

// ---------- runner auth ----------

type ctxKey int

const machineKey ctxKey = 1

func (s *Server) runner(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		name, ok := "", false
		if tok != "" {
			name, ok = s.mach.byToken(tok)
		}
		if !ok {
			writeErr(w, http.StatusUnauthorized, "unknown runner token")
			return
		}
		s.mach.touch(name)
		h(w, r.WithContext(context.WithValue(r.Context(), machineKey, name)))
	}
}

func machineOf(r *http.Request) string {
	n, _ := r.Context().Value(machineKey).(string)
	return n
}
