package main

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
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

// wantsZh tells whether the page asked for Chinese (it sends X-Atrium-Lang).
func wantsZh(r *http.Request) bool {
	if l := r.Header.Get("X-Atrium-Lang"); l != "" {
		return l == "zh"
	}
	return strings.HasPrefix(strings.ToLower(r.Header.Get("Accept-Language")), "zh")
}

// L picks the message in the page's language.
func L(r *http.Request, zh, en string) string {
	if wantsZh(r) {
		return zh
	}
	return en
}

// errText renders err in the page's language.
func errText(r *http.Request, err error) string {
	zh, en := both(err)
	return L(r, zh, en)
}
