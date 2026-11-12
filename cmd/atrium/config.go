package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
)

type MachineConf struct {
	TokenHash string `json:"token_hash"`
}

type Config struct {
	Listen       string `json:"listen"`
	ArchiveURL   string `json:"archive_url"`
	ArchiveToken string `json:"archive_token"`
	CookieSecret string `json:"cookie_secret"`
	DataDir      string `json:"data_dir,omitempty"`
	// DevNoAuth disables browser sign-in. Only for local development on loopback.
	DevNoAuth bool `json:"dev_no_auth,omitempty"`
	// Machines that may run a runner (name -> hashed token).
	Machines map[string]*MachineConf `json:"machines"`
	// Labels shown in the UI for machine keys (archive keys and runner names).
	Labels map[string]string `json:"labels,omitempty"`
	// LoginHint is the command shown on the sign-in page (how this install
	// produces a sign-in link). Empty shows the generic instruction.
	LoginHint string `json:"login_hint,omitempty"`

	path string
}

func loadConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c := &Config{}
	if err := json.Unmarshal(b, c); err != nil {
		return nil, err
	}
	c.path = path
	if c.Listen == "" {
		c.Listen = "127.0.0.1:8090"
	}
	if c.Machines == nil {
		c.Machines = map[string]*MachineConf{}
	}
	if c.Labels == nil {
		c.Labels = map[string]string{}
	}
	return c, nil
}

func (c *Config) dataDir() string {
	if c.DataDir != "" {
		return c.DataDir
	}
	return filepath.Join(filepath.Dir(c.path), "data")
}

func (c *Config) save() error {
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(c.path, b, 0o600)
}

func writeFileAtomic(path string, b []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func randToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func sha256hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
