package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Archive is a read-only client for the session archive (agentsview).
// The archive already parses Claude Code and Codex transcripts from every
// machine, de-duplicates them and indexes them for full-text search.
type Archive struct {
	base  string
	token string
	hc    *http.Client

	mu      sync.Mutex // guards cache
	fetchMu sync.Mutex // one refresh at a time
	cache   []Session
	etag    string
	at      time.Time
}

func newArchive(base, token string) *Archive {
	return &Archive{base: strings.TrimRight(base, "/"), token: token, hc: &http.Client{Timeout: 40 * time.Second}}
}

func (a *Archive) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", a.base+path, nil)
	if err != nil {
		return err
	}
	if a.token != "" {
		req.Header.Set("Authorization", "Bearer "+a.token)
	}
	res, err := a.hc.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 300))
		return &archiveError{Status: res.StatusCode, Body: string(b)}
	}
	return json.NewDecoder(res.Body).Decode(out)
}

type archiveError struct {
	Status int
	Body   string
}

func (e *archiveError) Error() string { return fmt.Sprintf("archive: HTTP %d %s", e.Status, e.Body) }

// ---------- sessions ----------

type arcSession struct {
	ID               string `json:"id"`
	Machine          string `json:"machine"`
	Agent            string `json:"agent"`
	Entrypoint       string `json:"entrypoint"`
	FirstMessage     string `json:"first_message"`
	DisplayName      string `json:"display_name"`
	StartedAt        string `json:"started_at"`
	EndedAt          string `json:"ended_at"`
	MessageCount     int    `json:"message_count"`
	UserMessageCount int    `json:"user_message_count"`
	Cwd              string `json:"cwd"`
	GitBranch        string `json:"git_branch"`
	ParentSessionID  string `json:"parent_session_id"`
	SourceSessionID  string `json:"source_session_id"`
}

// Session is the slim record the web page works with.
type Session struct {
	ID       string `json:"id"`
	NativeID string `json:"nid"`
	Agent    string `json:"agent"`
	Machine  string `json:"machine"`
	Title    string `json:"title"`
	First    string `json:"first,omitempty"`
	Cwd      string `json:"cwd,omitempty"`
	Started  string `json:"started,omitempty"`
	Ended    string `json:"ended,omitempty"`
	N        int    `json:"n"`
	NU       int    `json:"nu"`
	Entry    string `json:"entry,omitempty"`
	Branch   string `json:"branch,omitempty"`
	Parent   string `json:"parent,omitempty"`
}

var wsRe = regexp.MustCompile(`\s+`)

func clip(s string, n int) string {
	s = strings.TrimSpace(wsRe.ReplaceAllString(s, " "))
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}

func slimSession(x arcSession) Session {
	title := strings.TrimSpace(x.DisplayName)
	if title == "" {
		title = clip(x.FirstMessage, 70)
	}
	if title == "" {
		title = "" // the page shows its own "untitled"
	}
	nid := x.SourceSessionID
	if nid == "" {
		nid = strings.TrimPrefix(x.ID, x.Agent+":")
	}
	return Session{
		ID: x.ID, NativeID: nid, Agent: x.Agent, Machine: x.Machine, Title: title,
		First: clip(x.FirstMessage, 160), Cwd: x.Cwd, Started: x.StartedAt, Ended: x.EndedAt,
		N: x.MessageCount, NU: x.UserMessageCount, Entry: x.Entrypoint, Branch: x.GitBranch,
		Parent: x.ParentSessionID,
	}
}

// Sessions returns every top-level session. The whole list is small for a
// single person (hundreds of rows), so the page filters and groups it locally.
func (a *Archive) Sessions(ctx context.Context, force bool) ([]Session, string, error) {
	a.mu.Lock()
	if !force && a.cache != nil && time.Since(a.at) < 4*time.Second {
		c, e := a.cache, a.etag
		a.mu.Unlock()
		return c, e, nil
	}
	a.mu.Unlock()

	a.fetchMu.Lock()
	defer a.fetchMu.Unlock()
	a.mu.Lock()
	if !force && a.cache != nil && time.Since(a.at) < 4*time.Second {
		c, e := a.cache, a.etag
		a.mu.Unlock()
		return c, e, nil
	}
	a.mu.Unlock()

	var all []Session
	cursor := ""
	for page := 0; page < 100; page++ {
		var res struct {
			Sessions   []arcSession `json:"sessions"`
			NextCursor string       `json:"next_cursor"`
		}
		p := "/api/v1/sessions?limit=200&include_one_shot=true"
		if cursor != "" {
			p += "&cursor=" + url.QueryEscape(cursor)
		}
		if err := a.get(ctx, p, &res); err != nil {
			a.mu.Lock()
			c, e := a.cache, a.etag
			a.mu.Unlock()
			if c != nil { // serve stale rather than nothing
				return c, e, nil
			}
			return nil, "", err
		}
		for _, x := range res.Sessions {
			all = append(all, slimSession(x))
		}
		if res.NextCursor == "" || len(res.Sessions) == 0 {
			break
		}
		cursor = res.NextCursor
	}
	if all == nil {
		all = []Session{}
	}
	b, _ := json.Marshal(all)
	h := sha256.Sum256(b)
	etag := hex.EncodeToString(h[:8])
	a.mu.Lock()
	a.cache, a.etag, a.at = all, etag, time.Now()
	a.mu.Unlock()
	return all, etag, nil
}

func (a *Archive) Find(ctx context.Context, id string) (Session, bool) {
	for _, force := range []bool{false, true} {
		list, _, err := a.Sessions(ctx, force)
		if err != nil {
			return Session{}, false
		}
		for _, s := range list {
			if s.ID == id {
				return s, true
			}
		}
	}
	return Session{}, false
}

// ---------- messages ----------

type arcTool struct {
	ToolName            string `json:"tool_name"`
	Category            string `json:"category"`
	ToolUseID           string `json:"tool_use_id"`
	InputJSON           string `json:"input_json"`
	ResultContent       string `json:"result_content"`
	ResultContentLength int    `json:"result_content_length"`
	ResultEvents        []struct {
		Status  string `json:"status"`
		Content string `json:"content"`
	} `json:"result_events"`
}

type arcMsg struct {
	Ordinal           int       `json:"ordinal"`
	Role              string    `json:"role"`
	Content           string    `json:"content"`
	ThinkingText      string    `json:"thinking_text"`
	Timestamp         string    `json:"timestamp"`
	HasToolUse        bool      `json:"has_tool_use"`
	Model             string    `json:"model"`
	IsSystem          bool      `json:"is_system"`
	SourceType        string    `json:"source_type"`
	IsSidechain       bool      `json:"is_sidechain"`
	IsCompactBoundary bool      `json:"is_compact_boundary"`
	ToolCalls         []arcTool `json:"tool_calls"`
}

type Tool struct {
	ID        string `json:"id,omitempty"`
	Name      string `json:"name"`
	Cat       string `json:"cat,omitempty"`
	Input     string `json:"input"`
	InputLen  int    `json:"inputLen,omitempty"`
	Result    string `json:"result,omitempty"`
	ResultLen int    `json:"resultLen,omitempty"`
	Status    string `json:"status,omitempty"`
}

type Msg struct {
	Ord      int    `json:"ord"`
	Role     string `json:"role"`
	Text     string `json:"text"`
	Thinking string `json:"thinking,omitempty"`
	TS       string `json:"ts,omitempty"`
	Model    string `json:"model,omitempty"`
	Sys      bool   `json:"sys,omitempty"`
	Src      string `json:"src,omitempty"`
	Compact  bool   `json:"compact,omitempty"`
	Side     bool   `json:"side,omitempty"`
	Tools    []Tool `json:"tools,omitempty"`
}

// The archive flattens an assistant turn into text: an optional
// [Thinking]…[/Thinking] block, the prose, then one marker per tool call
// ("[Bash: …]", "[Tool: name]", …). Tool calls also arrive structured, so the
// markers are cut away and only the prose is kept.
var (
	thinkRe    = regexp.MustCompile(`(?s)\[Thinking\]\n.*?\[/Thinking\]\n?`)
	toolMarkRe = regexp.MustCompile(`(?m)^\[(?:Tool: |Bash[:\]]|Read: |Write: |Edit: |Task: |Question: |Skill: |Glob[:\]]|Grep[:\]]|Todo|Entering Plan Mode|Exiting Plan Mode|Web ?Fetch|Web ?Search|Agent[:\]]|Notebook|MultiEdit|LS[:\]]|Search[:\]])`)
)

func cleanText(m arcMsg) string {
	c := m.Content
	if m.Role == "assistant" {
		c = thinkRe.ReplaceAllString(c, "")
		if m.HasToolUse || len(m.ToolCalls) > 0 {
			if loc := toolMarkRe.FindStringIndex(c); loc != nil {
				c = c[:loc[0]]
			}
		}
	}
	return strings.TrimSpace(c)
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// flattenResult turns a tool result that is a JSON list of {type,text} parts
// (both agents store some results that way) into plain text.
func flattenResult(s string) string {
	t := strings.TrimSpace(s)
	if !strings.HasPrefix(t, "[{") {
		return s
	}
	var parts []map[string]any
	if json.Unmarshal([]byte(t), &parts) != nil {
		return s
	}
	var b strings.Builder
	for _, p := range parts {
		if txt, ok := p["text"].(string); ok {
			b.WriteString(txt)
		} else if ty, _ := p["type"].(string); strings.Contains(ty, "image") {
			b.WriteString("[image]")
		}
	}
	if b.Len() == 0 {
		return s
	}
	return b.String()
}

func toolResult(t arcTool) (string, string) {
	res, status := t.ResultContent, ""
	if res == "" {
		var b strings.Builder
		for _, e := range t.ResultEvents {
			b.WriteString(e.Content)
		}
		res = b.String()
	}
	for _, e := range t.ResultEvents {
		if e.Status != "" {
			status = e.Status
		}
	}
	return flattenResult(res), status
}

func slimMsg(m arcMsg, inputMax, resultMax int) Msg {
	out := Msg{
		Ord: m.Ordinal, Role: m.Role, Text: cleanText(m), Thinking: strings.TrimSpace(m.ThinkingText),
		TS: m.Timestamp, Model: m.Model, Sys: m.IsSystem, Src: m.SourceType,
		Compact: m.IsCompactBoundary, Side: m.IsSidechain,
	}
	for _, t := range m.ToolCalls {
		res, status := toolResult(t)
		out.Tools = append(out.Tools, Tool{
			ID: t.ToolUseID, Name: t.ToolName, Cat: t.Category,
			Input: truncate(t.InputJSON, inputMax), InputLen: len(t.InputJSON),
			Result: truncate(res, resultMax), ResultLen: len(res), Status: status,
		})
	}
	return out
}

type MsgPage struct {
	Messages []Msg `json:"messages"`
	// More is true when older messages exist before the first one returned.
	More bool `json:"more"`
}

func (a *Archive) fetchMsgs(ctx context.Context, id, query string) ([]arcMsg, error) {
	var res struct {
		Messages []arcMsg `json:"messages"`
	}
	err := a.get(ctx, "/api/v1/sessions/"+url.PathEscape(id)+"/messages?"+query, &res)
	return res.Messages, err
}

// Latest returns up to limit messages ending just before ordinal `before`
// (before < 0 means the end of the session), oldest first.
func (a *Archive) Latest(ctx context.Context, id string, before, limit int) (MsgPage, error) {
	q := fmt.Sprintf("direction=desc&limit=%d", limit+1)
	if before >= 0 {
		if before == 0 {
			return MsgPage{Messages: []Msg{}}, nil
		}
		q += fmt.Sprintf("&from=%d", before-1)
	}
	ms, err := a.fetchMsgs(ctx, id, q)
	if err != nil {
		return MsgPage{}, err
	}
	more := len(ms) > limit
	if more {
		ms = ms[:limit]
	}
	out := make([]Msg, 0, len(ms))
	for i := len(ms) - 1; i >= 0; i-- {
		out = append(out, slimMsg(ms[i], 6000, 4000))
	}
	return MsgPage{Messages: out, More: more}, nil
}

// After returns messages with ordinal > after, oldest first.
func (a *Archive) After(ctx context.Context, id string, after, limit int) (MsgPage, error) {
	ms, err := a.fetchMsgs(ctx, id, fmt.Sprintf("from=%d&limit=%d", after+1, limit))
	if err != nil {
		return MsgPage{}, err
	}
	out := make([]Msg, 0, len(ms))
	for _, m := range ms {
		out = append(out, slimMsg(m, 6000, 4000))
	}
	return MsgPage{Messages: out}, nil
}

// ToolFull returns one tool call with its complete input and output.
func (a *Archive) ToolFull(ctx context.Context, id string, ord, idx int) (Tool, error) {
	ms, err := a.fetchMsgs(ctx, id, fmt.Sprintf("from=%d&limit=1", ord))
	if err != nil {
		return Tool{}, err
	}
	if len(ms) == 0 || ms[0].Ordinal != ord || idx < 0 || idx >= len(ms[0].ToolCalls) {
		return Tool{}, fmt.Errorf("tool call not found")
	}
	m := slimMsg(ms[0], 2<<20, 2<<20)
	return m.Tools[idx], nil
}

// ---------- search ----------

type SearchHit struct {
	SessionID string `json:"session_id"`
	Title     string `json:"title"`
	Agent     string `json:"agent"`
	Machine   string `json:"machine"`
	Ord       int    `json:"ord"`
	Snippet   string `json:"snippet"`
	Ended     string `json:"ended,omitempty"`
}

func (a *Archive) Search(ctx context.Context, q string, limit int) ([]SearchHit, error) {
	var res struct {
		Results []struct {
			SessionID      string `json:"session_id"`
			Agent          string `json:"agent"`
			Machine        string `json:"machine"`
			Name           string `json:"name"`
			Ordinal        int    `json:"ordinal"`
			SessionEndedAt string `json:"session_ended_at"`
			Snippet        string `json:"snippet"`
		} `json:"results"`
	}
	if err := a.get(ctx, fmt.Sprintf("/api/v1/search?q=%s&limit=%d", url.QueryEscape(q), limit), &res); err != nil {
		return nil, err
	}
	out := make([]SearchHit, 0, len(res.Results))
	for _, r := range res.Results {
		out = append(out, SearchHit{SessionID: r.SessionID, Title: r.Name, Agent: r.Agent, Machine: r.Machine,
			Ord: r.Ordinal, Snippet: r.Snippet, Ended: r.SessionEndedAt})
	}
	return out, nil
}
