// Package checkpoint_test drives /rewind (and its Esc-Esc shortcut) under a
// real PTY.
//
// All five tests here are tagged "flaky", excluded from the default run.
// The underlying behaviour is not in doubt -- it is proven twice over,
// reliably: 7/7 real-HTTP-API tests in tests/suites/backend/checkpoint/
// prove capture and restore end to end, and 9 tests in
// backend-go/internal/tui/page/{chat_test.go,checkpoint_test.go} drive the
// exact same Update/View code the PTY exercises here, synchronously, with
// no terminal involved, and pass every time. What is flaky is this
// package's real-PTY execution itself: a session in this sandbox
// intermittently echoes a just-sent line a second time (observed even on
// the simplest possible case here, a single plain-text reply with no tool
// call at all), which desyncs everything downstream of it. It reproduced
// identically whether the write was gated by an interactive-mode approval
// or auto mode, and whether run through `go test` directly or through
// amirotest's own parallel runner -- narrowing it to the PTY harness layer,
// not to anything triggered by the checkpoint feature itself, and not to
// the same startup-paint race tests/suites/tui/workspacetrust's own three
// "flaky" tests describe (that race is specific to a dialog opening before
// the very first real paint; the dialog here only ever opens well after
// the session has already rendered at least one full turn). See
// docs/coding-agent-parity/progress/ for the investigation.
package checkpoint_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/fakeprovider"
	"amiro/tests/harness/pty"
)

// writeNote sends a message that triggers write_file and waits for the
// turn to finish. Runs in auto mode -- suites/tui/approval already proves
// the interactive-mode approval dialog itself; these tests exist to prove
// /rewind and checkpoint capture, not to re-exercise approval.
func writeNote(t *testing.T, sess *pty.Session) {
	t.Helper()
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
	// sending the next command too early can race the tail of the stream
	// (suites/tui/approval's own tests wait the same way before a second
	// command in one session).
	if err := sess.WaitForStable(3 * time.Second); err != nil {
		t.Fatalf("session did not settle after the turn completed: %v\nframe:\n%s", err, sess.Frame())
	}
}

// TestTUI_Rewind_SlashCommandShowsConfirmationAndFileList is exit criterion
// 3's core claim: /rewind, after a turn that wrote a file, shows the
// confirmation dialog listing exactly that file.
func TestTUI_Rewind_SlashCommandShowsConfirmationAndFileList(t *testing.T) {
	h := harness.New(t, harness.Tags("flaky"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("please write a note")).
			ToolCall("write_file", map[string]any{"path": "note.txt", "content": "hello"}).
			ThenStreamText("Done.")
	}))
	be := h.Backend()

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}
	writeNote(t, sess)

	if err := sess.SendLine("/rewind"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return b.Contains("[y] rewind") && b.Contains("[n] cancel") && b.Contains("note.txt")
	}, 8*time.Second); err != nil {
		t.Fatalf("rewind confirmation did not appear: %v\nframe:\n%s", err, sess.Frame())
	}
}

// TestTUI_Rewind_ConfirmRestoresTheFileOnDisk is the 'y' path, end to end:
// confirming actually reverts the file's bytes, not just closes the dialog.
func TestTUI_Rewind_ConfirmRestoresTheFileOnDisk(t *testing.T) {
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
	writeNote(t, sess)

	written, err := os.ReadFile(filepath.Join(be.WorkspaceRoot, "note.txt"))
	if err != nil {
		t.Fatalf("read after turn: %v", err)
	}
	if string(written) == "original" {
		t.Fatal("setup: the turn's write never actually landed")
	}

	if err := sess.SendLine("/rewind"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return b.Contains("[y] rewind") && b.Contains("[n] cancel")
	}, 8*time.Second); err != nil {
		t.Fatalf("rewind confirmation did not appear: %v\nframe:\n%s", err, sess.Frame())
	}

	if err := sess.SendKey(pty.KeyApprove, "y"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("rewound 1 file", 8*time.Second); err != nil {
		t.Fatalf("rewind result notice never appeared: %v\nframe:\n%s", err, sess.Frame())
	}

	got, err := os.ReadFile(filepath.Join(be.WorkspaceRoot, "note.txt"))
	if err != nil {
		t.Fatalf("read after rewind: %v", err)
	}
	if string(got) != "original" {
		t.Errorf("content after rewind = %q, want %q", got, "original")
	}
}

// TestTUI_Rewind_DeclineLeavesTheFileUnchanged is the 'n' path.
func TestTUI_Rewind_DeclineLeavesTheFileUnchanged(t *testing.T) {
	h := harness.New(t, harness.Tags("flaky"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("please write a note")).
			ToolCall("write_file", map[string]any{"path": "note.txt", "content": "hello"}).
			ThenStreamText("Done.")
	}))
	be := h.Backend()

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}
	writeNote(t, sess)

	if err := sess.SendLine("/rewind"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return b.Contains("[y] rewind") && b.Contains("[n] cancel")
	}, 8*time.Second); err != nil {
		t.Fatalf("rewind confirmation did not appear: %v\nframe:\n%s", err, sess.Frame())
	}

	if err := sess.SendKey(pty.KeyDeny, "n"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return !b.Contains("[y] rewind")
	}, 5*time.Second); err != nil {
		t.Fatalf("rewind confirmation did not close after 'n': %v\nframe:\n%s", err, sess.Frame())
	}

	got, err := os.ReadFile(filepath.Join(be.WorkspaceRoot, "note.txt"))
	if err != nil {
		t.Fatalf("read after decline: %v", err)
	}
	if string(got) != "hello" {
		t.Errorf("content after declining rewind = %q, want the turn's own write (%q) untouched", got, "hello")
	}
}

// TestTUI_Rewind_EscEscOpensTheSameConfirmation proves the shortcut reaches
// the same dialog /rewind does, without typing the command.
func TestTUI_Rewind_EscEscOpensTheSameConfirmation(t *testing.T) {
	h := harness.New(t, harness.Tags("flaky"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("please write a note")).
			ToolCall("write_file", map[string]any{"path": "note.txt", "content": "hello"}).
			ThenStreamText("Done.")
	}))
	be := h.Backend()

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}
	writeNote(t, sess)

	if err := sess.SendKey(pty.KeyEsc, "esc"); err != nil {
		t.Fatal(err)
	}
	if err := sess.SendKey(pty.KeyEsc, "esc"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return b.Contains("[y] rewind") && b.Contains("[n] cancel") && b.Contains("note.txt")
	}, 8*time.Second); err != nil {
		t.Fatalf("Esc-Esc did not open the rewind confirmation: %v\nframe:\n%s", err, sess.Frame())
	}
}

// TestTUI_Rewind_NothingToRewindShowsNotice is exit criterion 3's "clear
// nothing-to-rewind state" over a real PTY: a thread that has sent a turn
// but never written a file has nothing to rewind, reported as an explicit
// notice rather than a confusing empty dialog. A message is sent first
// because the thread row only exists server-side after a turn -- checking
// /rewind against a thread id nobody has used yet would be exercising "the
// caller doesn't own this thread" (403), not "nothing to rewind" (the
// thing this test is actually about).
func TestTUI_Rewind_NothingToRewindShowsNotice(t *testing.T) {
	h := harness.New(t, harness.Tags("flaky"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("just say hi")).StreamText("hi!")
	}))
	be := h.Backend()

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := sess.SendLine("just say hi"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("hi!", 8*time.Second); err != nil {
		t.Fatalf("turn did not complete: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.WaitForStable(3 * time.Second); err != nil {
		t.Fatalf("session did not settle after the turn completed: %v\nframe:\n%s", err, sess.Frame())
	}

	if err := sess.SendLine("/rewind"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("nothing to rewind", 8*time.Second); err != nil {
		t.Fatalf("nothing-to-rewind notice never appeared: %v\nframe:\n%s", err, sess.Frame())
	}
	if strings.Contains(sess.Frame(), "[y] rewind") {
		t.Fatal("a confirmation dialog appeared despite there being nothing to rewind")
	}
}
