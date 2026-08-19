package chat_test

import (
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/fakeprovider"
	"amiro/tests/harness/pty"
)

func TestChat_SubmitAndStreamResponse(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("capital of France")).StreamText("The capital of France is Paris.")
	}))
	be := h.Backend()

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
	)
	defer sess.Close()

	// Wait for TUI prompt to be ready
	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatalf("TUI not ready: %v\nframe:\n%s", err, sess.Frame())
	}

	// Type prompt and press Enter
	if err := sess.SendLine("what is the capital of France"); err != nil {
		t.Fatalf("sending prompt: %v", err)
	}

	// Wait for response text to appear
	if err := sess.WaitForText("The capital of France is Paris.", 8*time.Second); err != nil {
		t.Fatalf("streaming response did not complete: %v\nframe:\n%s", err, sess.Frame())
	}

	// Stabilize screen
	if err := sess.WaitForStable(3 * time.Second); err != nil {
		t.Fatalf("screen did not stabilize: %v", err)
	}
}

func TestChat_MultiTurn(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("turn one")).StreamText("Response one.")
		s.OnPrompt(fakeprovider.Contains("turn two")).StreamText("Response two.")
	}))
	be := h.Backend()

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatalf("TUI not ready: %v", err)
	}

	// Turn 1
	if err := sess.SendLine("turn one"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("Response one.", 6*time.Second); err != nil {
		t.Fatalf("turn 1 did not complete: %v\nframe:\n%s", err, sess.Frame())
	}

	// Turn 2
	if err := sess.SendLine("turn two"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForText("Response two.", 6*time.Second); err != nil {
		t.Fatalf("turn 2 did not complete: %v\nframe:\n%s", err, sess.Frame())
	}
}

func TestChat_InterruptMidStream(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		// Large stream with small chunks to ensure stream is in flight during interrupt
		s.OnPrompt(fakeprovider.Contains("long generation")).StreamText(strings.Repeat("streaming text chunk ", 200), fakeprovider.PerChunk(5))
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

	if err := sess.SendLine("long generation"); err != nil {
		t.Fatal(err)
	}

	// Wait for stream to start
	if err := sess.WaitForText("streaming", 6*time.Second); err != nil {
		t.Fatalf("stream didn't start: %v", err)
	}

	// Send Ctrl+C to interrupt
	if err := sess.SendKey(pty.KeyCtrlC, "ctrl+c"); err != nil {
		t.Fatal(err)
	}

	// Wait for screen to stabilize and verify it returned cleanly to ready state
	if err := sess.WaitForStable(3 * time.Second); err != nil {
		t.Fatal(err)
	}
	if !sess.Contains("Ask Amiro") {
		t.Errorf("prompt should be visible after interrupt:\n%s", sess.Frame())
	}
}



func TestChat_Scrollback(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("lots of lines")).StreamText("Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12\nLine 13\nLine 14\nLine 15\nLine 16\nLine 17\nLine 18\nLine 19\nLine 20\nLine 21\nLine 22\nLine 23\nLine 24\nLine 25\n")
	}))
	be := h.Backend()

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
		harness.PTYDims(80, 20),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}


	if err := sess.SendLine("lots of lines"); err != nil {
		t.Fatal(err)
	}

	if err := sess.WaitForText("Line 1", 6*time.Second); err != nil {
		t.Fatal(err)
	}

	// Send PgUp to scroll up
	if err := sess.SendKey(pty.KeyPgUp, "pgup"); err != nil {
		t.Fatal(err)
	}
	// Send PgDown to scroll back down
	if err := sess.SendKey(pty.KeyPgDown, "pgdown"); err != nil {
		t.Fatal(err)
	}
}

