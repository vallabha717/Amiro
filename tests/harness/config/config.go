// Package config resolves the test system's configuration.
//
// One rule governs everything here: EVERY KEY IS OPTIONAL. A missing
// config.yaml is a valid, passing configuration -- see docs/testing/02-config.md.
// defaults.go holds the complete default tree as a Go value and is the single
// source of truth; config.example.yaml is generated from it.
//
// Precedence, lowest to highest:
//
//  1. Defaults()            defaults.go
//  2. tests/config.yaml     the user's file, if present
//  3. tests/config.local.yaml   gitignored per-machine overrides
//  4. AMIRO_TEST_* env vars env.go
//  5. CLI flags             Overrides, applied by the caller
//
// Maps merge deep; lists are replaced wholesale. Setting providers.llm in
// config.yaml replaces the default list rather than appending to it -- a
// partial list is what you meant, not a merge you have to reason about.
package config

import (
	"fmt"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Config is the whole resolved tree. Field order is the order
// config.example.yaml is generated in, so it is also the reading order.
type Config struct {
	Run       Run       `yaml:"run" json:"run"`
	Providers Providers `yaml:"providers" json:"providers"`
	Backend   Backend   `yaml:"backend" json:"backend"`
	TUI       TUI       `yaml:"tui" json:"tui"`
	UI        UI        `yaml:"ui" json:"ui"`
	Desktop   Desktop   `yaml:"desktop" json:"desktop"`
	Logging   Logging   `yaml:"logging" json:"logging"`
	Accounts  Accounts  `yaml:"accounts" json:"accounts"`
	MCP       MCP       `yaml:"mcp" json:"mcp"`
}

// Run is what to execute and how.
type Run struct {
	ID              string   `yaml:"id" json:"id"`
	Surfaces        []string `yaml:"surfaces" json:"surfaces"`
	Features        []string `yaml:"features" json:"features"`
	Tags            Tags     `yaml:"tags" json:"tags"`
	Parallel        int      `yaml:"parallel" json:"parallel"`
	Timeout         Duration `yaml:"timeout" json:"timeout"`
	TestTimeout     Duration `yaml:"testTimeout" json:"testTimeout"`
	KeepArtifacts   string   `yaml:"keepArtifacts" json:"keepArtifacts"`
	FailFast        bool     `yaml:"failFast" json:"failFast"`
	Retries         int      `yaml:"retries" json:"retries"`
	StrictCassettes bool     `yaml:"strictCassettes" json:"strictCassettes"`
	CostCeilingUSD  float64  `yaml:"costCeilingUsd" json:"costCeilingUsd"`
}

type Tags struct {
	Include []string `yaml:"include" json:"include"`
	Exclude []string `yaml:"exclude" json:"exclude"`
}

// Providers covers LLM and search credentials, and how the suite talks to
// them. See docs/testing/05-recording-and-replay.md for the four modes.
type Providers struct {
	Mode        string           `yaml:"mode" json:"mode"`
	CassetteDir string           `yaml:"cassetteDir" json:"cassetteDir"`
	Default     string           `yaml:"default" json:"default"`
	LLM         []LLMProvider    `yaml:"llm" json:"llm"`
	Search      []SearchProvider `yaml:"search" json:"search"`
	Redact      []string         `yaml:"redact" json:"redact"`
}

type LLMProvider struct {
	ID      string   `yaml:"id" json:"id"`
	APIKey  string   `yaml:"apiKey" json:"apiKey"`
	BaseURL string   `yaml:"baseUrl" json:"baseUrl"`
	Models  []string `yaml:"models" json:"models"`
}

type SearchProvider struct {
	ID     string `yaml:"id" json:"id"`
	APIKey string `yaml:"apiKey" json:"apiKey"`
}

// Backend is the Go server under test.
type Backend struct {
	Binary         string            `yaml:"binary" json:"binary"`
	BindHost       string            `yaml:"bindHost" json:"bindHost"`
	Port           int               `yaml:"port" json:"port"`
	Database       Database          `yaml:"database" json:"database"`
	WorkspaceRoot  string            `yaml:"workspaceRoot" json:"workspaceRoot"`
	Env            map[string]string `yaml:"env" json:"env"`
	StartupTimeout Duration          `yaml:"startupTimeout" json:"startupTimeout"`
}

type Database struct {
	Driver        string `yaml:"driver" json:"driver"`
	DSN           string `yaml:"dsn" json:"dsn"`
	KeepOnSuccess bool   `yaml:"keepOnSuccess" json:"keepOnSuccess"`
}

// TUI is the amiro terminal client.
type TUI struct {
	Binary        string   `yaml:"binary" json:"binary"`
	Terminal      Terminal `yaml:"terminal" json:"terminal"`
	RecordCasts   bool     `yaml:"recordCasts" json:"recordCasts"`
	GoldenUpdate  bool     `yaml:"goldenUpdate" json:"goldenUpdate"`
	SettleTimeout Duration `yaml:"settleTimeout" json:"settleTimeout"`
}

type Terminal struct {
	Width  int    `yaml:"width" json:"width"`
	Height int    `yaml:"height" json:"height"`
	Term   string `yaml:"term" json:"term"`
}

// UI is the web dashboard.
type UI struct {
	Mode       string   `yaml:"mode" json:"mode"`
	BaseURL    string   `yaml:"baseUrl" json:"baseUrl"`
	Host       string   `yaml:"host" json:"host"`
	Port       int      `yaml:"port" json:"port"`
	DistDir    string   `yaml:"distDir" json:"distDir"`
	Browsers   []string `yaml:"browsers" json:"browsers"`
	Headed     bool     `yaml:"headed" json:"headed"`
	Viewport   Viewport `yaml:"viewport" json:"viewport"`
	Video      string   `yaml:"video" json:"video"`
	Trace      string   `yaml:"trace" json:"trace"`
	Screenshot string   `yaml:"screenshot" json:"screenshot"`
	HAR        string   `yaml:"har" json:"har"`
}

type Viewport struct {
	Width  int `yaml:"width" json:"width"`
	Height int `yaml:"height" json:"height"`
}

// Desktop is the Tauri shell.
type Desktop struct {
	Enabled        string   `yaml:"enabled" json:"enabled"`
	Binary         string   `yaml:"binary" json:"binary"`
	Mode           string   `yaml:"mode" json:"mode"`
	StartupTimeout Duration `yaml:"startupTimeout" json:"startupTimeout"`
}

type Logging struct {
	Dir          string `yaml:"dir" json:"dir"`
	Level        string `yaml:"level" json:"level"`
	HTTPBodies   bool   `yaml:"httpBodies" json:"httpBodies"`
	MaxBodyBytes int    `yaml:"maxBodyBytes" json:"maxBodyBytes"`
	KeepRuns     int    `yaml:"keepRuns" json:"keepRuns"`
}

// Accounts are the identities every suite signs in as. The FIRST account
// registered against a fresh database becomes the admin
// (backend-go/internal/auth), so harness/seed always registers Admin first.
type Accounts struct {
	Admin Account `yaml:"admin" json:"admin"`
	User  Account `yaml:"user" json:"user"`
	Other Account `yaml:"other" json:"other"`
}

type Account struct {
	Email    string `yaml:"email" json:"email"`
	Password string `yaml:"password" json:"password"`
}

type MCP struct {
	UseFixtureServer bool          `yaml:"useFixtureServer" json:"useFixtureServer"`
	External         []ExternalMCP `yaml:"external" json:"external"`
}

type ExternalMCP struct {
	Name    string   `yaml:"name" json:"name"`
	Command string   `yaml:"command" json:"command"`
	Args    []string `yaml:"args" json:"args"`
	URL     string   `yaml:"url" json:"url"`
}

// Duration is a time.Duration that reads and writes as "30m" / "2m" / "5s"
// rather than a nanosecond count. yaml.v3 has no duration support of its
// own, and a config file holding 1800000000000 would be unreadable.
type Duration time.Duration

func (d Duration) Duration() time.Duration { return time.Duration(d) }

// String renders the compact form a human would write: 30m, not 30m0s.
// time.Duration.String() always emits every unit down to seconds, which
// makes a generated config.example.yaml read like machine output.
func (d Duration) String() string {
	s := time.Duration(d).String()
	for _, suffix := range []string{"0s", "0m"} {
		if len(s) > 2 && strings.HasSuffix(s, suffix) {
			trimmed := strings.TrimSuffix(s, suffix)
			// Only trim a zero component, never a significant digit:
			// "30m0s" -> "30m", but "10s" must not become "1".
			if last := trimmed[len(trimmed)-1]; last < '0' || last > '9' {
				s = trimmed
			}
		}
	}
	return s
}

func (d *Duration) UnmarshalYAML(node *yaml.Node) error {
	var s string
	if err := node.Decode(&s); err != nil {
		return fmt.Errorf("expected a duration string like 30m or 2m, got %s", node.Tag)
	}
	parsed, err := time.ParseDuration(strings.TrimSpace(s))
	if err != nil {
		return fmt.Errorf("%q is not a duration (want 30m, 2m, 500ms)", s)
	}
	*d = Duration(parsed)
	return nil
}

func (d Duration) MarshalYAML() (any, error) { return d.String(), nil }

// MarshalJSON writes the same compact form as YAML.
//
// Without this, run.json records `"timeout": 1800000000000`. That file is the
// answer to "what was this run configured with?", and answering it in
// nanoseconds means the reader has to do arithmetic to check a value they
// wrote as `30m`.
func (d Duration) MarshalJSON() ([]byte, error) {
	return []byte(`"` + d.String() + `"`), nil
}

// UnmarshalJSON accepts the string form, and also a bare number so that a
// run.json written before MarshalJSON existed still reads.
func (d *Duration) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if len(trimmed) >= 2 && trimmed[0] == '"' {
		parsed, err := time.ParseDuration(trimmed[1 : len(trimmed)-1])
		if err != nil {
			return fmt.Errorf("%s is not a duration", trimmed)
		}
		*d = Duration(parsed)
		return nil
	}
	var ns int64
	if _, err := fmt.Sscanf(trimmed, "%d", &ns); err != nil {
		return fmt.Errorf("%s is not a duration", trimmed)
	}
	*d = Duration(ns)
	return nil
}
