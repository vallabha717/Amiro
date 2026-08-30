// Package backgroundjob_test drives the "/runs" picker under a real PTY --
// docs/coding-agent-parity/phases/phase-04-background-agent-runs.md's
// "`/runs` picker in the TUI, mirroring `/threads`' list/filter/select
// shape".
//
// Tagged "flaky" for the same documented reason
// tests/suites/tui/checkpoint, tests/suites/tui/workspacetrust and
// tests/suites/tui/settings already are: the underlying behavior is not in
// doubt -- it is proven reliably and in depth at the unit level in
// backend-go/internal/tui/page/runs_test.go, which drives the exact same
// Update/View code synchronously with no terminal involved -- what is
// flaky in this sandbox is real-PTY execution itself. This suite is
// therefore scoped to what a real terminal adds that a unit test cannot:
// proving the picker actually opens and returns under a live PTY, not
// re-proving list/filter/resume semantics runs_test.go already covers.
package backgroundjob_test

import (
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/pty"
)

func TestTUI_Runs_OpensListsAndCancels(t *testing.T) {
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

	if err := sess.SendLine("/runs"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("Background runs", 10*time.Second); err != nil {
		t.Fatalf("runs picker did not render: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.WaitForText("no background runs yet", 5*time.Second); err != nil {
		t.Fatalf("runs picker did not show the empty state for a fresh instance: %v\nframe:\n%s", err, sess.Frame())
	}

	if err := sess.SendKey(pty.KeyEsc, "esc"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatalf("did not return to chat after Esc: %v\nframe:\n%s", err, sess.Frame())
	}
}
