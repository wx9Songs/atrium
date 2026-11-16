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
// first line: what is asked, and how to answer by writing back.
func askText(p *PermReq, zh, canReply bool) string {
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
		if canReply {
			b.WriteString("\n" + pick("回复选项的编号，或者直接写你的回答", "Reply with the number of an option, or write your own answer"))
			if len(qs) > 1 {
				b.WriteString(pick("；每个问题一行", ", one line per question"))
			}
			b.WriteString(pick("。回复 0 跳过。", ". Reply 0 to skip."))
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
	if canReply {
		b.WriteString("\n" + pick("回复 1 允许，2 拒绝", "Reply 1 to allow, 2 to deny"))
		if canAlways(p) {
			b.WriteString(pick("，3 以后都允许", ", 3 to always allow"))
		}
	}
	return b.String()
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

func (n *notifier) forget(request string) {
	n.mu.Lock()
	defer n.mu.Unlock()
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

// reply takes what was written back and answers the latest waiting request with it.
func (s *Server) reply(text string) {
	n := s.notify
	zh := n.conf.Lang == "zh"
	pick := func(z, e string) string {
		if zh {
			return z
		}
		return e
	}
	say := func(head string, run *Run) {
		x := note{Kind: "reply", Head: head, Text: head}
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
	run, ok := s.waiting()
	if !ok {
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
// a JSON object with "text" (and "id", to tell a repeated delivery), as a reply.
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
					ID   string `json:"id"`
					Text string `json:"text"`
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
				s.reply(m.Text)
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
