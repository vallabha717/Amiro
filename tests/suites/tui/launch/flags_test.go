package launch_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
)

func runAmiroCLI(t *testing.T, h *harness.Harness, args ...string) (stdout, stderr string, exitCode int) {
	t.Helper()
	_ = os.MkdirAll(h.Dir(), 0o755)
	bin := h.TUIBinary()
	cmd := exec.Command(bin, args...)
	cmd.Dir = h.Dir()
	cmd.Env = os.Environ()

	outBytes, err := cmd.CombinedOutput()
	output := string(outBytes)

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return output, output, exitErr.ExitCode()
		}
		t.Fatalf("running amiro %v: %v", args, err)
	}
	return output, output, 0
}

func TestLaunch_FlagValidationErrors(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	cases := []struct {
		name     string
		args     []string
		wantText string
	}{
		{
			name:     "token without connect",
			args:     []string{"--token", "secret"},
			wantText: "--token has no effect without --connect",
		},
		{
			name:     "serve with connect",
			args:     []string{"--serve", "--connect", "http://127.0.0.1:9090", "--token", "secret"},
			wantText: "--serve cannot be combined with --connect",
		},
		{
			name:     "host without serve",
			args:     []string{"--host", "0.0.0.0"},
			wantText: "--host has no effect without --serve",
		},
		{
			name:     "port without serve",
			args:     []string{"--port", "8080"},
			wantText: "--port has no effect without --serve",
		},
		{
			name:     "ui-dir without serve",
			args:     []string{"--ui-dir", "/tmp"},
			wantText: "--ui-dir has no effect without --serve",
		},
		{
			name:     "allow-origin without serve",
			args:     []string{"--allow-origin", "http://example.com"},
			wantText: "--allow-origin has no effect without --serve",
		},
		{
			name:     "invalid mode",
			args:     []string{"--mode", "invalid_mode"},
			wantText: "--mode must be one of plan, interactive, edit, auto",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, _, code := runAmiroCLI(t, h, tc.args...)
			if code != 1 {
				t.Errorf("exit code = %d, want 1. Output:\n%s", code, out)
			}
			if !strings.Contains(out, tc.wantText) {
				t.Errorf("output missing %q:\n%s", tc.wantText, out)
			}
		})
	}
}

func TestLaunch_ModeAndModelFlags(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	// Start TUI with explicit --mode plan and --model custom/model
	sess := h.PTY(
		harness.PTYArgs("--mode", "plan", "--model", "openai/gpt-4o"),
	)
	defer sess.Close()

	// Assert "plan" mode renders
	if err := sess.WaitForText("plan", 10*time.Second); err != nil {
		t.Fatalf("TUI did not show plan mode: %v\nframe:\n%s", err, sess.Frame())
	}
}

func TestLaunch_WorkspaceFlag(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	customWorkDir := filepath.Join(h.Dir(), "custom-workspace")
	if err := os.MkdirAll(customWorkDir, 0o755); err != nil {
		t.Fatal(err)
	}

	sess := h.PTY(
		harness.PTYArgs("-C", customWorkDir),
		harness.PTYDir(customWorkDir),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 10*time.Second); err != nil {
		t.Fatalf("TUI did not start in custom workspace: %v\nframe:\n%s", err, sess.Frame())
	}
}


