//go:build unix

package main

import (
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// The Terminal panel: a real login shell on this machine, in a session's
// working directory, attached to a pseudo-terminal. What you would get by
// opening a terminal here (or SSHing in), carried over the runner's existing
// connection to the hub. It only exists when this machine's runner config
// says "allow_shell": true.

const maxTerms = 16

type term struct {
	id     string
	master *os.File
	cmd    *exec.Cmd
	once   sync.Once
}

var errShellOff = bi(
	"这台机器没有开启终端和文件。要开启，在它的 runner.json 里加上 \"allow_shell\": true 并重启 runner。",
	"The terminal and files are off on this machine. To turn them on, add \"allow_shell\": true to its runner.json and restart the runner.")

func ioctl(fd, req, arg uintptr) error {
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, req, arg); e != 0 {
		return e
	}
	return nil
}

type winsize struct{ Rows, Cols, X, Y uint16 }

func setWinsize(f *os.File, cols, rows int) {
	if cols < 2 || rows < 2 || cols > 1000 || rows > 1000 {
		return
	}
	ws := winsize{Rows: uint16(rows), Cols: uint16(cols)}
	ioctl(f.Fd(), syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
}

func (r *Runner) termOpen(id, cwd string, cols, rows int) {
	fail := func(err error) {
		zh, en := both(err)
		r.emitFast(id, "term_exit", map[string]any{"code": -1, "error": en, "error_zh": zh})
	}
	if id == "" {
		return
	}
	if !r.cfg.AllowShell {
		fail(errShellOff)
		return
	}
	r.mu.Lock()
	n := len(r.terms)
	_, dup := r.terms[id]
	r.mu.Unlock()
	if dup {
		return
	}
	if n >= maxTerms {
		fail(bi("这台机器上打开的终端太多了，先关掉几个", "Too many terminals are open on this machine. Close some first"))
		return
	}
	if cwd == "" || !isDir(cwd) {
		cwd = r.home
	}
	master, slaveName, err := openPTY()
	if err != nil {
		fail(err)
		return
	}
	slave, err := os.OpenFile(slaveName, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		master.Close()
		fail(err)
		return
	}
	setWinsize(master, cols, rows)
	sh := os.Getenv("SHELL")
	if sh == "" || !exists(sh) {
		sh = "/bin/sh"
	}
	cmd := exec.Command(sh, "-l")
	cmd.Dir = cwd
	env := setEnv(os.Environ(), "TERM", "xterm-256color")
	env = setEnv(env, "COLORTERM", "truecolor")
	if os.Getenv("LANG") == "" && os.Getenv("LC_ALL") == "" {
		env = setEnv(env, "LANG", "en_US.UTF-8") // a service has no locale; without one, non-ASCII file names turn to escapes
	}
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		slave.Close()
		master.Close()
		fail(err)
		return
	}
	slave.Close()
	t := &term{id: id, master: master, cmd: cmd}
	r.mu.Lock()
	r.terms[id] = t
	r.mu.Unlock()

	// Output is gathered for a few milliseconds before it is sent, so a flood
	// (`cat` of a big file) becomes a hundred messages a second, not thousands.
	chunks := make(chan []byte, 64)
	go func() {
		buf := make([]byte, 32<<10)
		for {
			n, err := master.Read(buf)
			if n > 0 {
				chunks <- append([]byte(nil), buf[:n]...)
			}
			if err != nil {
				close(chunks)
				return
			}
		}
	}()
	go func() {
		var pending []byte
		flush := func() {
			if len(pending) > 0 {
				r.emitFast(id, "term_out", map[string]any{"data": base64.StdEncoding.EncodeToString(pending)})
				pending = nil
			}
		}
		tick := time.NewTicker(10 * time.Millisecond)
		defer tick.Stop()
	loop:
		for {
			select {
			case c, ok := <-chunks:
				if !ok {
					break loop
				}
				pending = append(pending, c...)
				if len(pending) >= 64<<10 {
					flush()
				}
			case <-tick.C:
				flush()
			}
		}
		flush()
		waitErr := cmd.Wait()
		t.close()
		r.mu.Lock()
		delete(r.terms, id)
		r.mu.Unlock()
		code := 0
		var ee *exec.ExitError
		if errors.As(waitErr, &ee) {
			code = ee.ExitCode()
		}
		r.emitFast(id, "term_exit", map[string]any{"code": code})
	}()
}

func (t *term) close() { t.once.Do(func() { t.master.Close() }) }

func (r *Runner) term(id string) *term {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.terms[id]
}

func (r *Runner) termInput(id, data string) {
	if t := r.term(id); t != nil {
		t.master.Write([]byte(data))
	}
}

func (r *Runner) termResize(id string, cols, rows int) {
	if t := r.term(id); t != nil {
		setWinsize(t.master, cols, rows)
	}
}

// termClose hangs up the terminal, as closing its window would.
func (r *Runner) termClose(id string) {
	t := r.term(id)
	if t == nil {
		// Already gone here (or never started): let the hub close its side.
		r.emitFast(id, "term_exit", map[string]any{"code": 0})
		return
	}
	pid := t.cmd.Process.Pid
	syscall.Kill(-pid, syscall.SIGHUP)
	go func() {
		time.Sleep(1500 * time.Millisecond)
		if t.cmd.ProcessState == nil {
			syscall.Kill(-pid, syscall.SIGKILL)
		}
		t.close()
	}()
}
