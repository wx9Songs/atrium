//go:build unix

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

// The Files panel: list a folder, read a text file, save it back. Like the
// terminal, it only works when this machine's runner config allows it.

const (
	maxReadSize  = 2 << 20
	maxListCount = 3000
)

func (r *Runner) cleanPath(path string) (string, error) {
	if path == "" || path == "~" {
		path = r.home
	}
	if strings.HasPrefix(path, "~/") {
		path = filepath.Join(r.home, path[2:])
	}
	path = filepath.Clean(path)
	if !filepath.IsAbs(path) {
		return "", bi("需要绝对路径", "An absolute path is required")
	}
	return path, nil
}

func (r *Runner) fsList(path string) (any, error) {
	if !r.cfg.AllowShell {
		return nil, errShellOff
	}
	path, err := r.cleanPath(path)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, bif("读不了这个目录：%v", "Cannot read this folder: %v", err)
	}
	type item struct {
		Name  string `json:"name"`
		Dir   bool   `json:"dir,omitempty"`
		Size  int64  `json:"size,omitempty"`
		Mtime int64  `json:"mtime,omitempty"`
	}
	items := make([]item, 0, len(entries))
	for _, e := range entries {
		it := item{Name: e.Name(), Dir: e.IsDir()}
		// Follow links, so a linked folder opens as a folder.
		if fi, err := os.Stat(filepath.Join(path, e.Name())); err == nil {
			it.Dir = fi.IsDir()
			if !it.Dir {
				it.Size = fi.Size()
			}
			it.Mtime = fi.ModTime().UnixMilli()
		}
		items = append(items, it)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Dir != items[j].Dir {
			return items[i].Dir
		}
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	more := false
	if len(items) > maxListCount {
		items, more = items[:maxListCount], true
	}
	return map[string]any{"path": path, "parent": filepath.Dir(path), "home": r.home, "entries": items, "more": more}, nil
}

func (r *Runner) fsRead(path string) (any, error) {
	if !r.cfg.AllowShell {
		return nil, errShellOff
	}
	path, err := r.cleanPath(path)
	if err != nil {
		return nil, err
	}
	fi, err := os.Stat(path)
	if err != nil {
		return nil, bif("打不开这个文件：%v", "Cannot open this file: %v", err)
	}
	if fi.IsDir() {
		return nil, bi("这是一个目录", "This is a folder")
	}
	out := map[string]any{"path": path, "size": fi.Size(), "mtime": fi.ModTime().UnixMilli()}
	if fi.Size() > maxReadSize {
		out["too_big"] = true
		return out, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, bif("打不开这个文件：%v", "Cannot open this file: %v", err)
	}
	head := b
	if len(head) > 8192 {
		head = head[:8192]
	}
	if bytes.IndexByte(head, 0) >= 0 || !utf8.Valid(b) {
		out["binary"] = true
		return out, nil
	}
	out["content"] = string(b)
	return out, nil
}

// fsWrite saves a file. When the page says which version it was editing
// (expectMtime), a file changed since then is not overwritten.
func (r *Runner) fsWrite(path, content string, expectMtime int64) (any, error) {
	if !r.cfg.AllowShell {
		return nil, errShellOff
	}
	path, err := r.cleanPath(path)
	if err != nil {
		return nil, err
	}
	// Write through a link to the file it points at, rather than replacing the link.
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	mode := os.FileMode(0o644)
	if fi, err := os.Stat(path); err == nil {
		if fi.IsDir() {
			return nil, bi("这是一个目录", "This is a folder")
		}
		if expectMtime != 0 && fi.ModTime().UnixMilli() != expectMtime {
			return nil, bi("这个文件在你打开之后被别处改动过。重新载入，或者选择覆盖保存。", "This file was changed elsewhere after you opened it. Reload it, or choose to overwrite.")
		}
		mode = fi.Mode().Perm()
	} else if expectMtime != 0 {
		return nil, bi("这个文件已经不存在了", "This file no longer exists")
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".atrium-save-*")
	if err != nil {
		return nil, bif("保存失败：%v", "Could not save: %v", err)
	}
	_, werr := tmp.WriteString(content)
	cerr := tmp.Close()
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Chmod(tmp.Name(), mode)
	}
	if werr == nil {
		werr = os.Rename(tmp.Name(), path)
	}
	if werr != nil {
		os.Remove(tmp.Name())
		return nil, bif("保存失败：%v", "Could not save: %v", werr)
	}
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": path, "size": fi.Size(), "mtime": fi.ModTime().UnixMilli()}, nil
}
