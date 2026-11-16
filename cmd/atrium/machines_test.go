package main

import (
	"path/filepath"
	"testing"
)

// A machine's label is written to the config file, next to whatever else was
// put there by hand since the hub started.
func TestMachineLabel(t *testing.T) {
	dir := t.TempDir()
	cfg := &Config{DataDir: dir, CookieSecret: "x", Machines: map[string]*MachineConf{"m1": {TokenHash: "h"}}, Labels: map[string]string{"m1": "Box"}}
	cfg.path = filepath.Join(dir, "config.json")
	if err := cfg.save(); err != nil {
		t.Fatal(err)
	}
	s := newServer(cfg)
	if got := s.mach.label("m1"); got != "Box" {
		t.Fatalf("label: %q", got)
	}

	edited, _ := loadConfig(cfg.path) // someone adds a notify block while the hub runs
	edited.Notify = &NotifyConf{Command: []string{"true"}}
	edited.save()

	if err := s.mach.setLabel("m1", "QZ-em-train"); err != nil {
		t.Fatal(err)
	}
	if err := s.mach.setLabel("old-laptop", "Laptop"); err != nil { // one only the archive knows
		t.Fatal(err)
	}
	onDisk, err := loadConfig(cfg.path)
	if err != nil {
		t.Fatal(err)
	}
	if onDisk.Labels["m1"] != "QZ-em-train" || onDisk.Labels["old-laptop"] != "Laptop" || onDisk.Notify == nil || onDisk.Machines["m1"].TokenHash != "h" || onDisk.CookieSecret != "x" {
		t.Fatalf("the file after renaming: %+v", onDisk)
	}
	if s.mach.label("m1") != "QZ-em-train" || s.mach.label("old-laptop") != "Laptop" || s.mach.label("other") != "other" {
		t.Fatal("labels in memory")
	}
	if err := s.mach.setLabel("m1", ""); err != nil {
		t.Fatal(err)
	}
	onDisk, _ = loadConfig(cfg.path)
	if _, has := onDisk.Labels["m1"]; has || s.mach.label("m1") != "m1" {
		t.Fatal("an empty label goes back to the machine's own name")
	}
}
