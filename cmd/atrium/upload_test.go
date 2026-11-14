package main

import (
	"net/http/httptest"
	"testing"
)

func TestWithoutAttachments(t *testing.T) {
	for in, want := range map[string]string{
		"fix the build": "fix the build",
		"look at this\n\n[Attached files: read them at these paths]\n- /home/u/.cache/atrium/uploads/x/shot.png":      "look at this",
		"[Attached files: read them at these paths]\n- /home/u/.cache/atrium/uploads/x/shot one.png\n- /home/u/b.csv": "shot one.png",
		// As an archive that folds whitespace hands it over.
		"[Attached files: read them at these paths] - /home/u/x/shot.png - /home/u/x/b.csv": "shot.png",
	} {
		if got := withoutAttachments(in); got != want {
			t.Errorf("withoutAttachments(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPictures(t *testing.T) {
	s := &Server{cfg: &Config{DataDir: t.TempDir()}}
	s.keepPicture("/Users/x/Library/Caches/atrium/uploads/20300102-030405-0123abcd/shot 1.png", []byte("png"))
	s.keepPicture("/root/.cache/atrium/uploads/20300102-030405-0123abce/notes.pdf", []byte("pdf"))
	s.keepPicture("/tmp/elsewhere/20300102-030405-0123abcf/a.png", []byte("x"))
	get := func(folder, name string) int {
		r := httptest.NewRequest("GET", "/api/attachment/x/y", nil)
		r.SetPathValue("folder", folder)
		r.SetPathValue("name", name)
		w := httptest.NewRecorder()
		s.handleAttachment(w, r)
		if w.Code == 200 && (w.Body.String() != "png" || w.Header().Get("Content-Type") != "image/png") {
			t.Errorf("served %q as %q", w.Body.String(), w.Header().Get("Content-Type"))
		}
		return w.Code
	}
	for _, c := range []struct {
		folder, name string
		code         int
	}{
		{"20300102-030405-0123abcd", "shot 1.png", 200},
		{"20300102-030405-0123abce", "notes.pdf", 404},
		{"20300102-030405-0123abcf", "a.png", 404},
		{"..", "config.json", 404},
		{"20300102-030405-0123abcd", "../x.png", 404},
		{"20300102-030405-0123abcd", "missing.png", 404},
	} {
		if got := get(c.folder, c.name); got != c.code {
			t.Errorf("%s/%s: %d, want %d", c.folder, c.name, got, c.code)
		}
	}
}
