package main

import (
	"bytes"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// How much of each agent's plan allowance is used, and when it resets. Both
// CLIs are told this by their service on every request. Claude Code passes it
// on in the output of a run; Codex writes it into its session files. The
// runner only reads what is already there: it never asks the service itself
// and never touches a sign-in.

// A window is one allowance: Minutes long, Used percent spent, starting over at Resets (ms).
type window struct {
	ID      string  `json:"id"`
	Minutes int     `json:"minutes,omitempty"`
	Used    float64 `json:"used"`
	Resets  int64   `json:"resets,omitempty"`
}

var claudeWindows = []struct {
	id      string
	minutes int
}{
	{"five_hour", 300},
	{"seven_day", 10080},
	{"seven_day_opus", 10080},
	{"seven_day_sonnet", 10080},
}

// claudeLimits reads the `rate_limit_info` of a rate_limit_event.
func claudeLimits(info map[string]any) map[string]any {
	if info == nil {
		return nil
	}
	read := func(m map[string]any, id string, minutes int) (window, bool) {
		u, ok := m["utilization"].(float64)
		if !ok {
			return window{}, false
		}
		w := window{ID: id, Minutes: minutes, Used: round1(u * 100)}
		if at, ok := m["resetsAt"].(float64); ok && at > 0 {
			w.Resets = int64(at) * 1000
		}
		return w, true
	}
	wins := []window{}
	if all, _ := info["unifiedWindows"].(map[string]any); all != nil {
		for _, k := range claudeWindows {
			if m, _ := all[k.id].(map[string]any); m != nil {
				if w, ok := read(m, k.id, k.minutes); ok {
					wins = append(wins, w)
				}
			}
		}
	}
	if len(wins) == 0 {
		// An older CLI names only the window closest to its limit.
		id := str(info, "rateLimitType")
		for _, k := range claudeWindows {
			if k.id == id {
				if w, ok := read(info, k.id, k.minutes); ok {
					wins = append(wins, w)
				}
			}
		}
	}
	if len(wins) == 0 {
		return nil
	}
	return map[string]any{"windows": wins, "status": str(info, "status"), "at": time.Now().UnixMilli()}
}

// codexLimits finds the newest rate-limit record in the Codex session files
// of the given homes.
func codexLimits(homes []string) map[string]any {
	type file struct {
		path string
		mod  time.Time
	}
	files := []file{}
	for _, home := range homes {
		root := filepath.Join(home, "sessions")
		// sessions/YYYY/MM/DD/rollout-*.jsonl: only files touched in the last two weeks can hold a current reading.
		filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || filepath.Ext(p) != ".jsonl" {
				return nil
			}
			if info, err := d.Info(); err == nil && time.Since(info.ModTime()) < 14*24*time.Hour {
				files = append(files, file{p, info.ModTime()})
			}
			return nil
		})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.After(files[j].mod) })
	for i, f := range files {
		if i >= 12 {
			break
		}
		if lim := codexLimitsIn(f.path); lim != nil {
			return lim
		}
	}
	return nil
}

// codexLimitsIn reads the last rate-limit record near the end of one session file.
func codexLimitsIn(path string) map[string]any {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	const tail = 512 << 10
	if st, err := f.Stat(); err == nil && st.Size() > tail {
		f.Seek(-tail, io.SeekEnd)
	}
	b, err := io.ReadAll(f)
	if err != nil {
		return nil
	}
	lines := bytes.Split(b, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		if !bytes.Contains(lines[i], []byte(`"rate_limits"`)) {
			continue
		}
		var rec struct {
			Timestamp string `json:"timestamp"`
			Payload   struct {
				Limits *struct {
					Primary   *codexWindow `json:"primary"`
					Secondary *codexWindow `json:"secondary"`
					Plan      string       `json:"plan_type"`
				} `json:"rate_limits"`
			} `json:"payload"`
		}
		if json.Unmarshal(lines[i], &rec) != nil || rec.Payload.Limits == nil {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, rec.Timestamp)
		if err != nil {
			continue
		}
		wins := []window{}
		for _, w := range []*codexWindow{rec.Payload.Limits.Primary, rec.Payload.Limits.Secondary} {
			if w == nil {
				continue
			}
			x := window{Minutes: w.Minutes, Used: round1(w.Used)}
			switch {
			case w.ResetsAt > 0:
				x.Resets = w.ResetsAt * 1000
			case w.ResetsIn > 0:
				x.Resets = at.UnixMilli() + w.ResetsIn*1000
			}
			switch {
			case w.Minutes > 0 && w.Minutes <= 24*60:
				x.ID = "five_hour"
			default:
				x.ID = "seven_day"
			}
			wins = append(wins, x)
		}
		if len(wins) == 0 {
			continue
		}
		sort.SliceStable(wins, func(i, j int) bool { return wins[i].Minutes < wins[j].Minutes })
		return map[string]any{"windows": wins, "plan": rec.Payload.Limits.Plan, "at": at.UnixMilli()}
	}
	return nil
}

type codexWindow struct {
	Used     float64 `json:"used_percent"`
	Minutes  int     `json:"window_minutes"`
	ResetsAt int64   `json:"resets_at"`
	ResetsIn int64   `json:"resets_in_seconds"`
}

func round1(x float64) float64 {
	return float64(int64(x*10+0.5)) / 10
}

// reportLimits tells the hub an agent's allowance on this machine, once per change.
func (r *Runner) reportLimits(agent string, lim map[string]any) {
	if len(lim) == 0 {
		return
	}
	lim["agent"] = agent
	b, err := json.Marshal(lim)
	if err != nil {
		return
	}
	r.mu.Lock()
	same := r.caps["limits:"+agent] == string(b)
	r.caps["limits:"+agent] = string(b)
	r.mu.Unlock()
	if !same {
		r.emit("", "limits", lim)
	}
}
