package config

import (
	"os"
	"path/filepath"
	"testing"
)

// writeYAML writes a config.yaml at dir/.amiro/config.yaml (project) or
// dir/config.yaml (user, dir already being .../amiro) -- callers pass the
// exact file path.
func writeYAML(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// isolatedHome points os.UserHomeDir() (via $HOME, which it reads on
// Linux/macOS) at a fresh temp directory, so a test's user config never
// touches the real machine's ~/.config/amiro/config.yaml.
func isolatedHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

// TestLoad_PrecedenceTable is the Phase 4 TUI gate's "config precedence
// table test": all four layers set DIFFERENT values for the same two
// settings, and each layer in turn is peeled back to prove the next one
// underneath actually takes over -- not just that the top layer wins once.
func TestLoad_PrecedenceTable(t *testing.T) {
	home := isolatedHome(t)
	workDir := t.TempDir()

	t.Setenv("AMIRO_DEFAULT_MODE", "auto")
	t.Setenv("AMIRO_DEFAULT_MODEL", "env-provider/env-model")
	writeYAML(t, filepath.Join(home, ".config", "amiro", "config.yaml"),
		"defaultMode: edit\ndefaultModel: user-provider/user-model\n")
	writeYAML(t, filepath.Join(workDir, ".amiro", "config.yaml"),
		"defaultMode: plan\ndefaultModel: project-provider/project-model\n")

	// All four layers present: CLI flags win.
	cfg := Load(Overrides{Mode: "interactive", Model: "cli-provider/cli-model"}, workDir)
	if cfg.DefaultMode != "interactive" {
		t.Fatalf("DefaultMode = %q, want interactive (CLI flag)", cfg.DefaultMode)
	}
	if cfg.DefaultModel == nil || cfg.DefaultModel.Provider != "cli-provider" || cfg.DefaultModel.Model != "cli-model" {
		t.Fatalf("DefaultModel = %+v, want cli-provider/cli-model", cfg.DefaultModel)
	}

	// No CLI flags: project config wins over user config and env.
	cfg = Load(Overrides{}, workDir)
	if cfg.DefaultMode != "plan" {
		t.Fatalf("DefaultMode = %q, want plan (project config)", cfg.DefaultMode)
	}
	if cfg.DefaultModel == nil || cfg.DefaultModel.Provider != "project-provider" {
		t.Fatalf("DefaultModel = %+v, want project-provider/project-model", cfg.DefaultModel)
	}

	// Remove the project file: user config wins over env.
	if err := os.RemoveAll(filepath.Join(workDir, ".amiro")); err != nil {
		t.Fatalf("remove project config: %v", err)
	}
	cfg = Load(Overrides{}, workDir)
	if cfg.DefaultMode != "edit" {
		t.Fatalf("DefaultMode = %q, want edit (user config)", cfg.DefaultMode)
	}
	if cfg.DefaultModel == nil || cfg.DefaultModel.Provider != "user-provider" {
		t.Fatalf("DefaultModel = %+v, want user-provider/user-model", cfg.DefaultModel)
	}

	// Remove the user file too: environment wins over the built-in default.
	if err := os.RemoveAll(filepath.Join(home, ".config", "amiro")); err != nil {
		t.Fatalf("remove user config: %v", err)
	}
	cfg = Load(Overrides{}, workDir)
	if cfg.DefaultMode != "auto" {
		t.Fatalf("DefaultMode = %q, want auto (environment)", cfg.DefaultMode)
	}
	if cfg.DefaultModel == nil || cfg.DefaultModel.Provider != "env-provider" {
		t.Fatalf("DefaultModel = %+v, want env-provider/env-model", cfg.DefaultModel)
	}
}

// TestLoad_NoLayersPresent_ReturnsTheZeroConfig covers the bottom of the
// stack -- a machine with no env vars and no files must not error, and must
// resolve to "nothing set," which permission.ParseMode and the server's own
// default model selection already treat as "use the built-in default."
func TestLoad_NoLayersPresent_ReturnsTheZeroConfig(t *testing.T) {
	isolatedHome(t)
	workDir := t.TempDir()

	cfg := Load(Overrides{}, workDir)
	if cfg.DefaultMode != "" {
		t.Fatalf("DefaultMode = %q, want empty", cfg.DefaultMode)
	}
	if cfg.DefaultModel != nil {
		t.Fatalf("DefaultModel = %+v, want nil", cfg.DefaultModel)
	}
}

// TestLoad_MalformedProjectFile_DegradesRatherThanFails covers a
// hand-edited config.yaml with a typo: it must not stop the TUI from
// starting, only leave that layer unapplied, falling through to whatever
// the next layer down provides.
func TestLoad_MalformedProjectFile_DegradesRatherThanFails(t *testing.T) {
	isolatedHome(t)
	workDir := t.TempDir()
	t.Setenv("AMIRO_DEFAULT_MODE", "auto")
	writeYAML(t, filepath.Join(workDir, ".amiro", "config.yaml"), "not: [valid: yaml")

	cfg := Load(Overrides{}, workDir)
	if cfg.DefaultMode != "auto" {
		t.Fatalf("DefaultMode = %q, want auto (fell through to environment past the malformed file)", cfg.DefaultMode)
	}
}

// TestLoad_ModelWithNoSlash_ReadsAsABareModelName covers a config value
// with no provider prefix.
func TestLoad_ModelWithNoSlash_ReadsAsABareModelName(t *testing.T) {
	isolatedHome(t)
	cfg := Load(Overrides{Model: "claude-sonnet-5"}, t.TempDir())
	if cfg.DefaultModel == nil || cfg.DefaultModel.Provider != "" || cfg.DefaultModel.Model != "claude-sonnet-5" {
		t.Fatalf("DefaultModel = %+v, want {Provider: \"\", Model: claude-sonnet-5}", cfg.DefaultModel)
	}
}
