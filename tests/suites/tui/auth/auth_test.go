package auth_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/backend"
)

func runAuthCmd(t *testing.T, h *harness.Harness, be *backend.Backend, args ...string) (string, int) {
	t.Helper()
	_ = os.MkdirAll(h.Dir(), 0o755)
	bin := h.TUIBinary()

	cmdArgs := append([]string{"auth"}, args...)
	cmd := exec.Command(bin, cmdArgs...)
	cmd.Dir = h.Dir()

	paths := backend.Paths{
		AppDataDir:    be.AppDataDir,
		WorkspaceRoot: be.WorkspaceRoot,
		Home:          be.Home,
		DatabaseDSN:   filepath.Join(h.Dir(), "db", "amiro.db"),
	}
	cmd.Env = backend.Env(h.Config, paths, be.Token)

	outBytes, err := cmd.CombinedOutput()
	out := string(outBytes)

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return out, exitErr.ExitCode()
		}
		t.Fatalf("auth command %v error: %v\noutput: %s", args, err, out)
	}
	return out, 0
}

func TestAuth_LoginWhoamiLogoutCycle(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()
	admin := h.Identity("admin")

	// 1. Log in as admin
	out, code := runAuthCmd(t, h, be, "login", "--email", admin.Email, "--password", admin.Password)
	if code != 0 {
		t.Fatalf("login failed (%d):\n%s", code, out)
	}
	if !strings.Contains(out, "Signed in as") {
		t.Errorf("login output missing 'Signed in as':\n%s", out)
	}

	// 2. Whoami should return admin's details
	out, code = runAuthCmd(t, h, be, "whoami")
	if code != 0 {
		t.Fatalf("whoami failed (%d):\n%s", code, out)
	}
	if !strings.Contains(out, admin.Email) {
		t.Errorf("whoami missing admin's email:\n%s", out)
	}

	// 3. Logout should clear session
	out, code = runAuthCmd(t, h, be, "logout")
	if code != 0 {
		t.Fatalf("logout failed (%d):\n%s", code, out)
	}
	if !strings.Contains(out, "signed out") {
		t.Errorf("logout output missing 'signed out':\n%s", out)
	}

	// 4. Whoami after logout should report not signed in
	out, code = runAuthCmd(t, h, be, "whoami")
	if code != 0 {
		t.Fatalf("whoami after logout failed (%d):\n%s", code, out)
	}
	if !strings.Contains(out, "not signed in") {
		t.Errorf("whoami after logout should say 'not signed in', got:\n%s", out)
	}
}

func TestAuth_ConnectServerIsolation(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()
	user := h.Identity("user")

	// Sign in with explicit --connect URL
	out, code := runAuthCmd(t, h, be, "login",
		"--connect", be.URL,
		"--token", be.Token,
		"--email", user.Email,
		"--password", user.Password,
	)
	if code != 0 {
		t.Fatalf("connect login failed (%d):\n%s", code, out)
	}

	// Whoami with that connect URL succeeds
	out, code = runAuthCmd(t, h, be, "whoami", "--connect", be.URL, "--token", be.Token)
	if code != 0 || !strings.Contains(out, user.Email) {
		t.Errorf("whoami with matching --connect failed:\n%s", out)
	}

	// Whoami with a DIFFERENT connect URL should be 'not signed in' (isolated key)
	out, code = runAuthCmd(t, h, be, "whoami", "--connect", "http://127.0.0.1:59999", "--token", "fake-token")
	if code != 0 || !strings.Contains(out, "not signed in") {
		t.Errorf("whoami for different server should report 'not signed in', got:\n%s", out)
	}
}

