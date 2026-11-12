//go:build linux

package main

import (
	"os"
	"strconv"
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
	var unlock int32
	if err := ioctl(m.Fd(), syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock))); err != nil {
		m.Close()
		return nil, "", err
	}
	var n uint32
	if err := ioctl(m.Fd(), syscall.TIOCGPTN, uintptr(unsafe.Pointer(&n))); err != nil {
		m.Close()
		return nil, "", err
	}
	return m, "/dev/pts/" + strconv.Itoa(int(n)), nil
}
