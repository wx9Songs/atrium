//go:build unix && !linux && !darwin

package main

import "os"

func openPTY() (*os.File, string, error) {
	return nil, "", bi("这个系统上还不支持终端", "The terminal is not supported on this system yet")
}
