package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Answering from where the notification arrived. With "replies" set in the
// notify config, a permission request or a question sent as a notification
// says how to answer it, and what you write back is taken as the answer to the
// latest one still waiting.

type asked struct{ run, request string }

type question struct {
	Question    string `json:"question"`
	MultiSelect bool   `json:"multiSelect"`
	Options     []struct {
		Label       string `json:"label"`
		Description string `json:"description"`
	} `json:"options"`
}

// questionsOf returns the questions of an AskUserQuestion request, nil for any other.
func questionsOf(p *PermReq) []question {
	if p == nil || p.ToolName != "AskUserQuestion" {
		return nil
	}
	var in struct {
		Questions []question `json:"questions"`
	}
	json.Unmarshal(p.Input, &in)
	return in.Questions
}

// askText is what a notification about a permission request says below its
// first line: what is asked.
func askText(p *PermReq, zh bool) string {
	pick := func(z, e string) string {
		if zh {
			return z
		}
		return e
	}
	if p == nil {
		return ""
	}
	var b strings.Builder
	if qs := questionsOf(p); len(qs) > 0 {
		for i, q := range qs {
			if i > 0 {
				b.WriteString("\n")
			}
			if len(qs) > 1 {
				fmt.Fprintf(&b, "%s%d: ", pick("问题 ", "Question "), i+1)
			}
			b.WriteString(clip(q.Question, 300))
			for j, o := range q.Options {
				fmt.Fprintf(&b, "\n  %d. %s", j+1, clip(o.Label, 80))
				if o.Description != "" {
					b.WriteString(" — " + clip(o.Description, 120))
				}
			}
		}
		return b.String()
	}
	b.WriteString(p.ToolName)
	var in struct {
		Command  string `json:"command"`
		FilePath string `json:"file_path"`
	}
	json.Unmarshal(p.Input, &in)
	switch {
	case in.Command != "":
		b.WriteString(": " + clip(in.Command, 400))
	case in.FilePath != "":
		b.WriteString(": " + in.FilePath)
	case p.Description != "":
		b.WriteString(": " + clip(p.Description, 300))
	}
	return b.String()
}

// replyHint says how to answer a request by writing back.
func replyHint(p *PermReq, zh bool) string {
	pick := func(z, e string) string {
		if zh {
			return z
		}
		return e
	}
	if qs := questionsOf(p); len(qs) > 0 {
		h := pick("回复选项的编号，或者直接写你的回答", "Reply with the number of an option, or write your own answer")
		if len(qs) > 1 {
			h += pick("；每个问题一行，或用分号隔开", ", one line per question or separated by semicolons")
		}
		return h + pick("。回复 0 跳过。", ". Reply 0 to skip.")
	}
	h := pick("回复 1 允许，2 拒绝", "Reply 1 to allow, 2 to deny")
	if canAlways(p) {
		h += pick("，3 以后都允许", ", 3 to always allow")
	}
	return h
}

// A choice is one ready answer to a request: what a button would say, and the
// reply that picks it.
type choice struct {
	Label string `json:"label"`
	Reply string `json:"reply"`
	Style string `json:"style,omitempty"` // "primary", "danger" or empty
}

// choicesOf lists the ready answers to a request, for a command that can show
// buttons. A question with several parts, or one that takes several options,
// has none: it is answered in writing.
func choicesOf(p *PermReq, zh bool) []choice {
	pick := func(z, e string) string {
		if zh {
			return z
		}
		return e
	}
	if qs := questionsOf(p); len(qs) > 0 {
		if len(qs) != 1 || qs[0].MultiSelect || len(qs[0].Options) > 8 {
			return nil
		}
		out := []choice{}
		for i, o := range qs[0].Options {
			out = append(out, choice{Label: clip(o.Label, 40), Reply: strconv.Itoa(i + 1)})
		}
		return append(out, choice{Label: pick("跳过", "Skip"), Reply: "0"})
	}
	out := []choice{{pick("允许", "Allow"), "1", "primary"}, {pick("拒绝", "Deny"), "2", "danger"}}
	if canAlways(p) {
		out = append(out, choice{Label: pick("以后都允许", "Always allow"), Reply: "3"})
	}
	return out
}

func canAlways(p *PermReq) bool {
	s := strings.TrimSpace(string(p.Suggestions))
	return s != "" && s != "null" && s != "[]"
}

// answerPermission sends the answer to a run's waiting permission request to its machine.
func (s *Server) answerPermission(run Run, requestID, behavior, message string, always bool, input json.RawMessage) error {
	if run.Perm == nil || run.Perm.RequestID != requestID {
		return bi("这个请求已经处理过了", "This request was already answered")
	}
	return s.mach.enqueue(run.Machine, map[string]any{
		"id": "c" + randToken(9), "type": "permission", "run_id": run.ID, "request_id": requestID,
		"behavior": behavior, "message": message, "always": always, "input": input,
	})
}

func (n *notifier) ask(run, request string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.asked = append(n.asked, asked{run, request})
	if len(n.asked) > 50 {
		n.asked = n.asked[len(n.asked)-50:]
	}
}

// waiting returns the latest request told about that still waits, and forgets
// the ones that do not.
func (s *Server) waiting() (Run, bool) {
	n := s.notify
	n.mu.Lock()
	defer n.mu.Unlock()
	for len(n.asked) > 0 {
		a := n.asked[len(n.asked)-1]
		if run, ok := s.runs.Get(a.run); ok && run.Perm != nil && run.Perm.RequestID == a.request {
			return run, true
		}
		n.asked = n.asked[:len(n.asked)-1]
	}
	return Run{}, false
}

func (n *notifier) wasAnswered(request string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, r := range n.answered {
		if r == request {
			return true
		}
	}
	return false
}

func (n *notifier) isAsked(request string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, a := range n.asked {
		if a.request == request {
			return true
		}
	}
	return false
}

func (n *notifier) forget(request string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.answered = append(n.answered, request)
	if len(n.answered) > 100 {
		n.answered = n.answered[len(n.answered)-100:]
	}
	for i, a := range n.asked {
		if a.request == request {
			n.asked = append(n.asked[:i], n.asked[i+1:]...)
			return
		}
	}
}

var replyWords = map[string]string{
	"1": "allow", "y": "allow", "yes": "allow", "ok": "allow", "allow": "allow", "允许": "allow", "好": "allow", "好的": "allow", "可以": "allow", "同意": "allow", "是": "allow",
	"2": "deny", "n": "deny", "no": "deny", "deny": "deny", "拒绝": "deny", "不": "deny", "不行": "deny", "不允许": "deny", "否": "deny",
	"3": "always", "always": "always", "总是": "always", "总是允许": "always", "以后都允许": "always", "一直允许": "always",
}

// reply takes what was written back and answers a waiting request with it: the
// one named (a button says which request it belongs to), else the latest.
func (s *Server) reply(text, request string) {
	n := s.notify
	zh := n.conf.Lang == "zh"
	pick := func(z, e string) string {
		if zh {
			return z
		}
		return e
	}
	answered := false
	say := func(head string, run *Run) {
		x := note{Kind: "reply", Head: head, Text: head, Request: request, OK: answered}
		if run != nil {
			full := s.noteFor("reply", *run)
			x.Title, x.Machine, x.URL = full.Title, full.Machine, full.URL
			x.Text = head + " · " + x.Title
		}
		n.send(x)
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	var run Run
	ok := false
	if request != "" {
		for _, x := range s.runs.List(func(x *Run) bool { return x.Perm != nil && x.Perm.RequestID == request }) {
			run, ok = x, n.isAsked(request)
		}
		if !ok {
			// One this hub answered a moment ago says so; one it never asked about
			// belongs to someone else (another hub behind the same bot).
			if n.wasAnswered(request) {
				say(pick("这个请求已经处理过了", "This request was already answered"), nil)
			}
			return
		}
	} else if run, ok = s.waiting(); !ok {
		say(pick("现在没有在等你确认的请求", "Nothing is waiting for your answer right now"), nil)
		return
	}
	p := run.Perm
	var err error
	done := ""
	if qs := questionsOf(p); len(qs) > 0 {
		if text == "0" {
			err = s.answerPermission(run, p.RequestID, "deny", "The user skipped this question.", false, nil)
			done = pick("已跳过", "Skipped")
		} else {
			lines := []string{text}
			if len(qs) > 1 {
				lines = strings.FieldsFunc(text, func(r rune) bool { return r == '\n' || r == ';' || r == '；' })
			}
			if len(lines) != len(qs) {
				say(fmt.Sprintf(pick("有 %d 个问题，请每个问题回复一行", "There are %d questions: reply with one line for each"), len(qs)), nil)
				return
			}
			answers := map[string]string{}
			for i, q := range qs {
				answers[q.Question] = pickOptions(q, strings.TrimSpace(lines[i]))
			}
			var obj map[string]any
			json.Unmarshal(p.Input, &obj)
			if obj == nil {
				obj = map[string]any{}
			}
			obj["answers"] = answers
			input, _ := json.Marshal(obj)
			err = s.answerPermission(run, p.RequestID, "allow", "", false, input)
			all := []string{}
			for _, q := range qs {
				all = append(all, answers[q.Question])
			}
			done = pick("已回答：", "Answered: ") + clip(strings.Join(all, " / "), 200)
		}
	} else {
		switch replyWords[strings.ToLower(strings.Trim(text, " .。!！"))] {
		case "allow":
			err = s.answerPermission(run, p.RequestID, "allow", "", false, nil)
			done = pick("已允许", "Allowed")
		case "always":
			err = s.answerPermission(run, p.RequestID, "allow", "", canAlways(p), nil)
			done = pick("已允许，以后同类操作不再询问", "Allowed, and not asked again for the like")
			if !canAlways(p) {
				done = pick("已允许（这个操作没有“以后都允许”）", `Allowed (there is no "always" for this one)`)
			}
		case "deny":
			err = s.answerPermission(run, p.RequestID, "deny", "The user denied this action from a notification.", false, nil)
			done = pick("已拒绝", "Denied")
		default:
			say(pick("没看懂。回复 1 允许，2 拒绝", "Not understood. Reply 1 to allow, 2 to deny"), &run)
			return
		}
	}
	if err != nil {
		zhMsg, en := both(err)
		say(pick("没能送达："+zhMsg, "Could not deliver: "+en), &run)
		return
	}
	n.forget(p.RequestID)
	answered = true
	say(done, &run)
}

// pickOptions turns "2" or "1,3" into the labels of those options; anything
// else is the answer as written.
func pickOptions(q question, text string) string {
	parts := strings.FieldsFunc(text, func(r rune) bool { return r == ',' || r == '，' || r == ' ' || r == '、' })
	labels := []string{}
	for _, p := range parts {
		i, err := strconv.Atoi(p)
		if err != nil || i < 1 || i > len(q.Options) {
			return text
		}
		labels = append(labels, q.Options[i-1].Label)
	}
	if len(labels) == 0 || (len(labels) > 1 && !q.MultiSelect) {
		return text
	}
	return strings.Join(labels, ", ")
}

// listen keeps the "replies" command running and takes each line it prints,
// a JSON object with "text" (and "id", to tell a repeated delivery; "request",
// when it answers one request in particular), as a reply.
func (s *Server) listen(ctx context.Context) {
	n := s.notify
	if !n.on() || len(n.conf.Replies) == 0 {
		return
	}
	seen := map[string]bool{}
	wait := 2 * time.Second
	for ctx.Err() == nil {
		started := time.Now()
		cmd := exec.CommandContext(ctx, n.conf.Replies[0], n.conf.Replies[1:]...)
		cmd.WaitDelay = 3 * time.Second
		out, err := cmd.StdoutPipe()
		if err == nil {
			err = cmd.Start()
		}
		if err == nil {
			sc := bufio.NewScanner(out)
			sc.Buffer(make([]byte, 64<<10), 1<<20)
			for sc.Scan() {
				var m struct {
					ID      string `json:"id"`
					Text    string `json:"text"`
					Request string `json:"request"`
				}
				if json.Unmarshal(sc.Bytes(), &m) != nil || m.Text == "" || (m.ID != "" && seen[m.ID]) {
					continue
				}
				if m.ID != "" {
					if len(seen) > 500 {
						seen = map[string]bool{}
					}
					seen[m.ID] = true
				}
				s.reply(m.Text, m.Request)
			}
			err = cmd.Wait()
		}
		if ctx.Err() != nil {
			return
		}
		log.Printf("notify: the replies command stopped (%v); starting it again", err)
		if time.Since(started) > time.Minute {
			wait = 2 * time.Second
		} else if wait < time.Minute {
			wait *= 2
		}
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
	}
}
