package rendering_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/fakeprovider"
	"amiro/tests/harness/pty"
)


func TestRendering_NarrowAndWideTerminal(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	// 1. Narrow terminal (60x20)
	sessNarrow := h.PTY(harness.PTYDims(60, 20))
	defer sessNarrow.Close()

	if err := sessNarrow.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}

	// 2. Wide terminal (140x50)
	sessWide := h.PTY(harness.PTYDims(140, 50))
	defer sessWide.Close()

	if err := sessWide.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}
}

func TestRendering_ResizeMidStream(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("resize test")).StreamText("Line one before resize.\nLine two during resize.\nLine three after resize.\n")
	}))
	be := h.Backend()

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
		harness.PTYDims(100, 30),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}

	if err := sess.SendLine("resize test"); err != nil {
		t.Fatal(err)
	}

	// Wait for stream to start
	if err := sess.WaitForText("Line one", 5*time.Second); err != nil {
		t.Fatal(err)
	}

	// Trigger terminal resize
	if err := sess.Resize(80, 24); err != nil {
		t.Fatalf("resizing terminal: %v", err)
	}

	// Wait for turn to finish
	if err := sess.WaitForText("Line three", 6*time.Second); err != nil {
		t.Fatalf("response after resize did not render: %v\nframe:\n%s", err, sess.Frame())
	}
}

func TestRendering_UnicodeAndCJKWidth(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("unicode prompt")).StreamText("Hello 世界! こんにちは, 안녕하세요. 🚀✨ — Special chars: ©, ®, ±")
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

	if err := sess.SendLine("unicode prompt"); err != nil {
		t.Fatal(err)
	}

	if err := sess.WaitForText("Hello 世界!", 6*time.Second); err != nil {
		t.Fatalf("unicode text did not render: %v\nframe:\n%s", err, sess.Frame())
	}
}

func TestRendering_RawANSIInModelOutputDoesNotBreakFrame(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("ansi prompt")).StreamText("Here is some text with \x1b[31mRed\x1b[0m and \x1b[1mBold\x1b[0m escapes embedded.")
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

	if err := sess.SendLine("ansi prompt"); err != nil {
		t.Fatal(err)
	}

	if err := sess.WaitForText("Here is some text", 6*time.Second); err != nil {
		t.Fatalf("text did not render: %v\nframe:\n%s", err, sess.Frame())
	}

	if !strings.Contains(sess.Frame(), "Red") || !strings.Contains(sess.Frame(), "Bold") {
		t.Errorf("frame corrupted by raw ANSI escapes:\n%s", sess.Frame())
	}
}


func TestRendering_InitialScreenGolden(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	sess := h.PTY(harness.PTYDims(80, 24))
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}

	if err := sess.WaitForStable(2 * time.Second); err != nil {
		t.Fatal(err)
	}

	// Capture initial golden frame
	h.GoldenScreen("initial_screen", sess.Frame())
}

func TestRendering_CastAndKeyLogsRecordedAndPlayable(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	sess := h.PTY(harness.PTYDims(100, 30))

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}

	if err := sess.SendLine("hello cast recording"); err != nil {
		t.Fatal(err)
	}

	_ = sess.WaitForStable(1 * time.Second)

	// Close session so cast and keys logs flush to disk
	if err := sess.Close(); err != nil {
		t.Fatalf("closing session: %v", err)
	}

	// 1. Assert session.cast exists and is valid asciinema v2
	castPath := filepath.Join(h.Dir(), "session.cast")
	castData, err := os.ReadFile(castPath)
	if err != nil {
		t.Fatalf("expected session.cast at %s: %v", castPath, err)
	}

	lines := strings.Split(strings.TrimSpace(string(castData)), "\n")
	if len(lines) < 2 {
		t.Fatalf("session.cast has %d lines, want header + events:\n%s", len(lines), string(castData))
	}

	var header pty.CastHeader
	if err := json.Unmarshal([]byte(lines[0]), &header); err != nil {
		t.Fatalf("invalid cast header JSON: %v\nheader line: %s", err, lines[0])
	}
	if header.Version != 2 || header.Width != 100 || header.Height != 30 {
		t.Errorf("header = %+v, want v2 100x30", header)
	}

	// 2. Validate events format [time, type, text]
	hasOutput := false
	hasInput := false
	for i, line := range lines[1:] {
		var ev []any
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("cast event %d invalid JSON: %v\nline: %s", i, err, line)
		}
		if len(ev) != 3 {
			t.Errorf("cast event %d length = %d, want 3", i, len(ev))
		}
		if typ, ok := ev[1].(string); ok {
			if typ == "o" {
				hasOutput = true
			} else if typ == "i" {
				hasInput = true
			}
		}
	}
	if !hasOutput {
		t.Error("session.cast contains no output events ('o')")
	}
	if !hasInput {
		t.Error("session.cast contains no input events ('i')")
	}

	// 3. Assert keys.ndjson exists and parses as KeyEvent objects
	keysPath := filepath.Join(h.Dir(), "keys.ndjson")
	keysData, err := os.ReadFile(keysPath)
	if err != nil {
		t.Fatalf("expected keys.ndjson at %s: %v", keysPath, err)
	}

	keyLines := strings.Split(strings.TrimSpace(string(keysData)), "\n")
	if len(keyLines) == 0 || keyLines[0] == "" {
		t.Fatalf("keys.ndjson is empty")
	}
	for i, kl := range keyLines {
		var ke pty.KeyEvent
		if err := json.Unmarshal([]byte(kl), &ke); err != nil {
			t.Fatalf("key event %d invalid JSON: %v\nline: %s", i, err, kl)
		}
		if ke.Key == "" {
			t.Errorf("key event %d has empty Key field", i)
		}
	}
}


