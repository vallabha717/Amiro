// Package config resolves the TUI's user-facing preferences -- plan §2.8:
// "YAML file for preferences, DB for shared state, keyring for secrets."
// This is deliberately a different config from internal/config, which
// resolves the *sidecar's* bootstrap settings (auth token, bind host,
// database DSN) from AMIRO_* environment variables alone and has no notion
// of a file on disk. The two would collide if merged: a value a user can
// hand-edit and diff (default model, default permission mode) is not the
// same kind of thing as a shared-secret token generated at first run.
//
// Precedence, highest to lowest: CLI flags → project ./.amiro/config.yaml
// → user ~/.config/amiro/config.yaml → AMIRO_* environment → built-in
// defaults (the zero Config). Both amiro and the desktop sidecar read the
// same two file paths, so a default set from the terminal applies in the
// desktop app too -- the file is the shared surface, not a second
// database.
package config

import (
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// ChatModel selects a provider/model pair -- config.yaml's "provider/model"
// string, parsed.
type ChatModel struct {
	Provider string
	Model    string
}

// Config is every preference this layer resolves. The zero Config is the
// correct "nothing was ever set" value: DefaultModel nil (server picks),
// DefaultMode "" (permission.ParseMode's own interactive fallback).
type Config struct {
	DefaultModel *ChatModel
	DefaultMode  string
}

// Overrides is the CLI-flag layer -- the highest precedence, and the only
// one a caller has to build itself (cmd/amiro/tui.go's flag.FlagSet
// values). Empty fields mean "not passed on the command line," not "unset
// this," so Load never has to distinguish a flag's zero value from its
// absence.
type Overrides struct {
	Model string // "provider/model", e.g. "anthropic/claude-sonnet-5"
	Mode  string
}

// file is one config.yaml's on-disk shape.
type file struct {
	DefaultModel string `yaml:"defaultModel"`
	DefaultMode  string `yaml:"defaultMode"`
}

// Load resolves Config for a TUI launched with workDir as its workspace
// root (the project config lives at workDir/.amiro/config.yaml -- the
// directory the TUI was launched from, per cmd/amiro's own resolution, not
// necessarily the process's cwd if -C was passed).
//
// Every layer degrades independently rather than failing the whole call: a
// missing file is not an error (most machines have none), and a malformed
// one is treated the same as a missing one (see applyFile) -- a typo in a
// hand-edited YAML file should not stop the TUI from starting, only leave
// that layer's overrides unapplied.
func Load(overrides Overrides, workDir string) Config {
	var cfg Config

	// Layer 4 (lowest): built-in defaults are the zero Config above --
	// nothing to apply.

	// Layer 3: environment.
	if v := os.Getenv("AMIRO_DEFAULT_MODE"); v != "" {
		cfg.DefaultMode = v
	}
	if v := os.Getenv("AMIRO_DEFAULT_MODEL"); v != "" {
		cfg.DefaultModel = parseModel(v)
	}

	// Layer 2: user config.
	if home, err := os.UserHomeDir(); err == nil {
		applyFile(&cfg, filepath.Join(home, ".config", "amiro", "config.yaml"))
	}

	// Layer 1: project config.
	applyFile(&cfg, filepath.Join(workDir, ".amiro", "config.yaml"))

	// Layer 0 (highest): CLI flags.
	if overrides.Mode != "" {
		cfg.DefaultMode = overrides.Mode
	}
	if overrides.Model != "" {
		cfg.DefaultModel = parseModel(overrides.Model)
	}

	return cfg
}

// applyFile reads path and overlays whatever it sets onto cfg -- called
// once for the user config, once for the project config, in that order, so
// the project file (applied second) wins between the two of them, matching
// the precedence table's "project → user" ordering.
func applyFile(cfg *Config, path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var f file
	if err := yaml.Unmarshal(data, &f); err != nil {
		return
	}
	if f.DefaultMode != "" {
		cfg.DefaultMode = f.DefaultMode
	}
	if f.DefaultModel != "" {
		cfg.DefaultModel = parseModel(f.DefaultModel)
	}
}

// parseModel splits "provider/model" -- a value with no "/" is read as a
// bare model name with no provider override, which bifrostai.Resolve
// already treats as "use this model on whichever provider serves it."
func parseModel(s string) *ChatModel {
	provider, model, ok := strings.Cut(s, "/")
	if !ok {
		return &ChatModel{Model: s}
	}
	return &ChatModel{Provider: provider, Model: model}
}
