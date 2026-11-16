package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

type sink struct {
	mu sync.Mutex
	bytes.Buffer
}

func (s *sink) Write(b []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Buffer.Write(b)
}
func (s *sink) Close() error { return nil }
func (s *sink) lines() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(s.String()), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(l), &m) == nil {
			out = append(out, m)
		}
	}
	return out
}

func drain(r *Runner) []outEvent {
	var evs []outEvent
	for {
		select {
		case e := <-r.out:
			evs = append(evs, e)
		default:
			return evs
		}
	}
}

// A Claude process that its background tasks keep alive takes the session's
// next message: at once when the agent is idle, after the turn when it is not.
func TestTakeOver(t *testing.T) {
	r := testRunner(t, false)
	in := &sink{}
	first := Job{ID: "A", Agent: "claude", NativeID: "s1", Mode: "edits", Model: "opus"}
	p := &proc{r: r, job: first, id: "A", pending: map[string]pendingPerm{}, stdin: in, mode: "acceptEdits", model: "opus", native: "s1"}
	r.procs["A"] = p
	msg := func(id, prompt, mode, model string) Job {
		return Job{ID: id, Agent: "claude", NativeID: "s1", Prompt: prompt, Mode: mode, Model: model}
	}

	// Still on its first turn: nobody else may have the session.
	p.turn = true
	if got := p.take(msg("B", "hi", "edits", "opus")); got != "no" {
		t.Fatalf("during the first turn: %q", got)
	}
	// The turn is over, a background task keeps the process: the message goes straight in.
	p.turn, p.turns, p.idle = false, 1, true
	p.parts = map[string]any{"tasks": []string{"t1"}, "last": "x"}
	if got := p.take(msg("B", "second", "ask", "haiku")); got != "taken" {
		t.Fatalf("idle with a background task: %q", got)
	}
	if p.runID() != "B" || r.procs["B"] != p || r.procs["A"] != nil || !p.turn {
		t.Fatalf("after the hand-over: id %q, procs %v", p.runID(), r.procs)
	}
	evs := drain(r)
	if len(evs) != 3 || evs[0].RunID != "A" || evs[0].T != "exit" || evs[1].RunID != "B" || evs[1].T != "status" || evs[2].T != "info" {
		t.Fatalf("events: %+v", evs)
	}
	if parts := evs[2].Data.(map[string]any); parts["tasks"] == nil || parts["last"] != nil {
		t.Fatalf("info carried over: %v", parts)
	}
	ls := in.lines()
	if len(ls) != 3 || ls[0]["request"].(map[string]any)["mode"] != "default" || ls[1]["request"].(map[string]any)["model"] != "haiku" ||
		ls[2]["type"] != "user" || ls[2]["message"].(map[string]any)["content"] != "second" {
		t.Fatalf("written to the agent: %v", ls)
	}

	// While that turn is going, the next one waits; a second waiting one is refused.
	if got := p.take(msg("C", "third", "ask", "haiku")); got != "later" {
		t.Fatalf("during a later turn: %q", got)
	}
	if got := p.take(msg("D", "fourth", "ask", "haiku")); got != "no" {
		t.Fatalf("with one already waiting: %q", got)
	}
	if len(in.lines()) != 3 || p.runID() != "B" {
		t.Fatal("a waiting message must not reach the agent yet")
	}
	// Same mode and model: only the message is written.
	p.mu.Lock()
	next := p.next
	p.next, p.turn = nil, false
	p.mu.Unlock()
	p.handOver(*next)
	if ls = in.lines(); len(ls) != 4 || ls[3]["message"].(map[string]any)["content"] != "third" || p.runID() != "C" {
		t.Fatalf("after the turn: %v", ls)
	}

	// A fork, a rewind or another session never takes it; a process on its way out says so.
	p.turn = false
	if p.take(Job{ID: "E", Agent: "claude", NativeID: "s1", Fork: true}) != "no" || p.take(Job{ID: "F", Agent: "claude", NativeID: "s1", Rewind: true}) != "no" {
		t.Fatal("a fork or a rewind needs a process of its own")
	}
	if !p.sameSession(msg("G", "", "", "")) || p.sameSession(Job{Agent: "claude", NativeID: "other"}) {
		t.Fatal("sameSession")
	}
	p.closeStdin()
	if got := p.take(msg("H", "late", "ask", "haiku")); got != "closing" {
		t.Fatalf("after its input closed: %q", got)
	}
}
