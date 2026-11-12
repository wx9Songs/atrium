package main

import (
	"compress/gzip"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed all:webdist
var webFS embed.FS

type Server struct {
	cfg   *Config
	arc   *Archive
	meta  *MetaStore
	runs  *RunStore
	mach  *Machines
	terms *Terms
	bus   *Bus

	loginMu  sync.Mutex
	loginHit []time.Time
}

func newServer(cfg *Config) *Server {
	s := &Server{
		cfg:   cfg,
		arc:   newArchive(cfg.ArchiveURL, cfg.ArchiveToken),
		meta:  newMetaStore(filepath.Join(cfg.dataDir(), "meta.json")),
		runs:  newRunStore(filepath.Join(cfg.dataDir(), "runs")),
		mach:  newMachines(cfg, filepath.Join(cfg.dataDir(), "caps.json")),
		bus:   newBus(),
		terms: newTerms(),
	}
	return s
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok\n") })

	mux.HandleFunc("GET /api/auth", s.handleAuth)
	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/logout", s.handleLogout)

	b := s.browser
	mux.HandleFunc("GET /api/state", b(s.handleState))
	mux.HandleFunc("GET /api/sessions", b(s.handleSessions))
	mux.HandleFunc("GET /api/sessions/{id}/messages", b(s.handleMessages))
	mux.HandleFunc("GET /api/sessions/{id}/tool", b(s.handleTool))
	mux.HandleFunc("POST /api/sessions/{id}/meta", b(s.handleMeta))
	mux.HandleFunc("GET /api/search", b(s.handleSearch))
	mux.HandleFunc("GET /api/runs", b(s.handleRuns))
	mux.HandleFunc("POST /api/runs", b(s.handleCreateRun))
	mux.HandleFunc("GET /api/runs/{id}/events", b(s.handleRunEvents))
	mux.HandleFunc("POST /api/runs/{id}/permission", b(s.handlePermission))
	mux.HandleFunc("POST /api/runs/{id}/stop", b(s.handleStop))
	mux.HandleFunc("POST /api/ls", b(s.handleLs))
	mux.HandleFunc("POST /api/machines/{name}/caps", b(s.handleCapsRefresh))
	mux.HandleFunc("GET /api/terms", b(s.handleTermList))
	mux.HandleFunc("POST /api/terms", b(s.handleTermOpen))
	mux.HandleFunc("GET /api/terms/{id}", b(s.handleTermGet))
	mux.HandleFunc("POST /api/terms/{id}/{op}", b(s.handleTermCommand))
	mux.HandleFunc("POST /api/fs/{op}", b(s.handleFs))
	mux.HandleFunc("GET /api/events", b(s.handleEvents))

	rn := s.runner
	mux.HandleFunc("POST /api/runner/hello", rn(s.handleRunnerHello))
	mux.HandleFunc("GET /api/runner/poll", rn(s.handleRunnerPoll))
	mux.HandleFunc("POST /api/runner/events", rn(s.handleRunnerEvents))
	mux.HandleFunc("POST /api/runner/reply", rn(s.handleRunnerReply))

	mux.Handle("/", s.static())
	return gzipMiddleware(mux)
}

// background keeps presence and the session list fresh for connected browsers.
func (s *Server) background(ctx context.Context) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	lastEtag := ""
	n := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		n++
		if s.mach.presenceChanged() {
			s.bus.Publish("machines", s.machineList(ctx))
		}
		if n%2 == 0 && s.bus.Count() > 0 {
			c, cancel := context.WithTimeout(ctx, 20*time.Second)
			_, etag, err := s.arc.Sessions(c, false)
			cancel()
			if err == nil && etag != lastEtag {
				if lastEtag != "" {
					s.bus.Publish("sessions", map[string]string{"etag": etag})
				}
				lastEtag = etag
			}
		}
		if n%720 == 0 {
			s.runs.prune(400)
		}
	}
}

// ---------- helpers ----------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any, max int64) error {
	defer r.Body.Close()
	return json.NewDecoder(io.LimitReader(r.Body, max)).Decode(v)
}

// ---------- browser auth ----------

const cookieName = "atrium_session"
const legacyCookieName = "sh_session" // issued before the project was renamed
const cookieTTL = 180 * 24 * time.Hour

func (s *Server) sign(msg string) string {
	m := hmac.New(sha256.New, []byte(s.cfg.CookieSecret))
	m.Write([]byte(msg))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s *Server) newCookieValue() string {
	msg := fmt.Sprintf("%d.%s", time.Now().Add(cookieTTL).Unix(), randToken(9))
	return msg + "." + s.sign(msg)
}

func (s *Server) validCookie(v string) bool {
	i := strings.LastIndexByte(v, '.')
	if i < 0 {
		return false
	}
	msg, sig := v[:i], v[i+1:]
	if !hmac.Equal([]byte(s.sign(msg)), []byte(sig)) {
		return false
	}
	exp, err := strconv.ParseInt(strings.SplitN(msg, ".", 2)[0], 10, 64)
	return err == nil && time.Now().Unix() < exp
}

func (s *Server) authed(r *http.Request) bool {
	if s.cfg.DevNoAuth {
		return true
	}
	for _, name := range []string{cookieName, legacyCookieName} {
		if c, err := r.Cookie(name); err == nil && s.validCookie(c.Value) {
			return true
		}
	}
	return false
}

func sameOrigin(r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return true
	}
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	return err == nil && u.Host == r.Host
}

func (s *Server) browser(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			writeErr(w, http.StatusForbidden, "cross-origin request refused")
			return
		}
		if !s.authed(r) {
			writeErr(w, http.StatusUnauthorized, L(r, "未登录", "Not signed in"))
			return
		}
		h(w, r)
	}
}

func (s *Server) setCookie(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) handleAuth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"authed": s.authed(r), "version": version, "login_hint": s.cfg.LoginHint})
}

func (s *Server) loginAllowed() bool {
	s.loginMu.Lock()
	defer s.loginMu.Unlock()
	now := time.Now()
	keep := s.loginHit[:0]
	for _, t := range s.loginHit {
		if now.Sub(t) < time.Minute {
			keep = append(keep, t)
		}
	}
	s.loginHit = append(keep, now)
	return len(s.loginHit) <= 10
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !sameOrigin(r) {
		writeErr(w, http.StatusForbidden, "cross-origin request refused")
		return
	}
	if !s.loginAllowed() {
		writeErr(w, http.StatusTooManyRequests, L(r, "尝试太频繁，请稍后再试", "Too many attempts. Try again in a minute"))
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := readJSON(r, &body, 4096); err != nil || len(body.Code) < 16 {
		writeErr(w, http.StatusUnauthorized, L(r, "登录链接无效", "Invalid sign-in link"))
		return
	}
	p := filepath.Join(s.cfg.dataDir(), "login-codes", sha256hex(body.Code))
	fi, err := os.Stat(p)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, L(r, "登录链接无效或已使用过", "This sign-in link is invalid or was already used"))
		return
	}
	os.Remove(p) // one-time
	if time.Since(fi.ModTime()) > 15*time.Minute {
		writeErr(w, http.StatusUnauthorized, L(r, "登录链接已过期，请重新生成", "This sign-in link expired. Make a new one"))
		return
	}
	s.setCookie(w, r, s.newCookieValue(), int(cookieTTL.Seconds()))
	writeJSON(w, 200, map[string]any{"authed": true})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.setCookie(w, r, "", -1)
	http.SetCookie(w, &http.Cookie{Name: legacyCookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
	writeJSON(w, 200, map[string]any{"authed": false})
}

// ---------- server-sent events ----------

type Bus struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
}

func newBus() *Bus { return &Bus{subs: map[chan []byte]struct{}{}} }

func (b *Bus) Count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}

func (b *Bus) Publish(event string, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	msg := []byte("event: " + event + "\ndata: " + string(data) + "\n\n")
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- msg:
		default:
			// Too slow: drop it. The browser reconnects and resyncs.
			delete(b.subs, ch)
			close(ch)
		}
	}
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, 500, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	ch := make(chan []byte, 512)
	s.bus.mu.Lock()
	s.bus.subs[ch] = struct{}{}
	s.bus.mu.Unlock()
	defer func() {
		s.bus.mu.Lock()
		if _, ok := s.bus.subs[ch]; ok {
			delete(s.bus.subs, ch)
		}
		s.bus.mu.Unlock()
	}()
	io.WriteString(w, "event: hello\ndata: {}\n\n")
	fl.Flush()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			io.WriteString(w, ": ping\n\n")
			fl.Flush()
		case msg, ok := <-ch:
			if !ok {
				return
			}
			w.Write(msg)
			fl.Flush()
		}
	}
}

// ---------- static files (single-page app) ----------

func (s *Server) static() http.Handler {
	sub, err := fs.Sub(webFS, "webdist")
	if err != nil {
		log.Fatal(err)
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeErr(w, 404, "not found")
			return
		}
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" {
			if f, err := sub.Open(p); err == nil {
				f.Close()
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		b, err := fs.ReadFile(sub, "index.html")
		if err != nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			io.WriteString(w, "atrium: the web interface has not been built into this binary.\n")
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(b)
	})
}

// ---------- gzip ----------

type gzipWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (g *gzipWriter) Write(b []byte) (int, error) {
	g.Header().Del("Content-Length")
	return g.gz.Write(b)
}

func (g *gzipWriter) WriteHeader(code int) {
	g.Header().Del("Content-Length")
	g.ResponseWriter.WriteHeader(code)
}

func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") ||
			p == "/api/events" || strings.HasPrefix(p, "/api/runner/") || r.Method != http.MethodGet {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		w.Header().Del("Content-Length")
		gz := gzip.NewWriter(w)
		defer gz.Close()
		next.ServeHTTP(&gzipWriter{ResponseWriter: w, gz: gz}, r)
	})
}
