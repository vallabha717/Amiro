package pickers_test

import (
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/pty"
)

func TestPickers_ThreadSwitcher(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	sess := h.PTY()
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}

	// Send Ctrl+T to open thread switcher
	if err := sess.SendKey(pty.KeyCtrlT, "ctrl+t"); err != nil {
		t.Fatal(err)
	}

	// Thread picker / search prompt should appear
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return b.Contains("Thread") || b.Contains("threads") || b.Contains("Search")
	}, 5*time.Second); err != nil {
		t.Fatalf("thread switcher did not appear: %v\nframe:\n%s", err, sess.Frame())
	}

	// Press Esc to cancel back to chat
	if err := sess.SendKey(pty.KeyEsc, "esc"); err != nil {
		t.Fatal(err)
	}

	// Should be back to main chat screen
	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatalf("did not return to chat after Esc: %v\nframe:\n%s", err, sess.Frame())
	}
}

func TestPickers_ModelPicker(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	sess := h.PTY()
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}

	// Send Ctrl+O to open model picker
	if err := sess.SendKey(pty.KeyCtrlO, "ctrl+o"); err != nil {
		t.Fatal(err)
	}

	// Model picker should appear
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return b.Contains("Model") || b.Contains("models") || b.Contains("Search")
	}, 5*time.Second); err != nil {
		t.Fatalf("model picker did not appear: %v\nframe:\n%s", err, sess.Frame())
	}

	// Press Esc to cancel back to chat
	if err := sess.SendKey(pty.KeyEsc, "esc"); err != nil {
		t.Fatal(err)
	}

	// Should be back to main chat screen
	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatalf("did not return to chat after Esc: %v\nframe:\n%s", err, sess.Frame())
	}
}

