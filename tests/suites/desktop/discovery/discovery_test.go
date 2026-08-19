// Package discovery_test proves Exit Criterion 5: "Discovery works: desktop
// running + amiro in a terminal share one database, proven by a thread
// visible in both."
//
// "Desktop running" is played by a directly-started backend.Backend rather
// than a live Tauri window -- and that substitution is faithful, not a
// mock: the desktop app's sidecar IS cmd/server, driven by the identical
// lock-file protocol (appwiring.WriteLock/backend-go/internal/tui/client.Discover)
// a real Tauri launch uses. What genuinely needs cargo -- the Rust process
// that spawns it and the webview that would show a thread rendered on
// screen -- is not here; "visible in ... the desktop window" is checked
// through the API client instead of a screenshot, since there is no
// webview on this machine to look at. tests/suites/tui/launch already
// proves the attach-not-embed half of this (PID/port/lock identity); this
// test adds the one thing it does not: an actual thread, created through
// the TUI, read back over a second apiclient.Client -- a second consumer
// of the shared database, not a second OS process -- against the same
// backend.
package discovery_test

import (
	"context"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/fakeprovider"
)

func TestDiscovery_ThreadCreatedInTUIIsVisibleViaSharedBackend(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("discovery probe")).StreamText("Discovery probe acknowledged.")
	}))
	be := h.Backend()

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatalf("TUI did not render its prompt: %v\nframe:\n%s", err, sess.Frame())
	}

	if err := sess.SendLine("discovery probe"); err != nil {
		t.Fatalf("sending prompt: %v", err)
	}
	if err := sess.WaitForText("Discovery probe acknowledged.", 8*time.Second); err != nil {
		t.Fatalf("TUI turn did not complete: %v\nframe:\n%s", err, sess.Frame())
	}

	// A second client -- standing in for "the desktop window" -- hitting
	// the exact same backend the TUI just attached to. It is a second
	// apiclient.Client, not a second OS process: this checks the shared
	// database, not process independence, which
	// suites/tui/launch/attach_embed_test.go already covers separately
	// via lock-file pid/port identity.
	admin := h.As("admin")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	threads, err := admin.ListThreads(ctx)
	if err != nil {
		t.Fatalf("listing threads from a second client against the shared backend: %v", err)
	}
	if len(threads) == 0 {
		t.Fatalf("the desktop-side client saw no threads at all; the TUI's turn should have created one " +
			"in the ONE database discovery is supposed to share")
	}

	detail, err := admin.GetThread(ctx, threads[0].ID)
	if err != nil {
		t.Fatalf("reading thread %s from the shared backend: %v", threads[0].ID, err)
	}
	var sawUserTurn bool
	for _, m := range detail.Messages {
		if m.Role == "user" {
			sawUserTurn = true
		}
	}
	if !sawUserTurn {
		t.Errorf("thread %s has no user message; the TUI-created turn is not the one the shared client sees", threads[0].ID)
	}
}
