//go:build unix

package main

import (
	"errors"
	"fmt"
)

// biErr is an error with a Chinese and an English message; Error() is English.
type biErr struct{ zh, en string }

func (e *biErr) Error() string { return e.en }

func bi(zh, en string) error { return &biErr{zh, en} }

func bif(zh, en string, args ...any) error {
	return &biErr{fmt.Sprintf(zh, args...), fmt.Sprintf(en, args...)}
}

// both returns the two messages of err (the same text twice for a plain error).
func both(err error) (zh, en string) {
	var b *biErr
	if errors.As(err, &b) {
		return b.zh, b.en
	}
	return err.Error(), err.Error()
}
