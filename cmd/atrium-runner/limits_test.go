package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func windowsOf(t *testing.T, lim map[string]any) []window {
	t.Helper()
	if lim == nil {
		t.Fatal("no limits read")
	}
	wins, _ := lim["windows"].([]window)
	return wins
}

func TestClaudeLimits(t *testing.T) {
	// The shape Claude Code 2.1 prints with every turn.
	var ev map[string]any
	json.Unmarshal([]byte(`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1900000000,"rateLimitType":"five_hour",
		"unifiedWindows":{"five_hour":{"utilization":0.46,"resetsAt":1900000000},"seven_day":{"utilization":0.2,"resetsAt":1900300000}}}}`), &ev)
	lim := claudeLimits(ev["rate_limit_info"].(map[string]any))
	wins := windowsOf(t, lim)
	if len(wins) != 2 || wins[0] != (window{ID: "five_hour", Minutes: 300, Used: 46, Resets: 1900000000000}) || wins[1] != (window{ID: "seven_day", Minutes: 10080, Used: 20, Resets: 1900300000000}) {
		t.Fatalf("windows = %+v", wins)
	}
	if lim["status"] != "allowed" {
		t.Fatalf("status = %v", lim["status"])
	}

	// An older CLI names one window only.
	json.Unmarshal([]byte(`{"rate_limit_info":{"status":"allowed_warning","resetsAt":1900000000,"rateLimitType":"seven_day","utilization":0.913}}`), &ev)
	wins = windowsOf(t, claudeLimits(ev["rate_limit_info"].(map[string]any)))
	if len(wins) != 1 || wins[0] != (window{ID: "seven_day", Minutes: 10080, Used: 91.3, Resets: 1900000000000}) {
		t.Fatalf("single window = %+v", wins)
	}

	// Nothing to show: no figure at all.
	json.Unmarshal([]byte(`{"rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"}}`), &ev)
	if lim := claudeLimits(ev["rate_limit_info"].(map[string]any)); lim != nil {
		t.Fatalf("limits without a figure = %v", lim)
	}
	if claudeLimits(nil) != nil {
		t.Fatal("limits from nothing")
	}
}

func TestCodexLimits(t *testing.T) {
	home := t.TempDir()
	day := filepath.Join(home, "sessions", "2030", "01", "02")
	os.MkdirAll(day, 0o755)
	write := func(name string, age time.Duration, lines ...string) {
		p := filepath.Join(day, name)
		body := ""
		for _, l := range lines {
			body += l + "\n"
		}
		os.WriteFile(p, []byte(body), 0o644)
		at := time.Now().Add(-age)
		os.Chtimes(p, at, at)
	}
	meta := `{"type":"session_meta","payload":{"id":"x"}}`
	// An earlier session with both windows, a later one with the weekly window only, and the newest file with no reading at all.
	write("rollout-a.jsonl", 3*time.Hour, meta,
		`{"timestamp":"2030-01-02T03:00:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":12.0,"window_minutes":300,"resets_at":1900000000},"secondary":{"used_percent":40.0,"window_minutes":10080,"resets_at":1900300000},"plan_type":"plus"}}}`)
	write("rollout-b.jsonl", 2*time.Hour, meta,
		`{"timestamp":"2030-01-02T04:00:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":1.0,"window_minutes":10080,"resets_at":1900300000},"secondary":null,"plan_type":"plus"}}}`,
		`{"timestamp":"2030-01-02T04:10:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":3.0,"window_minutes":10080,"resets_in_seconds":600},"secondary":null,"plan_type":"plus"}}}`)
	write("rollout-c.jsonl", time.Hour, meta)

	lim := codexLimits([]string{filepath.Join(home, "missing"), home})
	wins := windowsOf(t, lim)
	at := time.Date(2030, 1, 2, 4, 10, 0, 0, time.UTC).UnixMilli()
	if len(wins) != 1 || wins[0] != (window{ID: "seven_day", Minutes: 10080, Used: 3, Resets: at + 600_000}) {
		t.Fatalf("windows = %+v", wins)
	}
	if lim["plan"] != "plus" || lim["at"] != at {
		t.Fatalf("plan %v at %v", lim["plan"], lim["at"])
	}

	wins = windowsOf(t, codexLimitsIn(filepath.Join(day, "rollout-a.jsonl")))
	if len(wins) != 2 || wins[0].ID != "five_hour" || wins[0].Used != 12 || wins[1].ID != "seven_day" || wins[1].Used != 40 {
		t.Fatalf("two windows = %+v", wins)
	}

	// A file nobody has touched for weeks cannot hold a current reading.
	old := time.Now().Add(-30 * 24 * time.Hour)
	for _, n := range []string{"rollout-a.jsonl", "rollout-b.jsonl"} {
		os.Chtimes(filepath.Join(day, n), old, old)
	}
	if lim := codexLimits([]string{home}); lim != nil {
		t.Fatalf("limits from stale files = %v", lim)
	}
}
