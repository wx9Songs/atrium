package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
	_ "time/tzdata" // days are counted in the browser's time zone, also on a server without zone files
)

// Usage: the tokens of the last week as the archive counts them from the
// transcripts (so work done in a terminal counts too), and each agent's plan
// allowance as the runners report it.

// Tokens of one day, agent, model or machine. Cost is what they would cost at
// the public API prices, in dollars: an estimate, not a bill.
type Tokens struct {
	In         int64   `json:"in"`
	Out        int64   `json:"out"`
	CacheRead  int64   `json:"cache_read"`
	CacheWrite int64   `json:"cache_write"`
	Cost       float64 `json:"cost"`
}

func (t *Tokens) add(x Tokens) {
	t.In += x.In
	t.Out += x.Out
	t.CacheRead += x.CacheRead
	t.CacheWrite += x.CacheWrite
	t.Cost += x.Cost
}

type UsageDay struct {
	Date string `json:"date"`
	Tokens
	Agents map[string]Tokens `json:"agents,omitempty"`
}

type UsagePart struct {
	Name string `json:"name"`
	Tokens
}

type Usage struct {
	// False when the archive cannot count tokens (an older agentsview).
	Available bool        `json:"available"`
	Days      []UsageDay  `json:"days"`
	Agents    []UsagePart `json:"agents"`
	Models    []UsagePart `json:"models"`
	Machines  []UsagePart `json:"machines"`
}

// The archive's own shape (GET /api/v1/usage/summary).
type arcTokens struct {
	In         int64 `json:"inputTokens"`
	Out        int64 `json:"outputTokens"`
	CacheWrite int64 `json:"cacheCreationTokens"`
	CacheRead  int64 `json:"cacheReadTokens"`
	Cost       struct {
		Micro int64 `json:"microdollars"`
	} `json:"cost"`
	TotalCost struct {
		Micro int64 `json:"microdollars"`
	} `json:"totalCost"`
}

func (t arcTokens) tokens() Tokens {
	return Tokens{In: t.In, Out: t.Out, CacheRead: t.CacheRead, CacheWrite: t.CacheWrite, Cost: float64(t.Cost.Micro+t.TotalCost.Micro) / 1e6}
}

type usageCache struct {
	mu sync.Mutex
	at map[string]time.Time
	v  map[string]Usage
}

const usageDays = 7

// Usage returns the last seven days ending today in the given time zone.
func (a *Archive) Usage(ctx context.Context, tz string) (Usage, error) {
	loc, err := time.LoadLocation(tz)
	if err != nil || tz == "" {
		loc, tz = time.UTC, ""
	}
	now := time.Now().In(loc)
	q := url.Values{"from": {now.AddDate(0, 0, 1-usageDays).Format("2006-01-02")}, "to": {now.Format("2006-01-02")}}
	if tz != "" {
		q.Set("timezone", tz)
	}
	var res struct {
		Daily []struct {
			Date string `json:"date"`
			arcTokens
			Agents []struct {
				Agent string `json:"agent"`
				arcTokens
			} `json:"agentBreakdowns"`
			Machines []struct {
				Name string `json:"machineName"`
				arcTokens
			} `json:"machineBreakdowns"`
		} `json:"daily"`
		Agents []struct {
			Agent string `json:"agent"`
			arcTokens
		} `json:"agentTotals"`
		Models []struct {
			Model string `json:"model"`
			arcTokens
		} `json:"modelTotals"`
	}
	if err := a.get(ctx, "/api/v1/usage/summary?"+q.Encode(), &res); err != nil {
		return Usage{}, err
	}
	u := Usage{Available: true, Days: []UsageDay{}, Agents: []UsagePart{}, Models: []UsagePart{}, Machines: []UsagePart{}}
	byDate := map[string]UsageDay{}
	machines := map[string]*Tokens{}
	for _, d := range res.Daily {
		day := UsageDay{Date: d.Date, Tokens: d.tokens(), Agents: map[string]Tokens{}}
		for _, x := range d.Agents {
			day.Agents[x.Agent] = x.tokens()
		}
		for _, x := range d.Machines {
			if machines[x.Name] == nil {
				machines[x.Name] = &Tokens{}
			}
			machines[x.Name].add(x.tokens())
		}
		byDate[d.Date] = day
	}
	// Every day of the week is listed, with zeros for the days nothing ran.
	for i := usageDays - 1; i >= 0; i-- {
		date := now.AddDate(0, 0, -i).Format("2006-01-02")
		day, ok := byDate[date]
		if !ok {
			day = UsageDay{Date: date}
		}
		u.Days = append(u.Days, day)
	}
	for _, x := range res.Agents {
		u.Agents = append(u.Agents, UsagePart{Name: x.Agent, Tokens: x.tokens()})
	}
	for _, x := range res.Models {
		u.Models = append(u.Models, UsagePart{Name: x.Model, Tokens: x.tokens()})
	}
	for name, t := range machines {
		u.Machines = append(u.Machines, UsagePart{Name: name, Tokens: *t})
	}
	for _, list := range [][]UsagePart{u.Agents, u.Models, u.Machines} {
		sort.SliceStable(list, func(i, j int) bool {
			if a, b := list[i].In+list[i].Out+list[i].CacheWrite, list[j].In+list[j].Out+list[j].CacheWrite; a != b {
				return a > b
			}
			return list[i].Name < list[j].Name
		})
	}
	return u, nil
}

func (s *Server) handleUsage(w http.ResponseWriter, r *http.Request) {
	tz := r.URL.Query().Get("tz")
	if len(tz) > 64 {
		tz = ""
	}
	c := &s.usage
	c.mu.Lock()
	if v, ok := c.v[tz]; ok && time.Since(c.at[tz]) < time.Minute {
		c.mu.Unlock()
		writeJSON(w, 200, v)
		return
	}
	c.mu.Unlock()
	u, err := s.arc.Usage(r.Context(), tz)
	if err != nil {
		// Not an error for the page: it leaves the token part out.
		u = Usage{Days: []UsageDay{}, Agents: []UsagePart{}, Models: []UsagePart{}, Machines: []UsagePart{}}
	}
	c.mu.Lock()
	if c.v == nil || len(c.v) > 8 {
		c.v, c.at = map[string]Usage{}, map[string]time.Time{}
	}
	c.v[tz], c.at[tz] = u, time.Now()
	c.mu.Unlock()
	writeJSON(w, 200, u)
}

// ---------- plan allowances ----------

// setLimits stores an agent's allowance as a machine's runner read it (kept
// across restarts) and reports whether it changed.
func (ms *Machines) setLimits(name string, data json.RawMessage) bool {
	var d struct {
		Agent string `json:"agent"`
	}
	if json.Unmarshal(data, &d) != nil || d.Agent == "" || len(data) > 8<<10 {
		return false
	}
	ms.mu.Lock()
	defer ms.mu.Unlock()
	m := ms.m[name]
	if m == nil || string(m.Limits[d.Agent]) == string(data) {
		return false
	}
	if m.Limits == nil {
		m.Limits = map[string]json.RawMessage{}
	}
	m.Limits[d.Agent] = data
	all := map[string]map[string]json.RawMessage{}
	for n, x := range ms.m {
		if len(x.Limits) > 0 {
			all[n] = x.Limits
		}
	}
	if b, err := json.Marshal(all); err == nil {
		writeFileAtomic(ms.limitsPath(), b, 0o600)
	}
	return true
}

func (ms *Machines) limitsPath() string {
	return filepath.Join(filepath.Dir(ms.capsPath), "limits.json")
}

// loadLimits reads what was saved before the hub restarted.
func (ms *Machines) loadLimits() {
	saved := map[string]map[string]json.RawMessage{}
	if b, err := os.ReadFile(ms.limitsPath()); err == nil {
		json.Unmarshal(b, &saved)
	}
	for name, m := range ms.m {
		m.Limits = saved[name]
	}
}
