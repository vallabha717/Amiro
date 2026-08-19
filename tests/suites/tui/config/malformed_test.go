package config_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
)

func TestConfig_MalformedFileIsIgnored(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	workDir := filepath.Join(h.Dir(), "malformed-workdir")
	_ = os.MkdirAll(filepath.Join(workDir, ".amiro"), 0o755)

	// Write corrupted YAML
	_ = os.WriteFile(filepath.Join(workDir, ".amiro", "config.yaml"), []byte("this is : not : valid: [yaml"), 0o644)

	sess := h.PTY(
		harness.PTYDir(workDir),
	)
	defer sess.Close()

	// TUI should start cleanly with defaults
	if err := sess.WaitForText("Ask Amiro", 10*time.Second); err != nil {
		t.Fatalf("TUI should ignore malformed YAML and start with defaults: %v\nframe:\n%s", err, sess.Frame())
	}

}

func TestConfig_InvalidDefaultModeProducesCleanError(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	workDir := filepath.Join(h.Dir(), "invalid-mode-workdir")
	_ = os.MkdirAll(filepath.Join(workDir, ".amiro"), 0o755)

	// Write invalid defaultMode
	_ = os.WriteFile(filepath.Join(workDir, ".amiro", "config.yaml"), []byte("defaultMode: nonexistent\n"), 0o644)

	bin := h.TUIBinary()
	cmd := exec.Command(bin, "-C", workDir)
	cmd.Dir = workDir
	cmd.Env = os.Environ()

	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected amiro to exit with error on invalid defaultMode, but got success:\n%s", string(out))
	}

	want := "defaultMode must be one of plan, interactive, edit, auto"
	if !strings.Contains(string(out), want) {
		t.Errorf("output missing %q:\n%s", want, string(out))
	}
}
