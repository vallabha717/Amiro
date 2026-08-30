package workspacetrust_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/backend"
)

// runAuthLogin runs `amiro auth login` as a one-shot subprocess against be,
// the same non-interactive pattern suites/tui/auth uses to establish a
// session token under home for a --connect target before an interactive
// PTY session needs one -- resolveSession (cmd/amiro/session.go) requires
// either an embedded backend (auto-provisioning a desktop user) or an
// already-stored token for that exact connect target; --connect alone
// provides neither.
func runAuthLogin(t *testing.T, h *harness.Harness, be *backend.Backend, email, password string) {
	t.Helper()
	_ = os.MkdirAll(h.Dir(), 0o755)
	bin := h.TUIBinary()
	cmd := exec.Command(bin, "auth", "login",
		"--connect", be.URL,
		"--token", be.Token,
		"--email", email,
		"--password", password,
	)
	cmd.Dir = h.Dir()
	cmd.Env = backend.Env(h.Config, backend.Paths{
		AppDataDir:    be.AppDataDir,
		WorkspaceRoot: be.WorkspaceRoot,
		Home:          be.Home,
		DatabaseDSN:   filepath.Join(h.Dir(), "db", "amiro.db"),
	}, be.Token)

	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amiro auth login: %v\noutput: %s", err, out)
	}
}

// TestCrossSurface_DesktopGrantedRootIsHonoredByAnAttachedTUI is exit
// criterion 5: a grant made from one surface (here, the HTTP API directly
// -- what the desktop app's trust prompt itself calls) is honored by the
// TUI attaching explicitly (--connect) to the same server, with no
// separate grant step. The grant is a database row keyed on
// (user, resolved_root), not connection state, so this is the same
// multi-client guarantee Phase 5 of the TUI work already proved for
// permission grants, extended to workspace trust.
func TestCrossSurface_DesktopGrantedRootIsHonoredByAnAttachedTUI(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()
	user := h.As("user")
	identity := h.Identity("user")
	root := t.TempDir()

	// The "desktop app" side: grant trust for root via the HTTP API, the
	// same route the web/desktop trust prompt calls on "yes".
	if _, err := user.GrantWorkspaceTrust(t.Context(), root); err != nil {
		t.Fatalf("Grant: %v", err)
	}

	// Establish a session for the TUI's explicit --connect target, then
	// attach a real PTY session against that exact root.
	runAuthLogin(t, h, be, identity.Email, identity.Password)

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(root),
		harness.PTYHome(be.Home),
		harness.PTYArgs("--connect", be.URL, "--token", be.Token),
		harness.PTYDims(180, 60),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("TUI prompt did not render: %v\nframe:\n%s", err, sess.Frame())
	}

	if err := sess.SendLine("say hi"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("Fake response for: say hi", 10*time.Second); err != nil {
		t.Fatalf("turn did not complete -- possibly blocked behind an unexpected trust prompt: %v\nframe:\n%s", err, sess.Frame())
	}

	if strings.Contains(sess.Frame(), "[y] trust") {
		t.Fatal("trust prompt appeared despite the root already being granted from another surface")
	}
}
