package config

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

// Problem is one thing wrong with the configuration, located precisely
// enough to fix without searching.
type Problem struct {
	File       string `json:"file,omitempty"`
	Line       int    `json:"line,omitempty"`
	Key        string `json:"key,omitempty"`
	Message    string `json:"message"`
	Suggestion string `json:"suggestion,omitempty"`
}

func (p Problem) String() string {
	var b strings.Builder
	if p.File != "" {
		b.WriteString(p.File)
		if p.Line > 0 {
			fmt.Fprintf(&b, ":%d", p.Line)
		}
		b.WriteString(": ")
	}
	b.WriteString(p.Message)
	if p.Suggestion != "" {
		fmt.Fprintf(&b, " (did you mean %q?)", p.Suggestion)
	}
	return b.String()
}

// ValidationError carries EVERY problem found, not the first.
//
// Reporting one error per run turns fixing a config file into a guessing
// loop. Exit code 2 (docs/testing/03-selection.md) means "nothing was run",
// and the user should be able to fix everything before the next attempt.
type ValidationError struct {
	Problems []Problem
}

func (e *ValidationError) Error() string {
	if len(e.Problems) == 1 {
		return "configuration error: " + e.Problems[0].String()
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d configuration errors:\n", len(e.Problems))
	for _, p := range e.Problems {
		fmt.Fprintf(&b, "  - %s\n", p.String())
	}
	return strings.TrimRight(b.String(), "\n")
}

// Validate checks the fully resolved tree and returns every error at once,
// plus warnings for things that are legal but usually unintended.
//
// baseDir is what relative paths resolve against -- the tests/ directory.
func Validate(cfg *Config, baseDir string) (warnings []Problem, err error) {
	var problems []Problem

	enum := func(key, got string, valid []string) {
		if got == "" {
			return
		}
		if !slices.Contains(valid, got) {
			problems = append(problems, Problem{
				Key:        key,
				Message:    fmt.Sprintf("%s: %q is not valid (want one of: %s)", key, got, strings.Join(valid, ", ")),
				Suggestion: suggest(got, valid),
			})
		}
	}
	enumList := func(key string, got []string, valid []string) {
		for i, v := range got {
			if !slices.Contains(valid, v) {
				problems = append(problems, Problem{
					Key:        fmt.Sprintf("%s[%d]", key, i),
					Message:    fmt.Sprintf("%s[%d]: %q is not valid (want one of: %s)", key, i, v, strings.Join(valid, ", ")),
					Suggestion: suggest(v, valid),
				})
			}
		}
	}

	// --- enums -------------------------------------------------------
	enumList("run.surfaces", cfg.Run.Surfaces, ValidSurfaces)
	enumList("run.tags.include", cfg.Run.Tags.Include, ValidTags)
	enumList("run.tags.exclude", cfg.Run.Tags.Exclude, ValidTags)
	enum("run.keepArtifacts", cfg.Run.KeepArtifacts, ValidKeepArtifacts)
	enum("providers.mode", cfg.Providers.Mode, ValidProviderModes)
	enum("backend.database.driver", cfg.Backend.Database.Driver, ValidDBDrivers)
	enum("ui.mode", cfg.UI.Mode, ValidUIModes)
	enumList("ui.browsers", cfg.UI.Browsers, ValidBrowsers)
	enum("ui.video", cfg.UI.Video, ValidVideoModes)
	enum("ui.trace", cfg.UI.Trace, ValidTraceModes)
	enum("ui.screenshot", cfg.UI.Screenshot, ValidScreenshot)
	enum("ui.har", cfg.UI.HAR, ValidHARModes)
	enum("desktop.enabled", cfg.Desktop.Enabled, ValidDesktopEnable)
	enum("desktop.mode", cfg.Desktop.Mode, ValidDesktopModes)
	enum("logging.level", cfg.Logging.Level, ValidLogLevels)
	for i, p := range cfg.Providers.LLM {
		enum(fmt.Sprintf("providers.llm[%d].id", i), p.ID, ValidLLMProviders)
	}
	for i, p := range cfg.Providers.Search {
		enum(fmt.Sprintf("providers.search[%d].id", i), p.ID, ValidSearchProviders)
	}

	// --- numeric ranges ----------------------------------------------
	if cfg.Run.Parallel < 1 {
		problems = append(problems, Problem{Key: "run.parallel",
			Message: fmt.Sprintf("run.parallel: %d is not valid (must be at least 1)", cfg.Run.Parallel)})
	}
	if cfg.Run.Retries < 0 {
		problems = append(problems, Problem{Key: "run.retries",
			Message: fmt.Sprintf("run.retries: %d is not valid (must be 0 or more)", cfg.Run.Retries)})
	}
	if cfg.Logging.KeepRuns < 0 {
		problems = append(problems, Problem{Key: "logging.keepRuns",
			Message: fmt.Sprintf("logging.keepRuns: %d is not valid (0 disables pruning; negative is meaningless)", cfg.Logging.KeepRuns)})
	}
	if cfg.Logging.MaxBodyBytes < 0 {
		problems = append(problems, Problem{Key: "logging.maxBodyBytes",
			Message: "logging.maxBodyBytes: must be 0 or more (0 records no bodies)"})
	}
	if cfg.TUI.Terminal.Width < 20 || cfg.TUI.Terminal.Height < 5 {
		problems = append(problems, Problem{Key: "tui.terminal",
			Message: fmt.Sprintf("tui.terminal: %dx%d is too small to render into (minimum 20x5)",
				cfg.TUI.Terminal.Width, cfg.TUI.Terminal.Height)})
	}
	if cfg.Backend.Port < 0 || cfg.Backend.Port > 65535 {
		problems = append(problems, Problem{Key: "backend.port",
			Message: fmt.Sprintf("backend.port: %d is not a port (0 means OS-assigned)", cfg.Backend.Port)})
	}
	if cfg.UI.Port < 0 || cfg.UI.Port > 65535 {
		problems = append(problems, Problem{Key: "ui.port",
			Message: fmt.Sprintf("ui.port: %d is not a port (0 means OS-assigned)", cfg.UI.Port)})
	}

	// --- paths that must exist if set --------------------------------
	mustExist := func(key, path string, wantDir bool) {
		if path == "" {
			return
		}
		full := Resolve(baseDir, path)
		info, statErr := os.Stat(full)
		if statErr != nil {
			problems = append(problems, Problem{Key: key,
				Message: fmt.Sprintf("%s: %s does not exist", key, full)})
			return
		}
		if wantDir && !info.IsDir() {
			problems = append(problems, Problem{Key: key,
				Message: fmt.Sprintf("%s: %s is a file, expected a directory", key, full)})
		}
		if !wantDir && info.IsDir() {
			problems = append(problems, Problem{Key: key,
				Message: fmt.Sprintf("%s: %s is a directory, expected an executable", key, full)})
		}
	}
	mustExist("backend.binary", cfg.Backend.Binary, false)
	mustExist("tui.binary", cfg.TUI.Binary, false)
	mustExist("desktop.binary", cfg.Desktop.Binary, false)
	mustExist("backend.workspaceRoot", cfg.Backend.WorkspaceRoot, true)
	// providers.cassetteDir is only required to exist in replay mode; in
	// record mode the whole point is that it is about to be created.
	if cfg.Providers.Mode == "replay" && cfg.Providers.CassetteDir != "" {
		if _, statErr := os.Stat(Resolve(baseDir, cfg.Providers.CassetteDir)); statErr != nil {
			warnings = append(warnings, Problem{Key: "providers.cassetteDir",
				Message: fmt.Sprintf("providers.cassetteDir: %s does not exist -- every request will be a cassette miss",
					Resolve(baseDir, cfg.Providers.CassetteDir))})
		}
	}

	// --- cross-field rules -------------------------------------------
	if cfg.Providers.Mode == "record" || cfg.Providers.Mode == "live" {
		if !cfg.HasAnyProviderKey() {
			problems = append(problems, Problem{Key: "providers.mode",
				Message: fmt.Sprintf("providers.mode: %q needs at least one provider with a non-empty apiKey, and none of the %d configured providers has one",
					cfg.Providers.Mode, len(cfg.Providers.LLM))})
		}
	}
	if cfg.Backend.Database.Driver == "postgres" && cfg.Backend.Database.DSN == "" {
		problems = append(problems, Problem{Key: "backend.database.dsn",
			Message: "backend.database.dsn: required when backend.database.driver is postgres"})
	}
	if cfg.UI.Mode == "static" {
		dist := Resolve(baseDir, cfg.UI.DistDir)
		if _, statErr := os.Stat(filepath.Join(dist, "index.html")); statErr != nil {
			problems = append(problems, Problem{Key: "ui.distDir",
				Message: fmt.Sprintf("ui.distDir: ui.mode is static but %s contains no index.html (run `pnpm build` first)", dist)})
		}
	}

	// --- warnings: legal, but usually not what was meant --------------
	if cfg.UI.Host == "0.0.0.0" || cfg.Backend.BindHost == "0.0.0.0" {
		warnings = append(warnings, Problem{Key: "ui.host",
			Message: "binding 0.0.0.0 makes the test dashboard reachable from every host on the network; Amiro runs shell commands and reads files"})
	}
	if cfg.Run.Retries > 3 {
		warnings = append(warnings, Problem{Key: "run.retries",
			Message: fmt.Sprintf("run.retries: %d retries will hide a race rather than reveal it; CI should use 0", cfg.Run.Retries)})
	}
	if cfg.Logging.KeepRuns == 0 {
		warnings = append(warnings, Problem{Key: "logging.keepRuns",
			Message: "logging.keepRuns: 0 disables pruning entirely; logs/ will grow without bound"})
	}
	if cfg.Providers.Mode == "live" {
		warnings = append(warnings, Problem{Key: "providers.mode",
			Message: fmt.Sprintf("providers.mode: live calls real APIs and spends real money (ceiling $%.2f)", cfg.Run.CostCeilingUSD)})
	}
	if cfg.TUI.GoldenUpdate {
		warnings = append(warnings, Problem{Key: "tui.goldenUpdate",
			Message: "tui.goldenUpdate: golden files will be REWRITTEN, not compared; no TUI rendering assertion can fail this run"})
	}

	sort.SliceStable(problems, func(i, j int) bool {
		if problems[i].File != problems[j].File {
			return problems[i].File < problems[j].File
		}
		return problems[i].Line < problems[j].Line
	})
	if len(problems) > 0 {
		return warnings, &ValidationError{Problems: problems}
	}
	return warnings, nil
}

// HasAnyProviderKey reports whether at least one configured LLM provider
// carries a usable key. Providers whose ${VAR} expanded to nothing count as
// absent, which is what makes "six providers listed, one key exported" work.
func (c *Config) HasAnyProviderKey() bool {
	for _, p := range c.Providers.LLM {
		if strings.TrimSpace(p.APIKey) != "" {
			return true
		}
		// A local endpoint (ollama) legitimately has no key.
		if p.ID == "ollama" && p.BaseURL != "" {
			return true
		}
	}
	return false
}

// DropUnconfiguredProviders removes providers whose apiKey expanded to
// nothing and returns their ids, for the note run.json carries.
//
// This is the "a config.yaml listing six providers on a machine with one
// key does the obvious thing" rule from docs/testing/02-config.md. It is a
// mutation rather than a filter at use time so that every later consumer --
// seeding, the cassette proxy, the summary -- sees one consistent list.
func (c *Config) DropUnconfiguredProviders() (dropped []string) {
	kept := c.Providers.LLM[:0:0]
	for _, p := range c.Providers.LLM {
		if strings.TrimSpace(p.APIKey) == "" && !(p.ID == "ollama" && p.BaseURL != "") {
			dropped = append(dropped, p.ID)
			continue
		}
		kept = append(kept, p)
	}
	c.Providers.LLM = kept

	keptSearch := c.Providers.Search[:0:0]
	for _, p := range c.Providers.Search {
		if strings.TrimSpace(p.APIKey) == "" {
			dropped = append(dropped, p.ID)
			continue
		}
		keptSearch = append(keptSearch, p)
	}
	c.Providers.Search = keptSearch
	return dropped
}

// Resolve turns a possibly-relative config path into an absolute one,
// against the tests/ directory rather than the process working directory --
// `go test ./suites/backend/smoke` runs with a cwd four levels down, and
// "./cassettes" has to mean the same thing there as it does from tests/.
func Resolve(baseDir, path string) string {
	if path == "" {
		return ""
	}
	expanded := path
	if strings.HasPrefix(expanded, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			expanded = filepath.Join(home, expanded[2:])
		}
	}
	if filepath.IsAbs(expanded) {
		return filepath.Clean(expanded)
	}
	return filepath.Clean(filepath.Join(baseDir, expanded))
}
