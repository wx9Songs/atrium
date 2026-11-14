package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// A run in flight when the hub restarts goes on if its runner still has it,
// and is closed if not; a run closed that way can still report its real end.
func TestRunsAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	cfg := &Config{DataDir: dir, Machines: map[string]*MachineConf{"m1": {}}}
	cfg.path = filepath.Join(dir, "config.json")
	first := newServer(cfg)
	for _, id := range []string{"kept", "gone", "ended", "done"} {
		first.runs.Create(Run{ID: id, Machine: "m1", SessionID: "s-" + id, Status: "running"})
	}
	first.finishRun("done", "done", nil)
	first.runs.Create(Run{ID: "waiting", Machine: "m1", SessionID: "s-waiting", Status: "queued"})
	// A hello must not close a run whose start command the runner has not picked up yet.
	first.reconcileRuns("m1", []string{"kept", "gone", "ended"})
	if run, _ := first.runs.Get("waiting"); run.Status != "queued" {
		t.Fatalf("a hello closed a queued run: %q", run.Status)
	}

	s := newServer(cfg) // the hub restarts
	for _, id := range []string{"kept", "gone", "ended"} {
		if run, _ := s.runs.Get(id); run.Status != "running" {
			t.Fatalf("%s after the restart: %q, want it still running", id, run.Status)
		}
	}
	if run, _ := s.runs.Get("waiting"); run.Status != "lost" {
		t.Fatalf("a queued run after the restart: %q, want lost (its command is gone)", run.Status)
	}
	s.reconcileRuns("other", nil)
	if run, _ := s.runs.Get("gone"); run.Status != "running" {
		t.Fatalf("another machine's hello closed the run: %q", run.Status)
	}
	s.reconcileRuns("m1", []string{"kept"})
	want := map[string]string{"kept": "running", "gone": "lost", "ended": "lost", "done": "done"}
	for id, st := range want {
		if run, _ := s.runs.Get(id); run.Status != st {
			t.Errorf("%s after hello: %q, want %q", id, run.Status, st)
		}
	}

	// The run that ended while the hub was away: its exit arrives after the hello.
	exit, _ := json.Marshal(map[string]any{"stopped": false})
	s.applyRunEvent("m1", inEvent{RunID: "ended", T: "exit", TS: 1, Data: exit})
	if run, _ := s.runs.Get("ended"); run.Status != "done" || run.Error != "" {
		t.Errorf("late exit: %q %q, want done", run.Status, run.Error)
	}
	// Nothing else reopens a closed run.
	s.applyRunEvent("m1", inEvent{RunID: "gone", T: "agent", TS: 2, Data: json.RawMessage(`{"type":"assistant"}`)})
	s.applyRunEvent("m1", inEvent{RunID: "done", T: "exit", TS: 3, Data: json.RawMessage(`{"error":"x"}`)})
	if a, _ := s.runs.Get("gone"); a.Status != "lost" {
		t.Errorf("a late event reopened a lost run: %q", a.Status)
	}
	if a, _ := s.runs.Get("done"); a.Status != "done" {
		t.Errorf("a finished run changed: %q", a.Status)
	}
	// The kept run is still the session's running one, so a second send is refused upstream.
	if busy := s.runs.List(func(x *Run) bool { return x.SessionID == "s-kept" && !terminal(x.Status) }); len(busy) != 1 {
		t.Errorf("busy runs of the kept session: %d", len(busy))
	}
}
