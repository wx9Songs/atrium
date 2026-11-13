//go:build unix

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
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
		got, _, found := claudeCut(file, c.ts, c.text)
		if got != c.want || found != c.found {
			t.Errorf("%s: got (%q, %v), want (%q, %v)", c.name, got, found, c.want, c.found)
		}
	}
}

// A session that was rewound once: "two" and "three" were said, then the
// second message was rewritten as "two again", which answers to a1 like "two" did.
const rewoundTranscript = `{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-01-01T10:00:01.000Z","message":{"role":"user","content":"one"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-01-01T10:00:02.000Z","message":{"content":[{"type":"text","text":"answer one"}]}}
{"type":"attachment","uuid":"x1","parentUuid":"a1","timestamp":"2026-01-01T10:00:02.500Z"}
{"type":"user","uuid":"u2","parentUuid":"x1","timestamp":"2026-01-01T10:01:00.000Z","message":{"role":"user","content":"two"}}
{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-01-01T10:01:02.000Z","message":{"content":[{"type":"text","text":"answer two"}]}}
{"type":"user","uuid":"u3","parentUuid":"a2","timestamp":"2026-01-01T10:02:00.000Z","message":{"role":"user","content":"three"}}
{"type":"assistant","uuid":"a3","parentUuid":"u3","timestamp":"2026-01-01T10:02:02.000Z","message":{"content":[{"type":"text","text":"answer three"}]}}
{"type":"user","uuid":"u4","parentUuid":"a1","timestamp":"2026-01-01T10:03:00.000Z","message":{"role":"user","content":"two again"}}
{"type":"assistant","uuid":"a4","parentUuid":"u4","timestamp":"2026-01-01T10:03:02.000Z","message":{"content":[{"type":"text","text":"answer two again"}]}}
{"type":"user","uuid":"u5","parentUuid":"a4","timestamp":"2026-01-01T10:04:00.000Z","message":{"role":"user","content":"four"}}
`

func TestClaudeCutFollowsTheBranch(t *testing.T) {
	file := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(file, []byte(rewoundTranscript), 0o600); err != nil {
		t.Fatal(err)
	}
	// Just above "two again" in the file is a3, on the branch that was left: the cut is a1.
	at, sent, found := claudeCut(file, "2026-01-01T10:03:00Z", "")
	if at != "a1" || !found || sent.UTC().Format("15:04:05") != "10:03:00" {
		t.Errorf("rewritten message: got (%q, %v, %v), want a1 at 10:03:00", at, sent, found)
	}
	if at, _, _ := claudeCut(file, "", "four"); at != "a4" {
		t.Errorf("message after the rewrite: got %q, want a4", at)
	}
	if at, _, _ := claudeCut(file, "", "two"); at != "a1" {
		t.Errorf("past an attachment: got %q, want a1", at)
	}
	if at, _, found := claudeCut(file, "", "one"); at != "" || !found {
		t.Errorf("first message: got (%q, %v), want (\"\", true)", at, found)
	}
}

func TestClaudeSignedIn(t *testing.T) {
	future := time.Now().Add(time.Hour).UnixMilli()
	past := time.Now().Add(-time.Hour).UnixMilli()
	cases := []struct {
		name, file string
		want       bool
	}{
		{"no file", "", false},
		{"a live sign-in", fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":%d}}`, past), true},
		{"tokens blanked after it lapsed", fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,"refreshTokenExpiresAt":%d}}`, past), false},
		{"refresh token expired", fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":%d,"refreshTokenExpiresAt":%d}}`, past, past), false},
		{"only an access token, still good", fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"a","expiresAt":%d}}`, future), true},
		{"other servers only", `{"mcpOAuth":{}}`, false},
		{"not JSON", `whatever`, true},
	}
	for _, c := range cases {
		dir := t.TempDir()
		if c.file != "" {
			os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(c.file), 0o600)
		}
		if got := claudeSignedIn(dir); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
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
