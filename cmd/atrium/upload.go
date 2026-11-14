package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Attachments: the page uploads a file for one machine, the hub holds it for
// the moment it takes that machine's runner to fetch it, and answers with the
// path the runner saved it under. The hub keeps a copy of pictures only, for a
// month, so that the conversation shows them on every device.

const maxUpload = 25 << 20

type blob struct {
	machine string
	data    []byte
}

type blobStore struct {
	mu sync.Mutex
	m  map[string]blob
}

func (b *blobStore) put(id string, x blob) {
	b.mu.Lock()
	if b.m == nil {
		b.m = map[string]blob{}
	}
	b.m[id] = x
	b.mu.Unlock()
}

func (b *blobStore) get(id string) (blob, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	x, ok := b.m[id]
	return x, ok
}

func (b *blobStore) drop(id string) {
	b.mu.Lock()
	delete(b.m, id)
	b.mu.Unlock()
}

// handleUpload: POST /api/upload?machine=…&name=… with the file as the body.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	machine, name := r.URL.Query().Get("machine"), r.URL.Query().Get("name")
	if !s.mach.has(machine) {
		writeErr(w, http.StatusConflict, L(r, "这台机器没有接入操控，不能接收附件", "This machine has no runner, so it cannot take attachments"))
		return
	}
	if !s.mach.online(machine) {
		writeErr(w, http.StatusConflict, L(r, "这台机器现在不在线", "This machine is offline"))
		return
	}
	if !s.mach.supports(machine, "upload") {
		writeErr(w, http.StatusConflict, L(r, "这台机器上的 runner 版本太旧，还不能接收附件。更新 runner 后再试。", "The runner on this machine is too old to take attachments. Update it and try again."))
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxUpload))
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, L(r, "附件太大（上限 25 MB）", "The attachment is too large (25 MB at most)"))
		return
	}
	id := "b" + randToken(18)
	s.blobs.put(id, blob{machine: machine, data: data})
	defer s.blobs.drop(id)
	rep, err := s.mach.rpc(r.Context(), machine, map[string]any{"type": "upload", "blob": id, "name": clip(name, 300), "size": len(data)}, 3*time.Minute)
	if err != nil {
		writeErr(w, http.StatusConflict, errText(r, err))
		return
	}
	var saved struct {
		Path string `json:"path"`
	}
	if json.Unmarshal(rep, &saved) == nil {
		s.keepPicture(saved.Path, data)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(rep)
}

// ---------- pictures kept for the page ----------

const (
	picKeep  = 30 * 24 * time.Hour
	picTotal = 2 << 30 // all kept pictures together; the oldest go first
)

// A saved attachment is <runner's uploads folder>/<time>-<random>/<name>. The
// last two parts name it on the hub too: the random part makes it unguessable
// enough for a page that needs a sign-in anyway, and unique across machines.
var (
	picPathRe   = regexp.MustCompile(`[/\\]atrium[/\\]uploads[/\\](\d{8}-\d{6}-[0-9a-f]{8})[/\\]([^/\\]+)$`)
	picFolderRe = regexp.MustCompile(`^\d{8}-\d{6}-[0-9a-f]{8}$`)
	picTypes    = map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
)

func (s *Server) picDir() string { return filepath.Join(s.cfg.dataDir(), "uploads") }

// keepPicture stores a copy of an attachment the runner saved at path, if it is a picture.
func (s *Server) keepPicture(path string, data []byte) {
	m := picPathRe.FindStringSubmatch(path)
	if m == nil || picTypes[strings.ToLower(filepath.Ext(m[2]))] == "" || m[2] == "." || m[2] == ".." {
		return
	}
	dir := filepath.Join(s.picDir(), m[1])
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	if writeFileAtomic(filepath.Join(dir, m[2]), data, 0o600) != nil {
		return
	}
	prunePictures(s.picDir())
}

// prunePictures drops what is older than a month, and the oldest beyond the total size.
func prunePictures(root string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	type folder struct {
		path string
		at   time.Time
		size int64
	}
	var all []folder
	var total int64
	for _, e := range entries {
		fi, err := e.Info()
		if err != nil || !e.IsDir() {
			continue
		}
		f := folder{path: filepath.Join(root, e.Name()), at: fi.ModTime()}
		files, _ := os.ReadDir(f.path)
		for _, x := range files {
			if xi, err := x.Info(); err == nil {
				f.size += xi.Size()
			}
		}
		if time.Since(f.at) > picKeep {
			os.RemoveAll(f.path)
			continue
		}
		all = append(all, f)
		total += f.size
	}
	sort.Slice(all, func(i, j int) bool { return all[i].at.Before(all[j].at) })
	for i := 0; total > picTotal && i < len(all)-1; i++ {
		os.RemoveAll(all[i].path)
		total -= all[i].size
	}
}

// handleAttachment: GET /api/attachment/{folder}/{name}, a picture kept by keepPicture.
func (s *Server) handleAttachment(w http.ResponseWriter, r *http.Request) {
	folder, name := r.PathValue("folder"), r.PathValue("name")
	ctype := picTypes[strings.ToLower(filepath.Ext(name))]
	if !picFolderRe.MatchString(folder) || ctype == "" || name != filepath.Base(name) || strings.ContainsAny(name, `/\`) {
		writeErr(w, 404, "not found")
		return
	}
	f, err := os.Open(filepath.Join(s.picDir(), folder, name))
	if err != nil {
		writeErr(w, 404, "not found")
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		writeErr(w, 404, "not found")
		return
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

// handleRunnerBlob hands an upload to the runner it is meant for.
func (s *Server) handleRunnerBlob(w http.ResponseWriter, r *http.Request) {
	x, ok := s.blobs.get(r.URL.Query().Get("id"))
	if !ok || x.machine != machineOf(r) {
		writeErr(w, 404, "not found")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(x.data)
}

// withoutAttachments is a message as a title wants it: without the list of
// attachment paths it ends with. A message that is nothing but attachments is
// named after the first of them.
func withoutAttachments(s string) string {
	i := strings.Index(s, "[Attached files")
	if i < 0 {
		return s
	}
	if t := strings.TrimSpace(s[:i]); t != "" {
		return t
	}
	rest := s[i:]
	j := strings.Index(rest, "- ")
	if j < 0 {
		return s
	}
	first := rest[j+2:]
	// One path per line; an archive that folds the lines leaves " - " between them.
	for _, end := range []string{"\n", " - /", " - ~"} {
		if k := strings.Index(first, end); k >= 0 {
			first = first[:k]
		}
	}
	return path.Base(strings.TrimSpace(strings.ReplaceAll(first, "\\", "/")))
}
