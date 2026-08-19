package headless_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/fakeprovider"
)

func runAmiroHeadless(t *testing.T, h *harness.Harness, be *backend.Backend, args ...string) (stdout string, stderr string, exitCode int) {
	t.Helper()
	bin := h.TUIBinary()

	cmdArgs := append([]string{"run"}, args...)
	cmd := exec.Command(bin, cmdArgs...)
	cmd.Dir = h.Dir()

	paths := backend.Paths{
		AppDataDir:    filepath.Join(h.Dir(), "appdata"),
		WorkspaceRoot: filepath.Join(h.Dir(), "workspace"),
		Home:          filepath.Join(h.Dir(), "home"),
		DatabaseDSN:   filepath.Join(h.Dir(), "db", "amiro.db"),
	}
	_ = os.MkdirAll(paths.AppDataDir, 0o755)
	_ = os.MkdirAll(paths.WorkspaceRoot, 0o755)
	_ = os.MkdirAll(paths.Home, 0o755)
	_ = os.MkdirAll(filepath.Join(h.Dir(), "db"), 0o755)

	token := "test-headless-token"
	if be != nil {
		h.Seeded()
		paths.AppDataDir = be.AppDataDir
		paths.WorkspaceRoot = be.WorkspaceRoot
		paths.Home = be.Home
		paths.DatabaseDSN = be.DB.DSN
		token = be.Token
	}

	keysFile := filepath.Join(paths.AppDataDir, "keys.json")
	keysMap := make(map[string]string)
	if data, err := os.ReadFile(keysFile); err == nil {
		_ = json.Unmarshal(data, &keysMap)
	}
	keysMap["openai"] = "fake-openai-key"
	keysMap["anthropic"] = "fake-anthropic-key"
	keysMap["amiro:session"] = token
	data, _ := json.Marshal(keysMap)
	_ = os.WriteFile(keysFile, data, 0o600)

	cmd.Env = backend.Env(h.Config, paths, token)

	outBytes, err := cmd.Output()
	stdout = string(outBytes)

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			stderr = string(exitErr.Stderr)
			return stdout, stderr, exitErr.ExitCode()
		}
		t.Fatalf("executing amiro run %v: %v", args, err)
	}
	return stdout, "", 0
}

func TestHeadless_StreamingTextAndExitCodeZero(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("summarize")).StreamText("Summary complete.")
	}))
	be := h.Backend()

	stdout, stderr, code := runAmiroHeadless(t, h, be, "summarize")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}
	if !strings.Contains(stdout, "Summary complete.") {
		t.Errorf("stdout missing expected summary text:\n%s", stdout)
	}
}

func TestHeadless_JSONOutput(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("generate json")).StreamText("Structured data output")
	}))
	be := h.Backend()

	stdout, stderr, code := runAmiroHeadless(t, h, be, "generate json", "--json")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}

	var res struct {
		ThreadID string `json:"threadId"`
		Text     string `json:"text"`
		Error    string `json:"error"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(stdout)), &res); err != nil {
		t.Fatalf("stdout is not valid JSON: %v\nstdout:\n%s", err, stdout)
	}
	if res.ThreadID == "" {
		t.Error("JSON output missing threadId")
	}
	if !strings.Contains(res.Text, "Structured data output") {
		t.Errorf("JSON text = %q, want 'Structured data output'", res.Text)
	}
}

func TestHeadless_ExitCodeContract_AllThreeCodes(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("clean task")).StreamText("Clean finish")
		s.OnPrompt(fakeprovider.Contains("privileged action")).ToolCall("run_shell", map[string]any{
			"command": "rm -rf /tmp/test",
		}).ThenStreamText("Removed.")
	}))
	be := h.Backend()

	// 1. Exit Code 0: Successful turn
	t.Run("exit 0 success", func(t *testing.T) {
		stdout, stderr, code := runAmiroHeadless(t, h, be, "clean task")
		if code != 0 {
			t.Fatalf("expected exit code 0, got %d (stdout: %s, stderr: %s)", code, stdout, stderr)
		}
	})

	// 2. Exit Code 2: Suspended on approval without --yes
	t.Run("exit 2 suspended without --yes", func(t *testing.T) {
		stdout, stderr, code := runAmiroHeadless(t, h, be, "privileged action", "--mode", "interactive")
		if code != 2 {
			t.Fatalf("expected exit code 2 on gated tool call without --yes, got %d (stdout: %s, stderr: %s)", code, stdout, stderr)
		}
		if !strings.Contains(stderr, "suspended") && !strings.Contains(stdout, "suspended") {
			t.Errorf("output should mention suspension:\nstdout: %s\nstderr: %s", stdout, stderr)
		}
	})

	// 3. Exit Code 0: Same privileged action with --yes auto-approves
	t.Run("exit 0 with --yes auto-approval", func(t *testing.T) {
		stdout, stderr, code := runAmiroHeadless(t, h, be, "privileged action", "--mode", "interactive", "--yes")
		if code != 0 {
			t.Fatalf("expected exit code 0 with --yes, got %d (stdout: %s, stderr: %s)", code, stdout, stderr)
		}
	})



	// 4. Exit Code 1: Invalid CLI arguments or failure before/during turn
	t.Run("exit 1 on invalid arguments", func(t *testing.T) {
		stdout, stderr, code := runAmiroHeadless(t, h, be, "--mode", "invalid_permission_mode", "some prompt")
		if code != 1 {
			t.Fatalf("expected exit code 1 on invalid mode, got %d (stdout: %s, stderr: %s)", code, stdout, stderr)
		}
	})
}
