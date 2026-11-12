//go:build darwin

package main

import (
	"bytes"
	"os"
	"syscall"
	"unsafe"
)

// openPTY opens a new pseudo-terminal and returns its controlling end and the
// path of the end a shell attaches to.
func openPTY() (*os.File, string, error) {
	m, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, "", err
	}
	if err := ioctl(m.Fd(), syscall.TIOCPTYGRANT, 0); err != nil {
		m.Close()
		return nil, "", err
	}
	if err := ioctl(m.Fd(), syscall.TIOCPTYUNLK, 0); err != nil {
		m.Close()
		return nil, "", err
	}
	var name [128]byte
	if err := ioctl(m.Fd(), syscall.TIOCPTYGNAME, uintptr(unsafe.Pointer(&name[0]))); err != nil {
		m.Close()
		return nil, "", err
	}
	end := bytes.IndexByte(name[:], 0)
	if end < 0 {
		end = len(name)
	}
	return m, string(name[:end]), nil
}
