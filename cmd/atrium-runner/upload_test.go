package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSafeName(t *testing.T) {
	for in, want := range map[string]string{
		"shot.png":                      "shot.png",
		"../../.ssh/authorized_keys":    "authorized_keys",
		`C:\Users\me\报告 终版.pdf`:         "报告 终版.pdf",
		".env":                          "env",
		"":                              "file",
		"...":                           "file",
		"a\x00b\nc.txt":                 "abc.txt",
		strings.Repeat("长", 80) + ".md": strings.Repeat("长", 39) + ".md",
	} {
		if got := safeName(in); got != want {
			t.Errorf("safeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUpload(t *testing.T) {
	cache := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cache)
	t.Setenv("HOME", cache) // where macOS keeps its caches
	body := "picture bytes"
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runner/blob" || r.URL.Query().Get("id") != "b1" || r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "no", 404)
			return
		}
		w.Write([]byte(body))
	}))
	defer hub.Close()
	r := &Runner{cfg: Config{Hub: hub.URL, Token: "tok"}, hc: hub.Client(), home: cache}

	res, err := r.upload("b1", "../shot.png")
	if err != nil {
		t.Fatal(err)
	}
	path := res.(map[string]any)["path"].(string)
	if filepath.Base(path) != "shot.png" || !strings.HasPrefix(path, r.uploadDir()+string(filepath.Separator)) {
		t.Fatalf("saved as %s", path)
	}
	if b, _ := os.ReadFile(path); string(b) != body {
		t.Fatalf("content = %q", b)
	}
	if _, err := r.upload("missing", "x.png"); err == nil {
		t.Fatal("an upload the hub does not have was saved")
	}

	// Only what this runner saved counts as an attachment.
	outside := filepath.Join(cache, "secret.txt")
	os.WriteFile(outside, []byte("x"), 0o600)
	link := filepath.Join(filepath.Dir(path), "link.txt")
	os.Symlink(outside, link)
	got := r.attachments([]string{path, outside, link, filepath.Dir(path), filepath.Join(r.uploadDir(), "..", "..", "secret.txt"), "relative.png"})
	real, _ := filepath.EvalSymlinks(path)
	if len(got) != 1 || got[0] != real {
		t.Fatalf("attachments = %v", got)
	}
	if d := dirsOf(got); len(d) != 1 || d[0] != filepath.Dir(real) {
		t.Fatalf("dirs = %v", d)
	}
	if !isImage(path) || isImage(outside) {
		t.Fatal("isImage")
	}
}
