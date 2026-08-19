package config_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"amiro/tests/harness"
)

func TestConfig_Precedence(t *testing.T) {
	// Precedence order: CLI -> project -> user -> AMIRO_* -> defaults
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	workDir := filepath.Join(h.Dir(), "project-workdir")
	_ = os.MkdirAll(filepath.Join(workDir, ".amiro"), 0o755)
	homeDir := filepath.Join(h.Dir(), "user-home")
	_ = os.MkdirAll(filepath.Join(homeDir, ".config", "amiro"), 0o755)

	// Set user config to defaultMode: plan
	userCfg := "defaultMode: plan\n"
	_ = os.WriteFile(filepath.Join(homeDir, ".config", "amiro", "config.yaml"), []byte(userCfg), 0o644)

	// Set project config to defaultMode: edit
	projCfg := "defaultMode: edit\n"
	_ = os.WriteFile(filepath.Join(workDir, ".amiro", "config.yaml"), []byte(projCfg), 0o644)

	// 1. Without CLI flag: project config (edit) should beat user config (plan)
	sess := h.PTY(
		harness.PTYDir(workDir),
		harness.PTYHome(homeDir),
	)
	defer sess.Close()

	if err := sess.WaitForText("edit", 10*time.Second); err != nil {
		t.Fatalf("project config mode (edit) should win over user config: %v\nframe:\n%s", err, sess.Frame())
	}
	sess.Close()

	// 2. With CLI flag (--mode auto): CLI flag should beat project config (edit)
	sess2 := h.PTY(
		harness.PTYDir(workDir),
		harness.PTYHome(homeDir),
		harness.PTYArgs("--mode", "auto"),
	)
	defer sess2.Close()

	if err := sess2.WaitForText("auto", 10*time.Second); err != nil {
		t.Fatalf("CLI flag (--mode auto) should win over project config: %v\nframe:\n%s", err, sess2.Frame())
	}
}

func TestConfig_EnvironmentPrecedence(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	// AMIRO_DEFAULT_MODE=auto in env
	sess := h.PTY(
		harness.PTYEnv("AMIRO_DEFAULT_MODE=auto"),
	)
	defer sess.Close()

	if err := sess.WaitForText("auto", 10*time.Second); err != nil {
		t.Fatalf("env AMIRO_DEFAULT_MODE=auto should apply: %v\nframe:\n%s", err, sess.Frame())
	}
}
