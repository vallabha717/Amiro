package config

import "time"

// Defaults returns the complete default tree.
//
// This function is the single source of truth for what the suite does when
// you configure nothing. config.example.yaml is generated from it, and
// suites/meta/config_drift_test.go fails if the committed file has drifted.
//
// The defaults are chosen so that a clean checkout with no config.yaml and
// no API keys produces a green run: fake providers, sqlite, chromium, and a
// desktop surface that skips itself when cargo is absent.
func Defaults() Config {
	return Config{
		Run: Run{
			ID: "",
			// meta is included: the guards are cheap, they run first, and
			// they are what catches the test system itself degrading. A
			// default run that skipped them would let config drift or a
			// leaked secret land unnoticed.
			Surfaces: []string{"meta", "backend", "tui", "ui", "desktop", "cross"},
			Features: []string{},
			Tags: Tags{
				Include: []string{},
				Exclude: []string{"live", "slow", "flaky"},
			},
			Parallel:        4,
			Timeout:         Duration(30 * time.Minute),
			TestTimeout:     Duration(2 * time.Minute),
			KeepArtifacts:   "on-failure",
			FailFast:        false,
			Retries:         1,
			StrictCassettes: false,
			CostCeilingUSD:  2.00,
		},
		Providers: Providers{
			Mode:        "replay",
			CassetteDir: "./cassettes",
			Default:     "anthropic/claude-sonnet-5",
			LLM:         []LLMProvider{},
			Search:      []SearchProvider{},
			Redact: []string{
				"authorization",
				"cookie",
				"set-cookie",
				"x-api-key",
				"x-amiro-token",
				"x-betterchatbot-token",
				"apiKey",
				"api_key",
				"password",
				"token",
			},
		},
		Backend: Backend{
			Binary:   "",
			BindHost: "127.0.0.1",
			Port:     0,
			Database: Database{
				Driver:        "sqlite",
				DSN:           "",
				KeepOnSuccess: false,
			},
			WorkspaceRoot:  "",
			Env:            map[string]string{},
			StartupTimeout: Duration(30 * time.Second),
		},
		TUI: TUI{
			Binary: "",
			Terminal: Terminal{
				Width:  120,
				Height: 40,
				Term:   "xterm-256color",
			},
			RecordCasts:   true,
			GoldenUpdate:  false,
			SettleTimeout: Duration(5 * time.Second),
		},
		UI: UI{
			Mode:       "embedded",
			BaseURL:    "",
			Host:       "127.0.0.1",
			Port:       0,
			DistDir:    "../out",
			Browsers:   []string{"chromium"},
			Headed:     false,
			Viewport:   Viewport{Width: 1280, Height: 800},
			Video:      "retain-on-failure",
			Trace:      "on",
			Screenshot: "only-on-failure",
			HAR:        "retain-on-failure",
		},
		Desktop: Desktop{
			Enabled:        "auto",
			Binary:         "",
			Mode:           "dev",
			StartupTimeout: Duration(90 * time.Second),
		},
		Logging: Logging{
			Dir:          "./logs",
			Level:        "info",
			HTTPBodies:   true,
			MaxBodyBytes: 65536,
			KeepRuns:     20,
		},
		Accounts: Accounts{
			Admin: Account{Email: "admin@amiro.test", Password: "Amiro-Test-Admin-1"},
			User:  Account{Email: "user@amiro.test", Password: "Amiro-Test-User-1"},
			Other: Account{Email: "other@amiro.test", Password: "Amiro-Test-Other-1"},
		},
		MCP: MCP{
			UseFixtureServer: true,
			External:         []ExternalMCP{},
		},
	}
}

// Enumerations. Every one of these is checked by validate.go, and the valid
// set is printed in the error message -- a bad enum should never require
// opening the source to fix.
var (
	ValidSurfaces      = []string{"backend", "tui", "ui", "desktop", "cross", "meta"}
	ValidProviderModes = []string{"fake", "replay", "record", "live"}
	ValidKeepArtifacts = []string{"always", "on-failure", "never"}
	ValidDBDrivers     = []string{"sqlite", "postgres"}
	ValidUIModes       = []string{"embedded", "static", "dev"}
	ValidBrowsers      = []string{"chromium", "firefox", "webkit"}
	ValidVideoModes    = []string{"on", "off", "retain-on-failure"}
	ValidTraceModes    = []string{"on", "off", "retain-on-failure"}
	ValidScreenshot    = []string{"on", "off", "only-on-failure"}
	ValidHARModes      = []string{"on", "off", "retain-on-failure"}
	ValidDesktopEnable = []string{"auto", "true", "false"}
	ValidDesktopModes  = []string{"dev", "bundled"}
	ValidLogLevels     = []string{"debug", "info", "warn", "error"}
	ValidTags          = []string{"smoke", "live", "slow", "flaky", "destructive"}
)

// Provider ids the suite understands. LLM ids match
// backend-go/internal/ai/bifrost/catalog.go; search ids match
// backend-go/internal/search/registry.go. `ollama` is ours -- a local
// endpoint the catalog does not list but the suite can point at.
var (
	ValidLLMProviders    = []string{"openai", "google", "anthropic", "xai", "groq", "openRouter", "ollama"}
	ValidSearchProviders = []string{"exa", "tavily", "brave", "serper"}
)
