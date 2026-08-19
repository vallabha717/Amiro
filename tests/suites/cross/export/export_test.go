// Package export_test proves Phase 7's "Export" cross-surface journey,
// quoted verbatim from the Section 1 table of
// docs/testing/phases/phase-07-cross-surface.md:
//
//	| Export | Export from the TUI, open the public link in a signed-out browser |
//
// and contributes to Exit Criterion 1, quoted verbatim: "`amirotest run
// --surface cross` passes, and every cross-surface journey above has a
// test."
//
// WHAT THIS ADDS OVER THE EXISTING EXPORT TEST.
// suites/backend/chat/export_test.go's TestExport_PublishesAndFetchesThreadExport
// already covers publish-and-read-back, but it does both halves through the
// SAME authenticated client (`user.ExportThread` then `user.GetExport`), so
// it proves nothing about the link being public and nothing about a second
// surface. Both of those are the whole point of this row, so both are what
// this test adds:
//   - the export is created by the real `amiro` binary, from its real
//     `/export` slash command, on a real terminal (not by an API call
//     standing in for one);
//   - the public link is fetched by a genuinely UNAUTHENTICATED client --
//     no Authorization header at all -- which is what "signed out" means on
//     the wire. GET /api/export/{id} is the one route mounted with an
//     OPTIONAL session (internal/httpserver/router.go's `optional(...)`),
//     and the anonymous case is worth testing precisely because it is the
//     exception.
//
// ONE THING THIS DELIBERATELY DOES NOT ASSERT.
// The TUI's own on-screen confirmation of the export is not checked. See the
// comment at the assertion site: page.Chat's exportedMsg case sets m.notice
// without calling refreshTranscript, so as shipped nothing repaints it, and
// forcing a repaint from the test did not surface it either. That is
// reported as a finding rather than asserted either way.
//
// ONE HONEST CAVEAT ABOUT "SIGNED-OUT BROWSER".
// The anonymous client still sends the sidecar shared secret
// (X-Amiro-Token), because middleware.RequireToken guards the whole mux and
// /api/export is not in tokenExemptPrefixes. That header is a transport-level
// guard on the sidecar, not a user identity: a real signed-out browser
// against `amiro serve` is exempted from it a different way
// (middleware.RequireTokenOrBrowser accepts a same-origin browser request),
// and would carry no user session either. So what is proven here is exactly
// the property the row is about -- no USER session is needed to read the
// public link -- and not the orthogonal question of how the shared secret is
// satisfied. A control assertion below pins that the same anonymous client
// is genuinely signed out, by requiring it to be refused on the underlying
// thread.
package export_test

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

func TestCrossSurface_ExportCreatedInTheTUIIsReadableBySignedOutClient(t *testing.T) {
	const probe = "cross surface export probe"
	const answer = "Export probe acknowledged."

	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains(probe)).StreamText(answer)
	}))
	be := h.Backend()
	owner := h.As("admin")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

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
		t.Fatalf("the TUI turn did not complete, so there is nothing to export: %v\nframe:\n%s", err, sess.Frame())
	}

	// The turn's rows have to be in the database before /export copies them:
	// RunTurn persists just before it writes [DONE], while the reply text the
	// terminal renders arrives earlier, so exporting the instant the text
	// appears could publish a thread that is still one message short. Waited
	// for against the real API rather than slept on.
	assert.Eventually(t, "the TUI's turn to be fully persisted before it is exported", 30*time.Second, func() error {
		threads, err := owner.ListThreads(ctx)
		if err != nil {
			return fmt.Errorf("GET /api/thread: %w", err)
		}
		if len(threads) == 0 {
			return fmt.Errorf("the TUI's thread has not reached the shared database yet")
		}
		detail, err := owner.GetThread(ctx, threads[0].ID)
		if err != nil {
			return fmt.Errorf("GET /api/thread/%s: %w", threads[0].ID, err)
		}
		var user, assistant bool
		for _, m := range detail.Messages {
			switch m.Role {
			case "user":
				user = true
			case "assistant":
				assistant = true
			}
		}
		if !user || !assistant {
			return fmt.Errorf("thread %s has user=%v assistant=%v; the turn is not fully persisted",
				threads[0].ID, user, assistant)
		}
		return nil
	})

	// The export is created by the TUI itself -- page.Chat's "/export"
	// command, which calls client.ExportThread.
	if err := sess.SendLine("/export"); err != nil {
		t.Fatalf("running /export in the TUI: %v", err)
	}

	// The export row is what proves /export ran: nothing in this test ever
	// calls ExportThread itself, so an export existing at all can only have
	// come from the TUI process. Polled against the real API rather than
	// slept for. The list route is session-gated, so this read is the
	// OWNER's -- the anonymous read is the next step.
	var export apiclient.Export
	assert.Eventually(t, "the export the TUI created to be listed for its owner", 30*time.Second, func() error {
		exports, err := owner.ListExports(ctx)
		if err != nil {
			return fmt.Errorf("GET /api/export: %w", err)
		}
		if len(exports) == 0 {
			return fmt.Errorf("the owner sees no exports at all, so the TUI's /export did not publish anything")
		}
		export = exports[0]
		return nil
	})
	if export.ID == "" {
		t.Fatalf("the listed export has no id: %+v", export)
	}

	// It exported the thread the TUI was actually in, not some other row.
	threads, err := owner.ListThreads(ctx)
	if err != nil {
		t.Fatalf("GET /api/thread: %v", err)
	}
	if len(threads) != 1 {
		t.Fatalf("expected exactly the one thread the TUI created, got %d", len(threads))
	}
	if export.OriginalThreadID == nil || *export.OriginalThreadID != threads[0].ID {
		t.Errorf("the export points at thread %v, but the TUI's thread is %s",
			export.OriginalThreadID, threads[0].ID)
	}

	// And the TUI shows the user the very link that was published -- the id
	// it prints must be the id the API listed, which is what "open the
	// public link" means for someone reading it off a terminal.
	//
	// The resizes are not decoration, and they are a defect being worked
	// around rather than a timing hack. page.Chat's exportedMsg case sets
	// m.notice and returns WITHOUT calling m.refreshTranscript, and the
	// notice is rendered into the viewport's cached content by
	// refreshTranscript alone (page/chat.go's render). So the confirmation
	// is invisible until some other event rebuilds that content; a
	// WindowSizeMsg is the cheapest one (page.Chat.resize ends in
	// refreshTranscript). The size is alternated because a resize to the
	// same dimensions is not a change, and the poll retries because the
	// exportedMsg may not have been processed yet when the first resize
	// lands. Reported as a TUI bug rather than papered over: as shipped, a
	// user who runs /export sees no confirmation at all until their next
	// turn.
	// The on-screen confirmation is deliberately NOT asserted, and that is a
	// gap worth naming rather than hiding. page.Chat's exportedMsg case sets
	// m.notice and returns without calling m.refreshTranscript, and the
	// notice is only ever rendered into the viewport's cached content by
	// refreshTranscript (page/chat.go's render) -- so as shipped, a user who
	// runs /export sees no confirmation until something else rebuilds that
	// content. Attempts to force it here with a terminal resize (which does
	// reach page.Chat.resize -> refreshTranscript) still never produced the
	// notice, and the harness's terminal emulator was independently observed
	// to render this screen unfaithfully in the same session, so an
	// assertion either way would be unsound. Both observations are reported
	// as findings; what IS asserted below is the part that is unambiguous --
	// the export the TUI published, and who can read it.

	// A genuinely signed-out client: no Authorization header at all.
	signedOut := owner.Anonymous()
	if signedOut.Session != "" {
		t.Fatalf("the signed-out client still carries a session; this test would prove nothing")
	}

	// Control: the same client must be refused on the underlying thread.
	// Without this, a backend that had simply stopped checking sessions
	// would pass the assertion below.
	if _, err := signedOut.ListThreads(ctx); err == nil {
		t.Fatalf("the signed-out client could list threads, so it is not actually signed out and the public-link " +
			"assertion below would prove nothing")
	} else if status := apiclient.StatusOf(err); status != 401 && status != 403 {
		t.Errorf("the signed-out client's thread list was refused with status %d; expected 401 or 403 (err: %v)",
			status, err)
	}

	detail, err := signedOut.GetExport(ctx, export.ID)
	if err != nil {
		t.Fatalf("a signed-out client could not open the public export link the TUI produced: %v", err)
	}
	if detail.ID != export.ID {
		t.Errorf("the public link returned export %s, expected %s", detail.ID, export.ID)
	}
	if !strings.Contains(string(detail.Messages), probe) {
		t.Errorf("the public export does not carry the conversation the TUI exported (looked for %q)\nmessages: %s",
			probe, detail.Messages)
	}
}
