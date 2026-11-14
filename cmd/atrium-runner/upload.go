package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// Attachments: a file the page hands over with a message (a pasted screenshot,
// a dropped document) is saved here, in a folder of the runner's own, and the
// message names its path so the agent can open it. This needs no opt-in: the
// runner chooses the folder and the page only supplies a file name and bytes.

const (
	maxUpload  = 25 << 20
	uploadKeep = 30 * 24 * time.Hour
)

func (r *Runner) uploadDir() string {
	base, err := os.UserCacheDir()
	if err != nil || base == "" {
		base = filepath.Join(r.home, ".cache")
	}
	return filepath.Join(base, "atrium", "uploads")
}

// safeName keeps a file name recognisable while making sure it is only ever a
// name: no folders, no leading dot, no control characters, not too long.
func safeName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(c rune) rune {
		if c == utf8.RuneError || unicode.IsControl(c) || c == ':' {
			return -1
		}
		if unicode.IsSpace(c) {
			return ' '
		}
		return c
	}, name)
	name = strings.TrimLeft(strings.TrimSpace(name), ".")
	if name == "" {
		return "file"
	}
	ext := filepath.Ext(name)
	if len(ext) > 16 {
		ext = ""
	}
	stem := strings.TrimSuffix(name, ext)
	for len(stem)+len(ext) > 120 {
		_, n := utf8.DecodeLastRuneInString(stem)
		stem = stem[:len(stem)-n]
	}
	if stem == "" {
		stem = "file"
	}
	return stem + ext
}

// upload fetches one attachment from the hub and saves it.
func (r *Runner) upload(blob, name string) (any, error) {
	root := r.uploadDir()
	r.pruneUploads(root)
	bb := make([]byte, 4)
	rand.Read(bb)
	dir := filepath.Join(root, time.Now().Format("20060102-150405")+"-"+hex.EncodeToString(bb))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, bif("存不了附件：%v", "Could not save the attachment: %v", err)
	}
	path := filepath.Join(dir, safeName(name))
	fail := func(err error) (any, error) {
		os.RemoveAll(dir)
		return nil, bif("存不了附件：%v", "Could not save the attachment: %v", err)
	}

	req, err := http.NewRequest("GET", r.cfg.Hub+"/api/runner/blob?id="+url.QueryEscape(blob), nil)
	if err != nil {
		return fail(err)
	}
	req.Header.Set("Authorization", "Bearer "+r.cfg.Token)
	hc := *r.hc
	hc.Timeout = 5 * time.Minute
	res, err := hc.Do(req)
	if err != nil {
		return fail(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fail(fmt.Errorf("hub: HTTP %d", res.StatusCode))
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fail(err)
	}
	n, err := io.Copy(f, io.LimitReader(res.Body, maxUpload+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fail(err)
	}
	if n > maxUpload {
		os.RemoveAll(dir)
		return nil, bi("附件太大", "The attachment is too large")
	}
	return map[string]any{"path": path, "name": filepath.Base(path), "size": n}, nil
}

// pruneUploads removes attachments nobody has needed for a month.
func (r *Runner) pruneUploads(root string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, e := range entries {
		if fi, err := e.Info(); err == nil && e.IsDir() && time.Since(fi.ModTime()) > uploadKeep {
			os.RemoveAll(filepath.Join(root, e.Name()))
		}
	}
}

// attachments picks, out of the paths a job names, the files that really are
// attachments saved by this runner. Anything else is left for the agent to
// treat as the text it is.
func (r *Runner) attachments(paths []string) []string {
	root := r.uploadDir()
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	var out []string
	for _, p := range paths {
		real, err := filepath.EvalSymlinks(filepath.Clean(p))
		if err != nil || !strings.HasPrefix(real, root+string(filepath.Separator)) {
			continue
		}
		if fi, err := os.Stat(real); err != nil || !fi.Mode().IsRegular() {
			continue
		}
		out = append(out, real)
		if len(out) == 20 {
			break
		}
	}
	return out
}

// dirsOf lists the folders the files are in, each once.
func dirsOf(files []string) []string {
	var dirs []string
	for _, f := range files {
		dirs = append(dirs, filepath.Dir(f))
	}
	return uniq(dirs)
}

func isImage(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp":
		return true
	}
	return false
}

var codexResumeImage struct {
	once sync.Once
	ok   bool
}

// codexResumeTakesImages tells whether this machine's codex accepts --image
// when it continues a session (older ones only do for a new session).
func codexResumeTakesImages(bin string) bool {
	c := &codexResumeImage
	c.once.Do(func() {
		cmd := exec.Command(bin, "exec", "resume", "--help")
		done := make(chan []byte, 1)
		go func() {
			b, _ := cmd.CombinedOutput()
			done <- b
		}()
		select {
		case b := <-done:
			c.ok = strings.Contains(string(b), "--image")
		case <-time.After(15 * time.Second):
			if cmd.Process != nil {
				cmd.Process.Kill()
			}
		}
	})
	return c.ok
}
