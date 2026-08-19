// Package threadvisibility_test proves Phase 7's first cross-surface
// journey, quoted verbatim from the Section 1 table of
// docs/testing/phases/phase-07-cross-surface.md:
//
//	| TUI → UI | Start a thread in the TUI; it appears in the dashboard without a restart |
//
// and contributes to Exit Criterion 1, quoted verbatim: "`amirotest run
// --surface cross` passes, and every cross-surface journey above has a
// test."
//
// WHAT PLAYS "THE DASHBOARD" HERE, AND WHY THAT IS FAITHFUL.
// `cross` is a Go-test surface (harness/selector.GoSurfaces), so there is
// no browser DOM for a Go test to drive. "The dashboard" is played by a
// second apiclient.Client against the same backend -- the same substitution
// suites/desktop/discovery already makes, and for the same reason: the
// dashboard IS an HTTP client of the one backend and the one database, and
// that is precisely the architectural claim under test
// (cmd/amiro/main.go's doc comment, implemented by cmd/amiro/serve.go).
// It is a second apiclient.Client, NOT a second OS process and NOT a
// rendered page: this proves the shared database and the live read path,
// not that React re-renders. A companion Playwright spec would be needed
// to prove the rendered half (see the note on staleness below).
//
// WHAT "WITHOUT A RESTART" MEANS, PRECISELY.
// Amiro's backend has no server push: there is no websocket and no SSE
// thread-events channel (internal/httpserver/router.go registers none; the
// only text/event-stream route is a chat turn's own response). So the
// honest reading of "without a restart" -- and the one this test asserts --
// is that the dashboard client is constructed BEFORE the TUI's turn, is
// never rebuilt, and the backend is never restarted; the thread becomes
// visible to that same live client on its next ordinary GET /api/thread.
// The poll is assert.Eventually against the real API, never a sleep.
package threadvisibility_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/assert"
	"amiro/tests/harness/fakeprovider"
)

func TestCrossSurface_ThreadStartedInTheTUIAppearsToTheDashboardWithoutARestart(t *testing.T) {
	const probe = "cross surface thread visibility probe"
	const answer = "Thread visibility probe acknowledged."

	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains(probe)).StreamText(answer)
	}))
	be := h.Backend()

	// The dashboard's client is built BEFORE anything happens in the TUI and
	// is never rebuilt. If the journey only held for a client created after
	// the fact, this would be the thing that caught it.
	dashboard := h.As("admin")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	before, err := dashboard.ListThreads(ctx)
	if err != nil {
		t.Fatalf("dashboard-side baseline GET /api/thread: %v", err)
	}
	known := map[string]bool{}
	for _, th := range before {
		known[th.ID] = true
	}

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("the TUI did not render its prompt: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.SendLine(probe); err != nil {
		t.Fatalf("sending the probe into the TUI: %v", err)
	}
	if err := sess.WaitForText(answer, 20*time.Second); err != nil {
		t.Fatalf("the TUI turn did not complete: %v\nframe:\n%s", err, sess.Frame())
	}

	// One poll, not two steps: RunTurn persists the thread's rows just before
	// it writes [DONE], while the reply text the terminal renders arrives
	// earlier -- so "a new row exists" and "that row carries the message" can
	// be true at different instants, and asserting the second one outside the
	// poll would be a race. A new row alone is not the claim anyway; the
	// TUI's actual turn being READABLE from the other surface is.
	assert.Eventually(t, "the dashboard client to see the thread the TUI just started", 30*time.Second, func() error {
		threads, err := dashboard.ListThreads(ctx)
		if err != nil {
			return fmt.Errorf("GET /api/thread: %w", err)
		}
		for _, th := range threads {
			if known[th.ID] {
				continue
			}
			detail, err := dashboard.GetThread(ctx, th.ID)
			if err != nil {
				return fmt.Errorf("GET /api/thread/%s: %w", th.ID, err)
			}
			if strings.Contains(string(mergedParts(detail)), probe) {
				return nil
			}
			return fmt.Errorf("thread %s is visible to the dashboard but does not yet carry the TUI's message %q; "+
				"messages:\n%s", th.ID, probe, mergedParts(detail))
		}
		return fmt.Errorf("the dashboard client still sees only the %d thread(s) it saw before the TUI ran "+
			"(ids: %s); the TUI's thread has not reached the shared database",
			len(threads), idsOf(threads))
	})
}

func idsOf(threads []apiclient.Thread) string {
	if len(threads) == 0 {
		return "(none)"
	}
	out := make([]string, 0, len(threads))
	for _, th := range threads {
		out = append(out, th.ID)
	}
	return strings.Join(out, ", ")
}

// mergedParts flattens a thread's persisted message parts into one blob, so
// a failure message can show what the other surface actually read back.
func mergedParts(detail apiclient.ThreadDetail) []byte {
	var b strings.Builder
	for _, m := range detail.Messages {
		b.WriteString(m.Role)
		b.WriteString(": ")
		b.Write(m.Parts)
		b.WriteString("\n")
	}
	return []byte(b.String())
}
