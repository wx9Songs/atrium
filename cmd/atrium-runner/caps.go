//go:build unix

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// What each agent on this machine offers (models, reasoning effort levels,
// slash commands) is asked from the CLIs themselves, so the page's pickers
// match this machine's install and account rather than a built-in list.
// Neither question starts a session or talks to a model.

var probing sync.Mutex

// probeCaps asks both CLIs and reports the answers to the hub. It runs when
// the runner connects, every few hours, and when the page asks for a refresh.
func (r *Runner) probeCaps() {
	if !probing.TryLock() {
		return
	}
	defer probing.Unlock()
	if caps := r.probeClaude(); caps != nil {
		r.reportCaps("claude", caps)
	}
	if caps := r.probeCodex(); caps != nil {
		r.reportCaps("codex", caps)
	}
}

// probeClaude starts the CLI as the runner does for a turn, sends only the
// "initialize" request, and stops it once the answer has arrived.
func (r *Runner) probeClaude() map[string]any {
	bin, err := exec.LookPath("claude")
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose")
	cmd.Dir = r.home
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil
	}
	if err := cmd.Start(); err != nil {
		return nil
	}
	defer func() {
		stdin.Close()
		cmd.Process.Kill()
		cmd.Wait()
	}()
	req, _ := json.Marshal(map[string]any{"type": "control_request", "request_id": "caps", "request": map[string]any{"subtype": "initialize", "hooks": nil}})
	stdin.Write(append(req, '\n'))
	rd := bufio.NewReaderSize(stdout, 1<<16)
	for {
		line, err := rd.ReadBytes('\n')
		if len(line) > 1 {
			var m struct {
				Type     string `json:"type"`
				Response struct {
					RequestID string         `json:"request_id"`
					Response  map[string]any `json:"response"`
				} `json:"response"`
			}
			if json.Unmarshal(line, &m) == nil && m.Type == "control_response" && m.Response.RequestID == "caps" {
				return claudeCaps(m.Response.Response)
			}
		}
		if err != nil {
			return nil
		}
	}
}

var tomlString = regexp.MustCompile(`(?m)^\s*(model|model_reasoning_effort)\s*=\s*"([^"]*)"`)

// probeCodex reads Codex's model catalog (`codex debug models`) and the
// default model and effort from its config file.
func (r *Runner) probeCodex() map[string]any {
	bin, err := exec.LookPath("codex")
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "debug", "models").Output()
	if err != nil {
		return nil
	}
	var catalog struct {
		Models []struct {
			Slug        string `json:"slug"`
			Name        string `json:"display_name"`
			Description string `json:"description"`
			Visibility  string `json:"visibility"`
			Default     string `json:"default_reasoning_level"`
			Levels      []struct {
				Effort string `json:"effort"`
			} `json:"supported_reasoning_levels"`
		} `json:"models"`
	}
	if json.Unmarshal(out, &catalog) != nil || len(catalog.Models) == 0 {
		return nil
	}
	models := []any{}
	for _, m := range catalog.Models {
		if m.Slug == "" || (m.Visibility != "" && m.Visibility != "list") {
			continue
		}
		efforts := []string{}
		for _, l := range m.Levels {
			if l.Effort != "" {
				efforts = append(efforts, l.Effort)
			}
		}
		models = append(models, map[string]any{"value": m.Slug, "name": clipRunes(m.Name, 60), "description": clipRunes(m.Description, 120), "efforts": efforts, "default_effort": m.Default})
	}
	caps := map[string]any{"models": models}
	// The top-level `model = "…"` lines of config.toml (before the first [section]) are this machine's defaults.
	for _, home := range r.codexHomes() {
		b, err := os.ReadFile(filepath.Join(home, "config.toml"))
		if err != nil {
			continue
		}
		top := string(b)
		if i := strings.Index(top, "\n["); i >= 0 {
			top = top[:i]
		}
		for _, m := range tomlString.FindAllStringSubmatch(top, -1) {
			if m[1] == "model" {
				caps["default_model"] = m[2]
			} else {
				caps["default_effort"] = m[2]
			}
		}
		break
	}
	return caps
}
