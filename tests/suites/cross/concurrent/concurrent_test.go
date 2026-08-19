// Package concurrent_test proves Phase 7's "Concurrent writes"
// cross-surface journey, quoted verbatim from the Section 1 table of
// docs/testing/phases/phase-07-cross-surface.md:
//
//	| Concurrent writes | The TUI and the browser edit the same thread simultaneously; the result is consistent, and neither client is left showing stale state |
//
// and contributes to Exit Criterion 1, quoted verbatim: "`amirotest run
// --surface cross` passes, and every cross-surface journey above has a
// test."
//
// WHO PLAYS WHOM, AND WHAT THAT DOES AND DOES NOT PROVE.
// "The TUI" and "the browser" are two separate apiclient.Client values --
// separate HTTP connections, separately labelled in the log, both holding
// the same user's session, both pointed at the one backend. `cross` is a
// Go-test surface, so neither a rendered terminal nor a rendered page is in
// play here. That substitution is faithful for the first half of the row --
// "the result is consistent" is a property of the one backend and the one
// database, and two concurrent HTTP writers is exactly what produces it --
// and it is honest about the second half only in a specific sense, spelled
// out next.
//
// "NEITHER CLIENT IS LEFT SHOWING STALE STATE": WHAT IS ASSERTED.
// Amiro's backend has no server push (internal/httpserver/router.go
// registers no websocket and no thread-events SSE route), so "not stale" can
// only mean "the client's next read returns the converged truth, and the two
// clients never disagree with each other". That is what is asserted: after
// the concurrent writes, BOTH clients are polled and required to converge on
// the SAME value, and the value must be one a client actually wrote -- not a
// blank, not a merge, not one client's write silently lost while the other's
// read still reports the old one.
//
// What is NOT asserted, and is a real gap: whether a rendered surface that
// is not re-reading -- a TUI holding an in-memory session.State transcript,
// or a dashboard tab holding a client-side cache -- repaints. A companion
// Playwright spec would be needed for the browser half of that (rename a
// thread from a second client while a dashboard tab has it open, and assert
// the sidebar row updates without a manual refresh), and a TUI test would
// need a reload trigger the TUI does not currently have. Nothing here should
// be read as covering it.
package concurrent_test

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/assert"
	"amiro/tests/harness/fakeprovider"
)

// TestCrossSurface_ConcurrentRenamesOfOneThreadConvergeAndBothClientsAgree is
// the metadata-write half: two clients renaming the same thread at the same
// moment.
func TestCrossSurface_ConcurrentRenamesOfOneThreadConvergeAndBothClientsAgree(t *testing.T) {
	const probe = "concurrent rename cross surface probe"
	const answer = "Concurrent rename probe acknowledged."
	const titleFromTUI = "renamed-by-the-tui"
	const titleFromBrowser = "renamed-by-the-browser"

	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains(probe)).StreamText(answer)
	}))

	// Two clients, same identity, same backend -- what "the TUI and the
	// browser" reduces to once the rendering is out of scope. Built through
	// Client.As rather than Harness.As because the latter hands back one
	// cached *Client per identity, and two writers sharing one value would
	// make the race below a fiction.
	tui, browser := twoClients(t, h)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	threadID := "cross-concurrent-rename-thread"
	if _, err := tui.ChatTurn(ctx, apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("cross-concurrent-rename-msg-1", probe),
	}); err != nil {
		t.Fatalf("creating the shared thread: %v", err)
	}

	// Both renames are released together and both must be answered. A
	// backend that serialised them by rejecting one would show up here.
	start := make(chan struct{})
	errs := make(chan error, 2)
	rename := func(c *apiclient.Client, title string) {
		<-start
		errs <- c.RenameThread(ctx, threadID, title)
	}
	go rename(tui, titleFromTUI)
	go rename(browser, titleFromBrowser)
	close(start)

	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("a concurrent rename was refused rather than serialised: %v", err)
		}
	}

	// Convergence, read through BOTH clients: same value from each, and a
	// value one of them actually wrote.
	assert.Eventually(t, "both clients to read the same, non-lost title", 20*time.Second, func() error {
		fromTUI, err := tui.GetThread(ctx, threadID)
		if err != nil {
			return fmt.Errorf("TUI-side GET /api/thread/%s: %w", threadID, err)
		}
		fromBrowser, err := browser.GetThread(ctx, threadID)
		if err != nil {
			return fmt.Errorf("browser-side GET /api/thread/%s: %w", threadID, err)
		}
		if fromTUI.Title != fromBrowser.Title {
			return fmt.Errorf("the two clients disagree: the TUI reads %q, the browser reads %q",
				fromTUI.Title, fromBrowser.Title)
		}
		if fromTUI.Title != titleFromTUI && fromTUI.Title != titleFromBrowser {
			return fmt.Errorf("the converged title is %q, which neither client wrote (wanted %q or %q) -- "+
				"a concurrent rename produced a value nobody asked for",
				fromTUI.Title, titleFromTUI, titleFromBrowser)
		}
		return nil
	})

	// And the conversation itself survived the metadata race intact.
	detail, err := tui.GetThread(ctx, threadID)
	if err != nil {
		t.Fatalf("re-reading the thread: %v", err)
	}
	if len(detail.Messages) == 0 {
		t.Fatalf("thread %s lost every message across two concurrent renames", threadID)
	}
	if !strings.Contains(allParts(detail), probe) {
		t.Errorf("thread %s no longer carries the message it was created with; a rename race should not touch "+
			"messages\nmessages:\n%s", threadID, allParts(detail))
	}
}

// TestCrossSurface_ConcurrentTurnsOnOneThreadFromTwoClientsBothPersist is the
// content-write half: two clients running a turn on the same thread at the
// same moment. This is the case that can genuinely lose data, so it asserts
// on the message set rather than on a single field.
func TestCrossSurface_ConcurrentTurnsOnOneThreadFromTwoClientsBothPersist(t *testing.T) {
	const probeTUI = "concurrent turn from the terminal side"
	const probeBrowser = "concurrent turn from the browser side"

	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains(probeTUI)).StreamText("Terminal-side turn done.")
		s.OnPrompt(fakeprovider.Contains(probeBrowser)).StreamText("Browser-side turn done.")
	}))

	tui, browser := twoClients(t, h)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	threadID := "cross-concurrent-turn-thread"

	// The thread has to exist before both writers race for it; otherwise the
	// race under test is "who creates the thread", which is a different
	// question from "who can write to it".
	if _, err := tui.ChatTurn(ctx, apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("cross-concurrent-turn-seed", probeTUI+" seed"),
	}); err != nil {
		t.Fatalf("creating the shared thread: %v", err)
	}

	type outcome struct {
		who string
		err error
	}
	start := make(chan struct{})
	done := make(chan outcome, 2)
	run := func(who string, c *apiclient.Client, msgID, text string) {
		<-start
		_, err := c.ChatTurn(ctx, apiclient.ChatRequest{
			ID:      threadID,
			Message: apiclient.TextMessage(msgID, text),
		})
		done <- outcome{who: who, err: err}
	}
	go run("tui", tui, "cross-concurrent-turn-msg-tui", probeTUI)
	go run("browser", browser, "cross-concurrent-turn-msg-browser", probeBrowser)
	close(start)

	succeeded := 0
	for i := 0; i < 2; i++ {
		o := <-done
		if o.err != nil {
			// A refusal is tolerable; a hang or a corrupt thread is not. But
			// it must be a clean, client-visible HTTP error, not a transport
			// failure -- that distinction is the whole bar.
			if apiclient.StatusOf(o.err) == 0 {
				t.Fatalf("the %s-side concurrent turn failed without a client-visible HTTP status: %v", o.who, o.err)
			}
			t.Logf("the %s-side concurrent turn was cleanly refused: %v", o.who, o.err)
			continue
		}
		succeeded++
	}
	if succeeded == 0 {
		t.Fatalf("neither concurrent turn on thread %s completed; a shared thread must remain writable", threadID)
	}

	// Consistency: whatever survived, both clients must read exactly the same
	// thing, with no duplicated message ids.
	var snapshot []string
	assert.Eventually(t, "both clients to read an identical message set for the shared thread", 30*time.Second, func() error {
		fromTUI, err := tui.GetThread(ctx, threadID)
		if err != nil {
			return fmt.Errorf("TUI-side GET /api/thread/%s: %w", threadID, err)
		}
		fromBrowser, err := browser.GetThread(ctx, threadID)
		if err != nil {
			return fmt.Errorf("browser-side GET /api/thread/%s: %w", threadID, err)
		}
		a, b := messageIDs(fromTUI), messageIDs(fromBrowser)
		if strings.Join(a, ",") != strings.Join(b, ",") {
			return fmt.Errorf("the two clients disagree about the thread's messages:\n  tui:     %v\n  browser: %v", a, b)
		}
		snapshot = a
		return nil
	})

	seen := map[string]int{}
	for _, id := range snapshot {
		seen[id]++
	}
	for id, n := range seen {
		if n > 1 {
			t.Errorf("message %s appears %d times in thread %s after two concurrent turns; a shared thread must "+
				"not accumulate duplicates", id, n, threadID)
		}
	}

	// Every persisted message must still be parseable. A partially written
	// row is the corruption this row of the table is really about.
	detail, err := tui.GetThread(ctx, threadID)
	if err != nil {
		t.Fatalf("re-reading the thread: %v", err)
	}
	for _, m := range detail.Messages {
		var parts []json.RawMessage
		if err := json.Unmarshal(m.Parts, &parts); err != nil {
			t.Errorf("message %s (%s) has unparseable parts after the concurrent turns: %v\nraw: %s",
				m.ID, m.Role, err, m.Parts)
		}
	}
	if succeeded == 2 && !strings.Contains(allParts(detail), probeBrowser) {
		t.Errorf("both concurrent turns reported success but the browser-side message is not in the thread; "+
			"one client's write was silently lost\nmessages:\n%s", allParts(detail))
	}
}

// twoClients returns two independent apiclient.Client values holding the
// same seeded identity's session against the same backend -- the honest
// stand-in for "the TUI and the browser" at the HTTP layer.
func twoClients(t *testing.T, h *harness.Harness) (*apiclient.Client, *apiclient.Client) {
	t.Helper()
	id := h.Identity("admin")
	tui := h.Client().As("tui", id.Token)
	browser := h.Client().As("browser", id.Token)
	if tui == browser {
		t.Fatalf("Client.As returned the same pointer twice; this test needs two independent clients")
	}
	return tui, browser
}

func messageIDs(detail apiclient.ThreadDetail) []string {
	out := make([]string, 0, len(detail.Messages))
	for _, m := range detail.Messages {
		out = append(out, m.ID)
	}
	sort.Strings(out)
	return out
}

func allParts(detail apiclient.ThreadDetail) string {
	var b strings.Builder
	for _, m := range detail.Messages {
		b.WriteString(m.Role)
		b.WriteString(": ")
		b.Write(m.Parts)
		b.WriteString("\n")
	}
	return b.String()
}
