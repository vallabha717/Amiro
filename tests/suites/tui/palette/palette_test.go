package palette_test

import (
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/pty"
)

func TestPalette_CtrlPAndSlashTrigger(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	sess := h.PTY()
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}

	// 1. Pressing Ctrl+P opens the palette / primes composer with "/"
	if err := sess.SendKey(pty.KeyCtrlP, "ctrl+p"); err != nil {
		t.Fatal(err)
	}

	// Palette commands should appear in suggestions
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return b.Contains("/mode") || b.Contains("/threads") || b.Contains("/models")
	}, 5*time.Second); err != nil {
		t.Fatalf("Ctrl+P did not show command palette: %v\nframe:\n%s", err, sess.Frame())
	}

	// Clear composer with Backspace
	_ = sess.SendKey(pty.KeyBackspace, "backspace")
	_ = sess.WaitForStable(1 * time.Second)

	// 2. Typing "/" directly also opens the command palette
	if err := sess.Send("/"); err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return b.Contains("/mode") || b.Contains("/threads") || b.Contains("/models")
	}, 5*time.Second); err != nil {
		t.Fatalf("typing '/' did not show command palette: %v\nframe:\n%s", err, sess.Frame())
	}
}

func TestPalette_SlashCommandCompletion(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	sess := h.PTY()
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}

	// Type "/mod" and press Tab to complete to "/mode "
	if err := sess.Send("/mod"); err != nil {
		t.Fatal(err)
	}
	if err := sess.SendKey(pty.KeyTab, "tab"); err != nil {
		t.Fatal(err)
	}

	// The input should now be "/mode "
	if err := sess.WaitForText("/mode", 3*time.Second); err != nil {
		t.Fatalf("Tab completion for /mode failed: %v\nframe:\n%s", err, sess.Frame())
	}
}

func TestPalette_AtSymbolCompletion(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	sess := h.PTY()
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}

	// Type "@" to trigger mention suggestions
	if err := sess.Send("@"); err != nil {
		t.Fatal(err)
	}

	// Wait for mention menu or trigger to render
	if err := sess.WaitForStable(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	if !sess.Contains("@") {
		t.Errorf("frame should show @ in composer:\n%s", sess.Frame())
	}
}

// TestPalette_AtSymbolCompletion_OffersDefaultToolsLive is Phase 6's
// (docs/skills/) end-to-end half of the `@`-completion gate: against a
// real, live TUI process (not the fakeClient internal/tui/page/
// mentions_test.go's TestChat_Init_LoadsMentionables drives), `@` must
// still populate the completion menu with real candidates now that the
// agent branch of loadMentionables (internal/tui/page/mentions.go) is
// gone. Default tools need no seeding and so are what this level can prove
// live; MCP-server and workflow candidates are proven at the
// internal/tui/page unit level instead, deliberately -- h.PTY's child
// process embeds its own backend with its own database whenever
// attach-or-embed discovery does not find a live server to attach to
// (backend-go/cmd/amiro/serve.go's resolveTransport), so a workflow seeded
// through this test's own harness.New(t) backend is not guaranteed to be
// the same database the live TUI process reads from.
func TestPalette_AtSymbolCompletion_OffersDefaultToolsLive(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	sess := h.PTY()
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatal(err)
	}

	if err := sess.Send("@"); err != nil {
		t.Fatalf("sending '@': %v", err)
	}

	if err := sess.WaitForText("read_file", 10*time.Second); err != nil {
		t.Fatalf("@ completion missing the default tool read_file: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.WaitForText("run_shell", 10*time.Second); err != nil {
		t.Fatalf("@ completion missing the default tool run_shell: %v\nframe:\n%s", err, sess.Frame())
	}
}
