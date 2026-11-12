//go:build unix

package main

import (
	"os"
	"path/filepath"
	"testing"
)

const transcript = `{"type":"queue-operation","timestamp":"2026-01-01T10:00:00.000Z"}
{"type":"user","uuid":"u1","timestamp":"2026-01-01T10:00:01.000Z","isSidechain":false,"message":{"role":"user","content":"first question"}}
{"type":"attachment","uuid":"x1","timestamp":"2026-01-01T10:00:01.000Z","isSidechain":false}
{"type":"assistant","uuid":"a1","timestamp":"2026-01-01T10:00:02.000Z","isSidechain":false,"message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}
{"type":"user","uuid":"r1","timestamp":"2026-01-01T10:00:03.000Z","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}
{"type":"assistant","uuid":"side","timestamp":"2026-01-01T10:00:03.500Z","isSidechain":true,"message":{"content":[{"type":"text","text":"sub-agent"}]}}
{"type":"assistant","uuid":"a2","timestamp":"2026-01-01T10:00:04.000Z","isSidechain":false,"message":{"content":[{"type":"text","text":"answer one"}]}}
{"type":"user","uuid":"u2","timestamp":"2026-01-01T10:05:00.123Z","isSidechain":false,"message":{"role":"user","content":[{"type":"text","text":"second   question\nwith two lines"}]}}
{"type":"assistant","uuid":"a3","timestamp":"2026-01-01T10:05:02.000Z","isSidechain":false,"message":{"content":[{"type":"text","text":"answer two"}]}}
{"type":"user","uuid":"u3","timestamp":"2026-01-01T10:09:00.000Z","isSidechain":false,"message":{"role":"user","content":"first question"}}
{"type":"assistant","uuid":"a4","timestamp":"2026-01-01T10:09:02.000Z","isSidechain":false,"message":{"content":[{"type":"text","text":"answer three"}]}}
`

func TestClaudeCut(t *testing.T) {
	file := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(file, []byte(transcript), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, ts, text string
		want           string
		found          bool
	}{
		{"by time", "2026-01-01T10:05:00.123Z", "", "a2", true},
		{"by time, other zone spelling", "2026-01-01T18:05:00.123+08:00", "", "a2", true},
		{"by text when the time is off", "2026-01-01T10:05:09Z", "second question with two lines", "a2", true},
		{"same text twice: the later one", "", "first question", "a3", true},
		{"same text twice, time picks the first", "2026-01-01T10:00:01Z", "first question", "", true},
		{"tool results are not prompts", "2026-01-01T10:00:03Z", "", "", false},
		{"unknown", "2026-02-02T00:00:00Z", "never said", "", false},
	}
	for _, c := range cases {
		got, found := claudeCut(file, c.ts, c.text)
		if got != c.want || found != c.found {
			t.Errorf("%s: got (%q, %v), want (%q, %v)", c.name, got, found, c.want, c.found)
		}
	}
}

func TestClaudeCaps(t *testing.T) {
	caps := claudeCaps(map[string]any{
		"commands": []any{
			map[string]any{"name": "compact", "description": "Clear history", "argumentHint": "[notes]"},
			map[string]any{"name": "__internal", "description": "hidden"},
		},
		"models":  []any{map[string]any{"value": "opus", "displayName": "Opus", "description": "big"}},
		"account": map[string]any{"email": "someone@example.com"},
	})
	if cmds := caps["commands"].([]any); len(cmds) != 1 || cmds[0].(map[string]any)["hint"] != "[notes]" {
		t.Errorf("commands: %v", caps["commands"])
	}
	if _, leaked := caps["account"]; leaked {
		t.Error("account details must not be forwarded")
	}
}
