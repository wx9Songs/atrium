//go:build unix

package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testRunner(t *testing.T, shell bool) *Runner {
	t.Helper()
	return &Runner{
		cfg: Config{AllowShell: shell}, home: t.TempDir(),
		procs: map[string]*proc{}, terms: map[string]*term{}, caps: map[string]string{},
		out: make(chan outEvent, 64), fast: make(chan outEvent, 1024),
	}
}

// until reads terminal events until one satisfies done, returning the output seen so far.
func until(t *testing.T, r *Runner, done func(out string, e outEvent) bool) string {
	t.Helper()
	var out strings.Builder
	deadline := time.After(15 * time.Second)
	for {
		select {
		case e := <-r.fast:
			if e.T == "term_out" {
				b, _ := base64.StdEncoding.DecodeString(e.Data.(map[string]any)["data"].(string))
				out.Write(b)
			}
			if done(out.String(), e) {
				return out.String()
			}
		case <-deadline:
			t.Fatalf("timed out; output so far: %q", out.String())
		}
	}
}

func TestTerminal(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	r := testRunner(t, true)
	dir := t.TempDir()
	r.termOpen("t1", dir, 100, 30)
	if r.term("t1") == nil {
		t.Fatal("terminal did not start")
	}
	// A real terminal: the shell sees a tty of the size we asked for, in the folder we asked for.
	r.termInput("t1", "echo size=$(stty size) tty=$(test -t 0 && echo yes) dir=$(basename \"$PWD\") 你好\n")
	out := until(t, r, func(out string, _ outEvent) bool { return strings.Contains(out, "size=30 100") })
	for _, want := range []string{"tty=yes", "dir=" + filepath.Base(dir), "你好"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q: %q", want, out)
		}
	}
	r.termResize("t1", 80, 24)
	r.termInput("t1", "echo resized=$(stty size)\n")
	until(t, r, func(out string, _ outEvent) bool { return strings.Contains(out, "resized=24 80") })

	r.termInput("t1", "exit 3\n")
	until(t, r, func(_ string, e outEvent) bool {
		return e.T == "term_exit" && e.Data.(map[string]any)["code"] == 3
	})
	if r.term("t1") != nil {
		t.Error("terminal still listed after its shell exited")
	}
}

func TestTerminalClose(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	r := testRunner(t, true)
	r.termOpen("t2", "", 80, 24)
	r.termInput("t2", "sleep 600\n")
	time.Sleep(200 * time.Millisecond)
	r.termClose("t2")
	until(t, r, func(_ string, e outEvent) bool { return e.T == "term_exit" })
}

func TestTerminalNeedsOptIn(t *testing.T) {
	r := testRunner(t, false)
	r.termOpen("t3", "", 80, 24)
	e := <-r.fast
	if e.T != "term_exit" || r.term("t3") != nil || !strings.Contains(e.Data.(map[string]any)["error"].(string), "allow_shell") {
		t.Fatalf("a runner without allow_shell must refuse: %+v", e)
	}
	if _, err := r.fsList(r.home); err == nil {
		t.Error("fsList must refuse without allow_shell")
	}
	if _, err := r.fsRead(filepath.Join(r.home, "x")); err == nil {
		t.Error("fsRead must refuse without allow_shell")
	}
	if _, err := r.fsWrite(filepath.Join(r.home, "x"), "x", 0); err == nil {
		t.Error("fsWrite must refuse without allow_shell")
	}
	if _, err := os.Stat(filepath.Join(r.home, "x")); err == nil {
		t.Error("a refused write created the file")
	}
}

func TestFiles(t *testing.T) {
	r := testRunner(t, true)
	dir := r.home
	os.Mkdir(filepath.Join(dir, "src"), 0o755)
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("你好\n"), 0o600)
	os.WriteFile(filepath.Join(dir, ".env"), []byte("A=1\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "bin.dat"), []byte{1, 0, 2}, 0o644)

	res, err := r.fsList("~")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, it := range toMaps(t, res.(map[string]any)["entries"]) {
		names = append(names, it["name"].(string))
	}
	if got := strings.Join(names, ","); got != "src,.env,b.txt,bin.dat" {
		t.Errorf("listing (folders first, dotfiles shown): %s", got)
	}

	file := filepath.Join(dir, "b.txt")
	read, err := r.fsRead(file)
	if err != nil {
		t.Fatal(err)
	}
	m := read.(map[string]any)
	if m["content"] != "你好\n" {
		t.Errorf("content: %q", m["content"])
	}
	mtime := m["mtime"].(int64)

	if b, _ := r.fsRead(filepath.Join(dir, "bin.dat")); b.(map[string]any)["binary"] != true {
		t.Error("a file with NUL bytes should be reported as binary")
	}

	saved, err := r.fsWrite(file, "改过了\n", mtime)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(file); string(b) != "改过了\n" {
		t.Errorf("saved content: %q", b)
	}
	if fi, _ := os.Stat(file); fi.Mode().Perm() != 0o600 {
		t.Errorf("saving changed the file mode to %v", fi.Mode().Perm())
	}
	// Someone else changes the file: saving the stale copy is refused, the forced save is not.
	later := time.Now().Add(3 * time.Second)
	os.WriteFile(file, []byte("别处改的\n"), 0o600)
	os.Chtimes(file, later, later)
	if _, err := r.fsWrite(file, "旧稿\n", saved.(map[string]any)["mtime"].(int64)); err == nil {
		t.Error("overwrote a file that changed after it was opened")
	}
	if _, err := r.fsWrite(file, "强制\n", 0); err != nil {
		t.Errorf("forced save: %v", err)
	}
	// A link is written through, not replaced.
	link := filepath.Join(dir, "link.txt")
	os.Symlink(file, link)
	if _, err := r.fsWrite(link, "经由链接\n", 0); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Lstat(link); fi.Mode()&os.ModeSymlink == 0 {
		t.Error("saving through a link replaced the link")
	}
	if b, _ := os.ReadFile(file); string(b) != "经由链接\n" {
		t.Errorf("target after saving through link: %q", b)
	}
}

func toMaps(t *testing.T, v any) []map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}
