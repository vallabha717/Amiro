package checkpoint_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/fakeprovider"
	"amiro/tests/harness/pty"
)

// TestCrossSurface_RewindPerformedInTheTUIIsVisibleOverTheAPI is the cross
// suite's claim for checkpoints: a rewind performed from one surface (here,
// the TUI, attached over --connect the same way
// tests/suites/cross/workspacetrust proves a trust grant is a database row
// rather than connection state) is reflected wherever else the same
// account looks -- a second HTTP client (what the web dashboard's own API
// calls would be) sees the same persisted checkpoint record, and the
// reverted bytes are the same file on disk the web dashboard would read
// through its own "download"/"view file" affordance.
//
// docs/coding-agent-parity/02-checkpoints-and-rewind.md is explicit that a
// restore does not touch the transcript, so there is no new message part
// for a second surface to notice on reload -- the two facts that actually
// persist, and that this test checks, are the checkpoint index row and the
// file's bytes.
//
// Tagged "flaky": it drives the same TUI PTY session
// tests/suites/tui/checkpoint's five tests do, and hits the same
// harness-level real-PTY issue described in that package's doc comment --
// not a defect in checkpoints or in cross-surface persistence, both of
// which tests/suites/backend/checkpoint already proves reliably over the
// real HTTP API.
func TestCrossSurface_RewindPerformedInTheTUIIsVisibleOverTheAPI(t *testing.T) {
	h := harness.New(t, harness.Tags("flaky"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("please write a note")).
			ToolCall("write_file", map[string]any{"path": "note.txt", "content": "hello"}).
			ThenStreamText("Done.")
	}))
	be := h.Backend()
	if err := os.WriteFile(filepath.Join(be.WorkspaceRoot, "note.txt"), []byte("original"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}
	// Auto mode: suites/tui/approval already proves the interactive-mode
	// approval dialog itself, so this test stays focused on /rewind and
	// checkpoint capture.
	if err := sess.SendLine("/mode auto"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForStable(2 * time.Second); err != nil {
		t.Fatalf("session did not settle after /mode auto: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.SendLine("please write a note"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("Done.", 8*time.Second); err != nil {
		t.Fatalf("turn did not complete: %v\nframe:\n%s", err, sess.Frame())
	}
	// The screen showing "Done." does not mean the client has settled --
	// sending the next command too early can race the tail of the stream.
	if err := sess.WaitForStable(3 * time.Second); err != nil {
		t.Fatalf("session did not settle after the turn completed: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.SendLine("/rewind"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("[y] rewind", 8*time.Second); err != nil {
		t.Fatalf("rewind confirmation did not appear: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.SendKey(pty.KeyApprove, "y"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("rewound 1 file", 8*time.Second); err != nil {
		t.Fatalf("rewind result notice never appeared: %v\nframe:\n%s", err, sess.Frame())
	}

	// A second surface: a plain HTTP client, exactly what a web dashboard
	// reload would use -- not the TUI's own connection.
	user := h.As("user")
	threads, err := user.ListThreads(t.Context())
	if err != nil {
		t.Fatalf("ListThreads: %v", err)
	}
	if len(threads) != 1 {
		t.Fatalf("threads = %+v, want exactly the one the TUI created", threads)
	}
	threadID := threads[0].ID

	latest, err := user.LatestCheckpoint(t.Context(), threadID)
	if err != nil {
		t.Fatalf("LatestCheckpoint: %v", err)
	}
	if len(latest.Files) != 1 || latest.Files[0].Path != "note.txt" {
		t.Fatalf("LatestCheckpoint over the API = %+v, want the same note.txt row the TUI's rewind used", latest.Files)
	}

	got, err := os.ReadFile(filepath.Join(be.WorkspaceRoot, "note.txt"))
	if err != nil {
		t.Fatalf("read after cross-surface check: %v", err)
	}
	if string(got) != "original" {
		t.Errorf("file content = %q, want the TUI's rewind to have reverted it to %q", got, "original")
	}
}
