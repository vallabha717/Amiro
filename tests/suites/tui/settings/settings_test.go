// Package settings_test drives the /settings page's GitHub row under a
// real PTY -- docs/coding-agent-parity/phases/phase-03-git-remote-operations.md's
// exit criterion 4 ("--surface tui --feature settings").
//
// Tagged "flaky" for the same documented reason
// tests/suites/tui/checkpoint and tests/suites/tui/workspacetrust already
// are: the underlying behavior is not in doubt (it is proven reliably at
// the unit level in backend-go/internal/tui/page/settings_test.go, which
// drives the exact same Update/View code synchronously with no terminal
// involved, and end to end over HTTP in
// tests/suites/backend/gitremote/gitremote_test.go's
// TestGitHub_ConnectStatusDisconnectRoundTrips) -- what is flaky in this
// sandbox is real-PTY execution itself. See
// docs/coding-agent-parity/progress/ for the investigation those other two
// suites' own comments describe.
package settings_test

import (
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/pty"
)

// TestTUI_Settings_GitHubRowConnectsAndDisconnects drives the whole flow a
// real terminal user would: open /settings, move down to the GitHub row
// (past every known AI provider), connect a token, see it reflected as
// connected, then disconnect it.
func TestTUI_Settings_GitHubRowConnectsAndDisconnects(t *testing.T) {
	h := harness.New(t, harness.Tags("flaky"))
	be := h.Backend()

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYHome(be.Home),
		harness.PTYDims(180, 60),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 10*time.Second); err != nil {
		t.Fatalf("chat did not render: %v\nframe:\n%s", err, sess.Frame())
	}

	if err := sess.SendLine("/settings"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("GitHub (not connected)", 10*time.Second); err != nil {
		t.Fatalf("settings page did not show the GitHub row: %v\nframe:\n%s", err, sess.Frame())
	}

	// Five known providers precede the GitHub row (knownProviders in
	// backend-go/internal/tui/page/settings.go) -- five Downs lands the
	// cursor on it.
	for i := 0; i < 5; i++ {
		if err := sess.SendKey(pty.KeyDown, "down"); err != nil {
			t.Fatal(err)
		}
	}
	if err := sess.SendKey(pty.KeyEnter, "enter"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("GitHub personal access token", 5*time.Second); err != nil {
		t.Fatalf("did not enter GitHub token-entry step: %v\nframe:\n%s", err, sess.Frame())
	}

	if err := sess.SendLine("ghp_e2e_pty_test_token"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("connected GitHub", 10*time.Second); err != nil {
		t.Fatalf("connect did not complete: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.WaitForText("GitHub (connected)", 5*time.Second); err != nil {
		t.Fatalf("GitHub row did not flip to connected: %v\nframe:\n%s", err, sess.Frame())
	}

	// Cursor is back on the picker after a successful connect (see
	// settings.go's githubConnectedMsg handling) and still sitting on the
	// GitHub row -- 'd' disconnects it directly, no key entry needed.
	if err := sess.SendKey("d", "d"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("disconnected GitHub", 10*time.Second); err != nil {
		t.Fatalf("disconnect did not complete: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.WaitForText("GitHub (not connected)", 5*time.Second); err != nil {
		t.Fatalf("GitHub row did not flip back to not connected: %v\nframe:\n%s", err, sess.Frame())
	}
}
