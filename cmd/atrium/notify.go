package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Notifications for when nobody is looking at the page: the hub runs a command
// of your choosing (a chat tool's CLI, curl to a push service) when a run needs
// your OK, finishes or fails. See "notify" in the README.

type NotifyConf struct {
	// Command is run without a shell, once per notification. In every argument
	// {text} {head} {title} {detail} {kind} {machine} {url} are replaced; the same
	// values are in the environment as ATRIUM_TEXT and so on, and {text} is also
	// on the command's standard input.
	Command []string `json:"command"`
	// On lists what to tell about: "permission", "done", "error". Empty means all.
	On []string `json:"on,omitempty"`
	// URL is the address of the page as your phone reaches it. With it the
	// message ends in a link to the session.
	URL string `json:"url,omitempty"`
	// Lang is the language of the message: "zh" or "en" (the default).
	Lang string `json:"lang,omitempty"`
	// Replies is a command that keeps running and prints what you write back,
	// one JSON object per line: {"text": "1"}. With it a permission request or a
	// question can be answered from where the notification arrived (see reply.go).
	Replies []string `json:"replies,omitempty"`
	// Always sends also while a page is open in front of you.
	Always bool `json:"always,omitempty"`
}

type note struct {
	Kind, Head, Title, Detail, Machine, URL, Text string
}

// A page counts as watched for this long after it last said so; it says so
// every 30 seconds while it is in front and in use.
const watchTTL = 75 * time.Second

type notifier struct {
	conf *NotifyConf
	q    chan note

	mu       sync.Mutex
	watching map[string]time.Time // page id → when it last said it is being watched
	asked    []asked              // permission requests told about, oldest first
}

func newNotifier(conf *NotifyConf) *notifier {
	n := &notifier{conf: conf, watching: map[string]time.Time{}}
	if n.on() {
		n.q = make(chan note, 32)
		go func() {
			for x := range n.q {
				if out, err := n.run(x); err != nil {
					log.Printf("notify: %v: %s", err, clip(out, 300))
				}
			}
		}()
	}
	return n
}

func (n *notifier) on() bool { return n.conf != nil && len(n.conf.Command) > 0 }

func (n *notifier) wants(kind string) bool {
	if !n.on() {
		return false
	}
	if len(n.conf.On) == 0 {
		return true
	}
	for _, k := range n.conf.On {
		if k == kind {
			return true
		}
	}
	return false
}

func (n *notifier) seen(page string, watching bool) {
	if page == "" || len(page) > 64 {
		return
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if !watching {
		delete(n.watching, page)
		return
	}
	if len(n.watching) >= 64 && n.watching[page].IsZero() {
		return
	}
	n.watching[page] = time.Now()
}

func (n *notifier) watched() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	for id, at := range n.watching {
		if time.Since(at) < watchTTL {
			return true
		}
		delete(n.watching, id)
	}
	return false
}

func (n *notifier) send(x note) {
	select {
	case n.q <- x:
	default:
		log.Printf("notify: too many waiting, dropped %q", x.Head)
	}
}

// run runs the command for one notification and returns what it printed.
func (n *notifier) run(x note) (string, error) {
	vals := []string{"{text}", x.Text, "{head}", x.Head, "{title}", x.Title, "{detail}", x.Detail,
		"{kind}", x.Kind, "{machine}", x.Machine, "{url}", x.URL}
	rep := strings.NewReplacer(vals...)
	args := make([]string, len(n.conf.Command))
	for i, a := range n.conf.Command {
		args[i] = rep.Replace(a)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Env = os.Environ()
	for i := 0; i < len(vals); i += 2 {
		cmd.Env = append(cmd.Env, "ATRIUM_"+strings.ToUpper(strings.Trim(vals[i], "{}"))+"="+vals[i+1])
	}
	cmd.Stdin = strings.NewReader(x.Text)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return out.String(), err
}

func (s *Server) handlePresence(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID       string `json:"id"`
		Watching bool   `json:"watching"`
	}
	if err := readJSON(r, &body, 1<<10); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	s.notify.seen(body.ID, body.Watching)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// attention sends a notification when a run changed into something worth one:
// it waits for a permission, it has answered, or it failed.
func (s *Server) attention(prev, next Run) {
	kind := ""
	switch {
	case next.Status == "permission" && prev.Status != "permission":
		kind = "permission"
	case terminal(next.Status) && !terminal(prev.Status):
		switch {
		case next.Status == "error" || next.Status == "lost":
			kind = "error"
		case next.Status == "done" && !prev.Background: // one in the background was told about when it answered
			kind = "done"
		}
	case next.Background && !prev.Background:
		kind = "done"
	}
	n := s.notify
	if kind == "" || !n.wants(kind) || (!n.conf.Always && n.watched()) {
		return
	}
	if kind == "permission" && next.Perm != nil && len(n.conf.Replies) > 0 {
		n.ask(next.ID, next.Perm.RequestID)
	}
	n.send(s.noteFor(kind, next))
}

func (s *Server) noteFor(kind string, run Run) note {
	zh := s.notify.conf.Lang == "zh"
	pick := func(z, e string) string {
		if zh {
			return z
		}
		return e
	}
	x := note{Kind: kind, Machine: run.Machine}
	if l := s.cfg.Labels[run.Machine]; l != "" {
		x.Machine = l
	}
	switch kind {
	case "permission":
		x.Head = pick("需要你确认", "Needs your OK")
		if len(questionsOf(run.Perm)) > 0 {
			x.Head = pick("需要你回答", "Needs your answer")
		}
		x.Detail = askText(run.Perm, zh, len(s.notify.conf.Replies) > 0)
	case "done":
		x.Head = pick("已完成", "Done")
		x.Detail = s.lastReply(run.ID)
	default:
		x.Head = pick("运行出错", "Run failed")
		x.Detail = pick(run.ErrorZh, run.Error)
	}
	if kind != "permission" {
		x.Detail = clip(x.Detail, 300)
	}
	x.Title = s.meta.Get(run.SessionID).Title
	if x.Title == "" {
		x.Title = run.Title
	}
	if x.Title == "" && run.SessionID != "" {
		x.Title = s.arc.knownTitle(run.SessionID)
	}
	if x.Title == "" {
		x.Title = withoutAttachments(run.Prompt)
	}
	x.Title = clip(x.Title, 60)
	if base := trimSlash(s.notify.conf.URL); base != "" {
		x.URL = base + "/"
		if run.SessionID != "" {
			x.URL += "#/s/" + url.PathEscape(run.SessionID)
		}
	}
	x.Text = x.Head + " · " + x.Title + pick("（", " (") + x.Machine + pick("）", ")")
	if x.Detail != "" {
		x.Text += "\n" + x.Detail
	}
	if x.URL != "" {
		x.Text += "\n" + x.URL
	}
	return x
}

// lastReply is the agent's closing words in a run, for the message's second line.
func (s *Server) lastReply(runID string) string {
	evs, _ := s.runs.Events(runID, 0)
	for i := len(evs) - 1; i >= 0; i-- {
		if evs[i].T != "agent" {
			continue
		}
		var d struct {
			Type   string `json:"type"`
			Result string `json:"result"`
			Item   struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"item"`
		}
		if json.Unmarshal(evs[i].Data, &d) != nil {
			continue
		}
		if d.Type == "result" && d.Result != "" {
			return d.Result
		}
		if d.Type == "item.completed" && d.Item.Type == "agent_message" && d.Item.Text != "" {
			return d.Item.Text
		}
	}
	return ""
}
