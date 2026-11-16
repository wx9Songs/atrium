package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// What is worth a notification, what it says, and that it waits while a page
// is being watched.
func TestAttention(t *testing.T) {
	dir := t.TempDir()
	cfg := &Config{DataDir: dir, Machines: map[string]*MachineConf{"m1": {}}, Labels: map[string]string{"m1": "Box"}}
	cfg.path = filepath.Join(dir, "config.json")
	s := newServer(cfg)
	n := &notifier{conf: &NotifyConf{Command: []string{"true"}, URL: "http://hub.example:3005/"}, q: make(chan note, 32), watching: map[string]time.Time{}}
	s.notify = n
	ev := func(id, t, data string) {
		s.applyRunEvent("m1", inEvent{RunID: id, T: t, TS: 1, Data: json.RawMessage(data)})
	}
	got := func() []string {
		out := []string{}
		for len(n.q) > 0 {
			x := <-n.q
			out = append(out, x.Kind+"|"+x.Text)
		}
		return out
	}
	want := func(what string, lines ...string) {
		t.Helper()
		g := got()
		if strings.Join(g, "\n\n") != strings.Join(lines, "\n\n") {
			t.Fatalf("%s:\n got %q\nwant %q", what, g, lines)
		}
	}

	s.runs.Create(Run{ID: "a", Machine: "m1", SessionID: "s1", Status: "running", Prompt: "fix the build\n\n[Attached files: read them at these paths]\n- /x/shot.png"})
	ev("a", "permission", `{"request_id":"r1","tool_name":"Bash","description":"rm -rf build"}`)
	want("a permission request", "permission|Needs your OK · fix the build (Box)\nBash: rm -rf build\nhttp://hub.example:3005/#/s/s1")
	ev("a", "permission_done", `{"request_id":"r1"}`)
	ev("a", "agent", `{"type":"result","result":"The build is green again."}`)
	want("working")
	ev("a", "exit", `{"stopped":false}`)
	want("done", "done|Done · fix the build (Box)\nThe build is green again.\nhttp://hub.example:3005/#/s/s1")

	// A run kept by background tasks: told when it has answered, each time, and not again when it ends.
	s.runs.Create(Run{ID: "b", Machine: "m1", SessionID: "s2", Status: "running", Title: "Deploy"})
	ev("b", "agent", `{"type":"result","result":"Started the server."}`)
	ev("b", "bg", `{"on":true}`)
	want("answered, tasks still running", "done|Done · Deploy (Box)\nStarted the server.\nhttp://hub.example:3005/#/s/s2")
	ev("b", "bg", `{"on":false}`)
	ev("b", "agent", `{"type":"result","result":"The server is up."}`)
	ev("b", "bg", `{"on":true}`)
	want("a task ended and it answered again", "done|Done · Deploy (Box)\nThe server is up.\nhttp://hub.example:3005/#/s/s2")
	ev("b", "exit", `{"stopped":false}`)
	want("the idle process closed")

	// Stopping is your own doing; a failure and a lost run are not.
	s.runs.Create(Run{ID: "c", Machine: "m1", SessionID: "s3", Status: "running", Title: "C"})
	ev("c", "exit", `{"stopped":true}`)
	want("stopped")
	s.runs.Create(Run{ID: "d", Machine: "m1", SessionID: "s4", Status: "running", Title: "D"})
	ev("d", "exit", `{"error":"claude exited unexpectedly","error_zh":"claude 意外退出"}`)
	want("failed", "error|Run failed · D (Box)\nclaude exited unexpectedly\nhttp://hub.example:3005/#/s/s4")
	s.runs.Create(Run{ID: "e", Machine: "m1", SessionID: "s5", Status: "running", Title: "E"})
	s.reconcileRuns("m1", nil)
	if g := got(); len(g) != 1 || !strings.HasPrefix(g[0], "error|Run failed · E (Box)\nThis run was interrupted") {
		t.Fatalf("lost: %q", g)
	}

	// Nothing while a page is in front of someone; again once it is not.
	n.seen("page1", true)
	s.runs.Create(Run{ID: "f", Machine: "m1", SessionID: "s6", Status: "running", Title: "F"})
	ev("f", "permission", `{"request_id":"r2","tool_name":"Edit"}`)
	want("watched")
	n.seen("page1", false)
	ev("f", "permission_done", `{}`)
	ev("f", "exit", `{}`)
	want("not watched any more", "done|Done · F (Box)\nhttp://hub.example:3005/#/s/s6")
	n.mu.Lock()
	n.watching["page2"] = time.Now().Add(-2 * watchTTL) // a page that went away without saying so
	n.mu.Unlock()
	if n.watched() {
		t.Fatal("a page long silent still counts as watched")
	}

	// Only the kinds asked for, in the language asked for.
	n.conf.On, n.conf.Lang = []string{"permission"}, "zh"
	s.runs.Create(Run{ID: "g", Machine: "m1", SessionID: "s7", Status: "running", Title: "G"})
	ev("g", "permission", `{"request_id":"r3","tool_name":"Bash"}`)
	ev("g", "exit", `{}`)
	want("only permissions", "permission|需要你确认 · G（Box）\nBash\nhttp://hub.example:3005/#/s/s7")
}

// The command gets the message in its arguments, its environment and on its input.
func TestNotifyCommand(t *testing.T) {
	out := filepath.Join(t.TempDir(), "out")
	n := &notifier{conf: &NotifyConf{Command: []string{"sh", "-c", `{ echo "$1"; echo "$ATRIUM_KIND $ATRIUM_MACHINE"; cat; } > "$0"`, out, "{head}: {title}"}}}
	x := note{Kind: "done", Head: "Done", Title: `it's "quoted" $HOME`, Machine: "Box", Text: "Done · x\nline two"}
	if o, err := n.run(x); err != nil {
		t.Fatalf("%v: %s", err, o)
	}
	b, _ := os.ReadFile(out)
	if want := "Done: it's \"quoted\" $HOME\ndone Box\nDone · x\nline two"; string(b) != want {
		t.Fatalf("got %q\nwant %q", b, want)
	}
}

// Writing back answers the latest request that still waits.
func TestReply(t *testing.T) {
	dir := t.TempDir()
	cfg := &Config{DataDir: dir, Machines: map[string]*MachineConf{"m1": {}}}
	cfg.path = filepath.Join(dir, "config.json")
	s := newServer(cfg)
	n := &notifier{conf: &NotifyConf{Command: []string{"true"}, Replies: []string{"true"}, Lang: "zh"}, q: make(chan note, 32), watching: map[string]time.Time{}}
	s.notify = n
	ev := func(id, t, data string) {
		s.applyRunEvent("m1", inEvent{RunID: id, T: t, TS: 1, Data: json.RawMessage(data)})
	}
	said := func() string {
		out := []string{}
		for len(n.q) > 0 {
			out = append(out, (<-n.q).Text)
		}
		return strings.Join(out, "\n--\n")
	}
	sentTo := func() []map[string]any {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()
		out := []map[string]any{}
		for _, raw := range s.mach.poll(ctx, "m1", 10*time.Millisecond) {
			var m map[string]any
			json.Unmarshal(raw, &m)
			out = append(out, m)
		}
		return out
	}
	one := func(what string) map[string]any {
		t.Helper()
		c := sentTo()
		if len(c) != 1 {
			t.Fatalf("%s: %d commands for the machine, want 1", what, len(c))
		}
		return c[0]
	}

	s.reply("1", "")
	if got := said(); got != "现在没有在等你确认的请求" {
		t.Fatalf("nothing waiting: %q", got)
	}

	s.runs.Create(Run{ID: "a", Machine: "m1", SessionID: "s1", Status: "running", Title: "Build"})
	ev("a", "permission", `{"request_id":"r1","tool_name":"Bash","input":{"command":"make  test"},"suggestions":[{"type":"addRules"}]}`)
	if got, want := said(), "需要你确认 · Build（m1）\nBash: make test\n回复 1 允许，2 拒绝，3 以后都允许"; got != want {
		t.Fatalf("asked:\n got %q\nwant %q", got, want)
	}
	s.reply("什么", "")
	if got := said(); !strings.HasPrefix(got, "没看懂") || len(sentTo()) != 0 {
		t.Fatalf("an unclear reply: %q", got)
	}
	s.reply(" 好的。", "")
	if c := one("allow"); c["behavior"] != "allow" || c["request_id"] != "r1" || c["run_id"] != "a" || c["always"] != false {
		t.Fatalf("allow: %v", c)
	}
	if got := said(); got != "已允许 · Build" {
		t.Fatalf("after allowing: %q", got)
	}
	s.reply("1", "") // the same request is not answered twice
	if got := said(); got != "现在没有在等你确认的请求" || len(sentTo()) != 0 {
		t.Fatalf("a second reply: %q", got)
	}
	ev("a", "permission_done", `{"request_id":"r1"}`)

	// Two wait: the later one is answered first, then the earlier.
	ev("a", "permission", `{"request_id":"r2","tool_name":"Edit","input":{"file_path":"/x/a.go"}}`)
	s.runs.Create(Run{ID: "b", Machine: "m1", SessionID: "s2", Status: "running", Title: "Docs"})
	ev("b", "permission", `{"request_id":"r3","tool_name":"Bash","input":{"command":"rm -rf /"},"suggestions":[{"type":"addRules"}]}`)
	said()
	s.reply("2", "")
	if c := one("deny"); c["behavior"] != "deny" || c["request_id"] != "r3" {
		t.Fatalf("deny: %v", c)
	}
	ev("b", "permission_done", `{"request_id":"r3"}`)
	s.reply("3", "") // no "always" on offer for this one
	if c := one("always"); c["behavior"] != "allow" || c["request_id"] != "r2" || c["always"] != false {
		t.Fatalf("always without suggestions: %v", c)
	}
	ev("a", "permission_done", `{"request_id":"r2"}`)
	said()

	// A question: options by number, or an answer in your own words.
	q := `{"request_id":"%s","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which database?","options":[{"label":"Postgres","description":"what we run"},{"label":"SQLite"}]},{"question":"Which parts?","multiSelect":true,"options":[{"label":"API"},{"label":"Page"},{"label":"Docs"}]}]}}`
	ev("a", "permission", strings.Replace(q, "%s", "q1", 1))
	want := "需要你回答 · Build（m1）\n问题 1: Which database?\n  1. Postgres — what we run\n  2. SQLite\n问题 2: Which parts?\n  1. API\n  2. Page\n  3. Docs\n回复选项的编号，或者直接写你的回答；每个问题一行，或用分号隔开。回复 0 跳过。"
	if got := said(); got != want {
		t.Fatalf("a question:\n got %q\nwant %q", got, want)
	}
	s.reply("2", "")
	if got := said(); !strings.HasPrefix(got, "有 2 个问题") || len(sentTo()) != 0 {
		t.Fatalf("one line for two questions: %q", got)
	}
	s.reply("1\n1, 3", "")
	c := one("answers")
	in, _ := json.Marshal(c["input"])
	var got struct {
		Questions []any             `json:"questions"`
		Answers   map[string]string `json:"answers"`
	}
	json.Unmarshal(in, &got)
	if c["behavior"] != "allow" || len(got.Questions) != 2 || got.Answers["Which database?"] != "Postgres" || got.Answers["Which parts?"] != "API, Docs" {
		t.Fatalf("answers: %s", in)
	}
	if got := said(); got != "已回答：Postgres / API, Docs · Build" {
		t.Fatalf("after answering: %q", got)
	}
	ev("a", "permission_done", `{"request_id":"q1"}`)
	ev("a", "permission", strings.Replace(q, "%s", "q2", 1))
	s.reply("MySQL 吧\n9", "")
	in, _ = json.Marshal(one("own words")["input"])
	json.Unmarshal(in, &got)
	if got.Answers["Which database?"] != "MySQL 吧" || got.Answers["Which parts?"] != "9" {
		t.Fatalf("own words: %s", in)
	}
	ev("a", "permission_done", `{"request_id":"q2"}`)
	ev("a", "permission", strings.Replace(q, "%s", "q3", 1))
	s.reply("0", "")
	if c := one("skip"); c["behavior"] != "deny" || c["request_id"] != "q3" {
		t.Fatalf("skip: %v", c)
	}
}

// A button names the request it answers, whichever came last; pressed again it does nothing.
func TestReplyByButton(t *testing.T) {
	dir := t.TempDir()
	cfg := &Config{DataDir: dir, Machines: map[string]*MachineConf{"m1": {}}}
	cfg.path = filepath.Join(dir, "config.json")
	s := newServer(cfg)
	n := &notifier{conf: &NotifyConf{Command: []string{"true"}, Replies: []string{"true"}}, q: make(chan note, 32), watching: map[string]time.Time{}}
	s.notify = n
	ev := func(id, t, data string) {
		s.applyRunEvent("m1", inEvent{RunID: id, T: t, TS: 1, Data: json.RawMessage(data)})
	}
	cmds := func() []string {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()
		out := []string{}
		for _, raw := range s.mach.poll(ctx, "m1", 10*time.Millisecond) {
			var m map[string]any
			json.Unmarshal(raw, &m)
			out = append(out, m["request_id"].(string)+" "+m["behavior"].(string))
		}
		return out
	}
	s.runs.Create(Run{ID: "a", Machine: "m1", SessionID: "s1", Status: "running", Title: "A"})
	s.runs.Create(Run{ID: "b", Machine: "m1", SessionID: "s2", Status: "running", Title: "B"})
	ev("a", "permission", `{"request_id":"r1","tool_name":"Bash","input":{"command":"ls"},"suggestions":[{"type":"addRules"}]}`)
	ev("b", "permission", `{"request_id":"r2","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which?","options":[{"label":"Left"},{"label":"Right"}]}]}}`)
	first, second := <-n.q, <-n.q
	if b, _ := json.Marshal(first.Choices); first.Request != "r1" || string(b) != `[{"label":"Allow","reply":"1","style":"primary"},{"label":"Deny","reply":"2","style":"danger"},{"label":"Always allow","reply":"3"}]` {
		t.Fatalf("choices of a permission request: %s %s", first.Request, b)
	}
	if b, _ := json.Marshal(second.Choices); second.Request != "r2" || string(b) != `[{"label":"Left","reply":"1"},{"label":"Right","reply":"2"},{"label":"Skip","reply":"0"}]` {
		t.Fatalf("choices of a question: %s", b)
	}
	s.reply("1", "r1") // the earlier one, by its button
	if c := cmds(); len(c) != 1 || c[0] != "r1 allow" {
		t.Fatalf("a button of the earlier request: %v", c)
	}
	if x := <-n.q; x.Kind != "reply" || !x.OK || x.Request != "r1" || x.Text != "Allowed · A" {
		t.Fatalf("what became of it: %+v", x)
	}
	s.reply("2", "r1") // pressed again
	if x := <-n.q; x.OK || x.Text != "This request was already answered" || len(cmds()) != 0 {
		t.Fatalf("pressed again: %+v", x)
	}
	s.reply("1", "someone-elses") // a request this hub never asked about: not a word
	if len(n.q) != 0 || len(cmds()) != 0 {
		t.Fatal("answered a request that is not this hub's")
	}
	s.reply("2", "r2")
	if c := cmds(); len(c) != 1 || c[0] != "r2 allow" {
		t.Fatalf("an option of the question: %v", c)
	}
	if x := <-n.q; x.Text != "Answered: Right · B" {
		t.Fatalf("answered: %+v", x)
	}
}
