// atrium: one web page to browse, search and continue coding-agent sessions
// (Claude Code, Codex) that live on several machines.
//
// The hub is the only public-facing piece. It reads history from the session
// archive (agentsview, loopback only) and talks to a small runner on every
// machine to continue or start sessions there.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

var version = "0.1.2"

func usage() {
	fmt.Fprintf(os.Stderr, `atrium %s

  atrium serve       [--config FILE]            run the server
  atrium init        [--config FILE] [--listen ADDR] [--archive-url URL] [--archive-token TOKEN]
                     [--mode local] [--login-hint TEXT]
                                                create a config with fresh secrets
  atrium add-machine [--config FILE] [--label TEXT] NAME
                                                register a machine, print its runner token once
  atrium login-link  [--config FILE] --base URL print a one-time sign-in link (valid 15 min)
  atrium version
`, version)
	os.Exit(2)
}

func defaultConfigPath() string {
	if p := os.Getenv("ATRIUM_CONFIG"); p != "" {
		return p
	}
	const server = "/srv/atrium/config.json"
	// An install on one's own computer (scripts/local-install.sh) keeps its config under the home folder.
	if _, err := os.Stat(server); err != nil {
		if h, e := os.UserHomeDir(); e == nil {
			local := filepath.Join(h, ".local", "share", "atrium", "local", "config.json")
			if _, e := os.Stat(local); e == nil {
				return local
			}
		}
	}
	return server
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	cmd, args := os.Args[1], os.Args[2:]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	cfgPath := fs.String("config", defaultConfigPath(), "config file")
	base := fs.String("base", "", "base URL the browser uses (login-link)")
	listen := fs.String("listen", "", "listen address (serve: override; init: initial value)")
	archiveURL := fs.String("archive-url", "", "where the session archive is (init)")
	archiveToken := fs.String("archive-token", "", "the archive's bearer token (init)")
	mode := fs.String("mode", "", `"local" for an install on one computer (init)`)
	loginHint := fs.String("login-hint", "", "command shown on the sign-in page (init)")
	label := fs.String("label", "", "display name of the machine (add-machine)")
	switch cmd {
	case "serve":
		fs.Parse(args)
		cfg, err := loadConfig(*cfgPath)
		if err != nil {
			log.Fatalf("config: %v", err)
		}
		if *listen != "" {
			cfg.Listen = *listen
		}
		serve(cfg)
	case "init":
		fs.Parse(args)
		if _, err := os.Stat(*cfgPath); err == nil {
			log.Fatalf("%s already exists", *cfgPath)
		}
		cfg := &Config{
			Listen:       "127.0.0.1:8090",
			ArchiveURL:   "http://127.0.0.1:8080",
			CookieSecret: randToken(32),
			Machines:     map[string]*MachineConf{},
			Labels:       map[string]string{},
			path:         *cfgPath,
		}
		if *listen != "" {
			cfg.Listen = *listen
		}
		if *archiveURL != "" {
			cfg.ArchiveURL = *archiveURL
		}
		cfg.ArchiveToken = *archiveToken
		cfg.Mode = *mode
		cfg.LoginHint = *loginHint
		if err := cfg.save(); err != nil {
			log.Fatal(err)
		}
		fmt.Println("created", *cfgPath)
	case "add-machine":
		fs.Parse(args)
		if fs.NArg() < 1 {
			usage()
		}
		cfg, err := loadConfig(*cfgPath)
		if err != nil {
			log.Fatal(err)
		}
		name := fs.Arg(0)
		tok := randToken(32)
		if cfg.Machines == nil {
			cfg.Machines = map[string]*MachineConf{}
		}
		cfg.Machines[name] = &MachineConf{TokenHash: sha256hex(tok)}
		if *label != "" {
			cfg.Labels[name] = *label
		}
		if err := cfg.save(); err != nil {
			log.Fatal(err)
		}
		// The token is printed exactly once, on stdout, so it can be piped
		// straight into the machine's runner config.
		fmt.Println(tok)
	case "login-link":
		fs.Parse(args)
		cfg, err := loadConfig(*cfgPath)
		if err != nil {
			log.Fatal(err)
		}
		code := randToken(24)
		dir := filepath.Join(cfg.dataDir(), "login-codes")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			log.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, sha256hex(code)), nil, 0o600); err != nil {
			log.Fatal(err)
		}
		fmt.Printf("%s/#login=%s\n", trimSlash(*base), code)
	case "version":
		fmt.Println(version)
	default:
		usage()
	}
}

func trimSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}

func serve(cfg *Config) {
	if err := os.MkdirAll(cfg.dataDir(), 0o700); err != nil {
		log.Fatal(err)
	}
	s := newServer(cfg)
	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           s.routes(),
		ReadHeaderTimeout: 15 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go s.background(ctx)
	go func() {
		<-ctx.Done()
		sh, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(sh)
	}()
	log.Printf("atrium %s listening on %s (archive %s)", version, cfg.Listen, cfg.ArchiveURL)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
