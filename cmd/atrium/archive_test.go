package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The list keeps every conversation of its own, including those the archive
// files as subagents only because their prompts came through the SDK.
func TestSessionsList(t *testing.T) {
	var asked string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.RawQuery
		json.NewEncoder(w).Encode(map[string]any{"sessions": []map[string]any{
			{"id": "plain", "agent": "claude"},
			{"id": "from-atrium", "agent": "claude", "relationship_type": "subagent"}, // SDK prompts, no parent
			{"id": "agent-a1", "agent": "claude", "relationship_type": "subagent", "parent_session_id": "plain"},
			{"id": "after-compact", "agent": "claude", "relationship_type": "continuation", "parent_session_id": "plain"},
			{"id": "branch", "agent": "claude", "relationship_type": "fork", "parent_session_id": "plain"},
		}})
	}))
	defer srv.Close()
	list, _, err := newArchive(srv.URL, "").Sessions(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, s := range list {
		got = append(got, s.ID)
	}
	if want := []string{"plain", "from-atrium", "after-compact"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("listed %v, want %v", got, want)
	}
	if want := "limit=200&include_one_shot=true&include_children=true"; asked != want {
		t.Fatalf("asked the archive for %q", asked)
	}
}
