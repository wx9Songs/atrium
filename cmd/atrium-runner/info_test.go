package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func obj(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestSlimContext(t *testing.T) {
	c := slimContext(obj(t, `{"categories":[{"id":"system_prompt","name":"System prompt","tokens":3283,"color":"x","kind":"used"},
		{"id":"messages","name":"Messages","tokens":9359,"kind":"used"},{"id":"free_space","name":"Free space","tokens":941610,"kind":"free"}],
		"totalTokens":25390,"maxTokens":1000000,"percentage":3,"model":"claude-x","gridRows":[[{"a":1}]],
		"mcpTools":[{"name":"mcp__a__x","serverName":"a","tokens":100,"isLoaded":false},{"name":"mcp__a__y","serverName":"a","tokens":50,"isLoaded":true},{"name":"mcp__b__z","serverName":"b","tokens":7,"isLoaded":false}],
		"skills":{"totalSkills":27,"includedSkills":27,"tokens":5373},"memoryFiles":[{"path":"/p/CLAUDE.md","type":"Project","tokens":80}]}`))
	b, _ := json.Marshal(c)
	got := obj(t, string(b))
	if got["used"] != 25390.0 || got["max"] != 1000000.0 || got["percent"] != 3.0 || got["model"] != "claude-x" || got["gridRows"] != nil {
		t.Fatalf("figures: %s", b)
	}
	if cats := got["categories"].([]any); len(cats) != 3 || cats[1].(map[string]any)["id"] != "messages" || cats[1].(map[string]any)["color"] != nil {
		t.Fatalf("categories: %s", b)
	}
	tools := got["mcp_tools"].([]any)
	if a := tools[0].(map[string]any); len(tools) != 2 || a["server"] != "a" || a["tools"] != 2.0 || a["loaded"] != 1.0 || a["tokens"] != 150.0 {
		t.Fatalf("mcp tools: %s", b)
	}
	if slimContext(obj(t, `{"totalTokens":5}`)) != nil || slimContext(nil) != nil {
		t.Fatal("an answer without categories is no reading")
	}
}

func TestTaskBook(t *testing.T) {
	var tb taskBook
	ev := func(s string) bool { return tb.apply(obj(t, s)) }
	if ev(`{"subtype":"task_started","task_id":"fg","description":"a sub-agent","is_backgrounded":false,"task_type":"local_agent"}`) || len(tb.list()) != 0 {
		t.Fatal("a foreground task is not listed")
	}
	ev(`{"subtype":"background_tasks_changed","tasks":[{"task_id":"b1","task_type":"local_bash","description":"npm run dev"}]}`)
	ev(`{"subtype":"task_started","task_id":"b1","description":"npm run dev","is_backgrounded":true,"task_type":"local_bash"}`)
	ev(`{"subtype":"background_tasks_changed","tasks":[{"task_id":"b1","task_type":"local_bash","description":"npm run dev"},{"task_id":"b2","task_type":"monitor","description":"watch"}]}`)
	if l := tb.list(); len(l) != 2 || tb.running() != 2 || l[0].ID != "b1" || l[0].Status != "running" || l[1].Type != "monitor" {
		t.Fatalf("two running: %+v", l)
	}
	ev(`{"subtype":"task_updated","task_id":"b1","patch":{"status":"completed","end_time":1794671115109}}`)
	ev(`{"subtype":"task_notification","task_id":"b1","status":"completed","summary":"Background command \"npm run dev\" completed (exit code 0)"}`)
	ev(`{"subtype":"background_tasks_changed","tasks":[{"task_id":"b2","task_type":"monitor","description":"watch"}]}`)
	if l := tb.list(); tb.running() != 1 || l[0].Status != "completed" || l[0].Ended != 1794671115109 || l[0].Summary == "" || l[1].Status != "running" {
		t.Fatalf("one ended: %+v", l)
	}
	// A task that vanishes from the list without a word has ended.
	ev(`{"subtype":"background_tasks_changed","tasks":[]}`)
	if l := tb.list(); tb.running() != 0 || l[1].Status != "completed" || l[1].Ended == 0 {
		t.Fatalf("all ended: %+v", l)
	}
	if ev(`{"subtype":"task_updated","task_id":"unknown","patch":{"status":"completed"}}`) || ev(`{"subtype":"other"}`) {
		t.Fatal("nothing changed")
	}
}

func TestCodexSessionInfo(t *testing.T) {
	p := filepath.Join(t.TempDir(), "rollout.jsonl")
	os.WriteFile(p, []byte(`{"type":"session_meta","payload":{"id":"x"}}
{"type":"turn_context","payload":{"model":"gpt-x","effort":"high","approval_policy":"never","sandbox_policy":{"type":"read-only"}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9000,"cached_input_tokens":4000,"output_tokens":300,"reasoning_output_tokens":100,"total_tokens":9300},"last_token_usage":{"input_tokens":5000,"output_tokens":200,"total_tokens":5200},"model_context_window":258400}}}
{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{}}}
`), 0o644)
	b, _ := json.Marshal(codexSessionInfo(p))
	got := obj(t, string(b))
	c := got["context"].(map[string]any)
	if c["used"] != 5200.0 || c["max"] != 258400.0 || c["percent"] != 2.0 || c["model"] != "gpt-x" || len(c["categories"].([]any)) != 2 {
		t.Fatalf("context: %s", b)
	}
	if s := got["session"].(map[string]any); s["effort"] != "high" || s["sandbox"] != "read-only" || s["approval"] != "never" {
		t.Fatalf("session: %s", b)
	}
	if tot := got["totals"].(map[string]any); tot["input"] != 9000.0 || tot["cached"] != 4000.0 || tot["reasoning"] != 100.0 {
		t.Fatalf("totals: %s", b)
	}
	os.WriteFile(p, []byte(`{"type":"session_meta","payload":{"id":"x"}}`+"\n"), 0o644)
	if codexSessionInfo(p) != nil {
		t.Fatal("a file without figures has no info")
	}
}

// Against the real Claude CLI, on a session of this machine:
//
//	ATRIUM_REAL_SESSION=<session id> go test ./cmd/atrium-runner -run TestRealSessionInfo -v
func TestRealSessionInfo(t *testing.T) {
	id := os.Getenv("ATRIUM_REAL_SESSION")
	if id == "" {
		t.Skip("set ATRIUM_REAL_SESSION to a Claude session id to run this")
	}
	home, _ := os.UserHomeDir()
	r := &Runner{home: home}
	data, err := r.sessionInfo("claude", id)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(data)
	got := obj(t, string(b))
	c, _ := got["context"].(map[string]any)
	if c == nil || c["used"].(float64) <= 0 || c["max"].(float64) <= 0 || len(c["categories"].([]any)) < 3 {
		t.Fatalf("context: %s", b)
	}
	if s, _ := got["session"].(map[string]any); s == nil || s["model"] == "" {
		t.Fatalf("session: %s", b)
	}
	t.Logf("used %v of %v (%v%%), model %v, %d mcp servers", c["used"], c["max"], c["percent"], c["model"], len(got["mcp"].([]any)))
	// The second question is answered from memory while the transcript has not changed.
	if again, err := r.sessionInfo("claude", id); err != nil || again.(map[string]any)["at"] != data.(map[string]any)["at"] {
		t.Fatalf("not cached: %v", err)
	}
}

// Against a real Codex session file: ATRIUM_REAL_CODEX=<rollout file> go test ./cmd/atrium-runner -run TestRealCodexInfo -v
func TestRealCodexInfo(t *testing.T) {
	p := os.Getenv("ATRIUM_REAL_CODEX")
	if p == "" {
		t.Skip("set ATRIUM_REAL_CODEX to a rollout file to run this")
	}
	b, _ := json.Marshal(codexSessionInfo(p))
	got := obj(t, string(b))
	c, _ := got["context"].(map[string]any)
	if c == nil || c["used"].(float64) <= 0 || c["max"].(float64) <= 0 {
		t.Fatalf("context: %s", b)
	}
	t.Logf("%s", b)
}

// Where a background command writes its output comes from the result of the
// call that started it (or, at the end, from the CLI's notice), and the page
// can read the end of it.
func TestTaskOutput(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "tasks", "b1.output")
	os.MkdirAll(filepath.Dir(out), 0o700)
	os.WriteFile(out, []byte("line 1\nline 2\n"), 0o600)
	var tb taskBook
	tb.apply(map[string]any{"subtype": "task_started", "task_id": "b1", "tool_use_id": "tu1", "is_backgrounded": true, "task_type": "local_bash", "description": "loop"})
	if tb.list()[0].Output {
		t.Fatal("no output file known yet")
	}
	if !tb.noteResult("tu1", "Command running in background with ID: b1. Output is being written to: "+out+". You will be notified when it completes.") {
		t.Fatal("the tool result names the file")
	}
	if l := tb.list(); !l[0].Output {
		t.Fatalf("listed: %+v", l)
	}
	got, err := taskOutput("b1")
	if err != nil || got["text"] != "line 1\nline 2\n" || got["cut"] != false {
		t.Fatalf("output: %v %v", got, err)
	}
	// A result that came before the task was announced.
	var tb2 taskBook
	tb2.noteResult("tu2", "Output is being written to: "+filepath.Join(dir, "tasks", "b2.output")+".")
	tb2.apply(map[string]any{"subtype": "task_started", "task_id": "b2", "tool_use_id": "tu2", "is_backgrounded": true})
	if !tb2.list()[0].Output {
		t.Fatal("matched the earlier result")
	}
	// A long output: only its end, from a whole line.
	big := strings.Repeat("0123456789abcdef\n", 6000)
	os.WriteFile(out, []byte(big+"last\n"), 0o600)
	got, _ = taskOutput("b1")
	if s := got["text"].(string); got["cut"] != true || len(s) > 64<<10 || !strings.HasSuffix(s, "last\n") || !strings.HasPrefix(s, "0123") {
		t.Fatalf("long output: cut %v, %d bytes, starts %q", got["cut"], len(s), s[:10])
	}
	if _, err := taskOutput("nope"); err == nil {
		t.Fatal("an unknown task")
	}
}
