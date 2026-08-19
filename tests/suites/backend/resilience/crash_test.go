package resilience_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/assert"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/fakeprovider"
	"amiro/tests/harness/process"
)

// TestResilience_KillBackendMidTurnLeavesThreadResumable is exit criterion
// 4, quoted verbatim from docs/testing/phases/phase-07-cross-surface.md:
//
//	"4. Killing the backend mid-turn leaves a thread that is intact and
//	resumable after restart."
//
// Four things have to be true at once for that sentence to mean anything,
// and the test is built so each fails separately and legibly:
//
//  1. The kill lands MID-TURN. A turn that had already finished would make
//     the rest trivially true. The fake provider blocks the turn open and
//     signals the moment the backend's outbound call arrives; the kill
//     happens on that signal, so the backend is provably inside the turn.
//  2. The kill is UNCOOPERATIVE. os.Process.Kill is SIGKILL on Unix and
//     TerminateProcess on Windows: no signal handler runs, no deferred
//     flush, no graceful drain. process.Process.Stop would send SIGTERM
//     first and let the server shut down cleanly, which is the opposite of
//     the fault being modelled -- a clean shutdown proving a thread
//     survives proves nothing about a crash.
//  3. The thread is INTACT. The turn that completed before the crash must
//     still be there, whole, with its text -- not a truncated row, not a
//     half-written parts blob. "Never a corrupt thread, never a silent
//     partial write" is the half of the bar a mere "the thread still
//     exists" assertion misses entirely.
//  4. The thread is RESUMABLE. A brand-new backend process, pointed at the
//     same database, must be able to run a further turn on it.
//
// Not asserted here, and deliberately: "the TUI reports it cleanly" and
// "the browser shows a disconnected state" from the same row of the phase
// document. Those are assertions about suites/tui and suites/ui rendering.
// What this test does assert is the wire-level fact both of them derive
// their rendering FROM -- that an in-flight stream terminates promptly with
// an error rather than hanging a client forever on a socket nobody will
// ever write to again.
func TestResilience_KillBackendMidTurnLeavesThreadResumable(t *testing.T) {
	h := harness.New(t, harness.Tags("destructive"))
	user := h.As("user")
	be := h.Backend()
	killedPort := be.Port

	const threadID = "thread-resilience-crash"
	const survivingText = "This answer must survive the crash."

	// 1. A complete turn BEFORE the crash. This is what "intact" is measured
	//    against; without it the test could pass against a database that
	//    lost everything.
	h.Fake().OnPrompt(fakeprovider.Contains("resilience-crash-first")).StreamText(survivingText)
	var first apiclient.Turn
	var err error
	runBounded(t, h, "the pre-crash turn", 60*time.Second, func(ctx context.Context) {
		first, err = user.ChatTurn(ctx, apiclient.ChatRequest{
			ID:      threadID,
			Message: apiclient.TextMessage("msg-crash-1", "resilience-crash-first please"),
		})
	})
	if err != nil {
		t.Fatalf("the pre-crash turn failed, so there is nothing to prove survived: %v", err)
	}
	if !strings.Contains(first.Text, survivingText) {
		t.Fatalf("the pre-crash turn returned %q, want it to contain %q", first.Text, survivingText)
	}

	beforeCrash := readThread(t, h, user, threadID, "before the crash")
	if len(beforeCrash.Messages) < 2 {
		t.Fatalf("expected the pre-crash thread to hold the user message and the assistant reply, got %d message(s)",
			len(beforeCrash.Messages))
	}
	t.Logf("pre-crash thread %s holds %d messages", threadID, len(beforeCrash.Messages))

	// 2. A second turn, held open at the provider so the kill lands inside
	//    it.
	providerReached := make(chan struct{})
	var reachedOnce sync.Once
	h.Fake().OnPrompt(fakeprovider.Contains("resilience-crash-second")).
		Handle(func(_ http.ResponseWriter, r *http.Request) bool {
			reachedOnce.Do(func() { close(providerReached) })
			<-r.Context().Done()
			return true
		})

	inflight := make(chan turnOutcome, 1)
	turnCtx, cancelTurn := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancelTurn()
	go func() {
		var out turnOutcome
		stream, streamErr := user.Chat(turnCtx, apiclient.ChatRequest{
			ID:      threadID,
			Message: apiclient.TextMessage("msg-crash-2", "resilience-crash-second please"),
		})
		if streamErr != nil {
			out.Err = streamErr
			inflight <- out
			return
		}
		turn, collectErr := stream.Collect()
		_ = stream.Close()
		out.Turn, out.Finished, out.Err = turn, turn.Finished, collectErr
		inflight <- out
	}()

	select {
	case <-providerReached:
	case <-time.After(60 * time.Second):
		t.Fatalf("the backend never made its outbound provider call, so there was no mid-turn to kill during\n"+
			"  provider calls served: %d, last prompt: %q\n  artifacts: %s",
			h.Fake().CallCount(), h.Fake().LastPrompt(), h.Dir())
	}

	// 3. SIGKILL. Not Stop(): see the doc comment.
	pid := be.Process().Pid()
	osProc, findErr := os.FindProcess(pid)
	if findErr != nil {
		t.Fatalf("locating the backend process (pid %d) to kill it: %v", pid, findErr)
	}
	if killErr := osProc.Kill(); killErr != nil {
		t.Fatalf("killing the backend (pid %d) mid-turn: %v", pid, killErr)
	}
	t.Logf("SIGKILLed the backend (pid %d, port %d) with a turn in flight", pid, killedPort)

	// 4. The in-flight client must be told, promptly. A client left blocked
	//    on a socket that will never be written to again is the "never a
	//    hang" half of the bar, and it is what the TUI's "connection lost"
	//    and the dashboard's disconnected state are both rendered from.
	select {
	case out := <-inflight:
		t.Logf("in-flight turn after the kill: %s", out)
		if !out.Failed() && out.Finished {
			t.Errorf("the turn that was in flight when the backend was killed reported an orderly, "+
				"error-free completion: %s", out)
		}
	case <-time.After(60 * time.Second):
		t.Fatalf("the client streaming the in-flight turn was still blocked 60s after the backend was SIGKILLed; "+
			"a killed server must close its connections, not strand its clients\n  artifacts: %s", h.Dir())
	}

	// 5. Teardown cleanliness, before anything else is started. The phase
	//    document's risk section: "Chaos tests can leak resources... killing
	//    processes mid-operation can leave files, ports and children
	//    behind." A leaked listener here would break the restart below in a
	//    way that looked like a database problem.
	assert.Eventually(t, "the killed backend process to be reaped", 30*time.Second, func() error {
		return be.Process().AssertStopped()
	})
	if portErr := process.AssertPortFree("127.0.0.1", killedPort, 30*time.Second); portErr != nil {
		t.Fatalf("the killed backend leaked its listener: %v", portErr)
	}

	// 6. A genuinely new server process against the SAME database. Same
	//    TestID means the same per-test directory, which means the same
	//    sqlite file and the same app-data directory -- see
	//    harness/backend.Start and harness/backend.newSQLite.
	var restarted *backend.Backend
	var restartErr error
	runBounded(t, h, "restarting the backend against the same database", 90*time.Second, func(ctx context.Context) {
		restarted, restartErr = backend.Start(ctx, backend.Options{
			RepoRoot: h.RepoRoot,
			BaseDir:  h.BaseDir,
			Config:   h.Config,
			Log:      h.Log,
			TestID:   h.TestID,
			Surface:  h.Surface,
			Address:  h.Address,
		})
	})
	if restartErr != nil {
		t.Fatalf("the backend did not come back up against the database a crash left behind: %v\n"+
			"  that alone fails exit criterion 4: a crashed thread that cannot be reopened is not resumable\n"+
			"  artifacts: %s", restartErr, h.Dir())
	}
	t.Cleanup(func() {
		// Registered AFTER harness.New's own cleanup, so it runs BEFORE it
		// (t.Cleanup is LIFO): the restarted server is stopped and asserted
		// clean while the harness's own teardown still has a database to
		// drop.
		if stopErr := restarted.Stop(context.Background()); stopErr != nil {
			t.Errorf("the restarted backend did not tear down cleanly: %v", stopErr)
		}
	})

	// The user's session lives in the database, so it survived the crash
	// with everything else. The sidecar token did not -- it is minted per
	// process -- so the client is rebuilt around the new one.
	resumed := apiClientFor(h, restarted, "user")

	assertBackendHealthy(t, h, resumed, "restarting after a mid-turn SIGKILL")

	// 7. INTACT: byte-for-byte the same messages, not merely the same count.
	afterCrash := readThread(t, h, resumed, threadID, "after the restart")
	assertThreadUnchanged(t, beforeCrash, afterCrash)
	if !threadContains(afterCrash, survivingText) {
		t.Fatalf("the thread survived the crash but its completed answer did not: no message contains %q\n"+
			"  messages after restart: %s", survivingText, describeMessages(afterCrash))
	}

	// 8. RESUMABLE: a further turn on the same thread, through the new
	//    process, and persisted.
	assertRecoversOnSameThread(t, h, resumed, threadID)
}

// readThread fetches a thread with a deadline, failing with the phase it
// was fetched in so a timeout says which side of the crash it was on.
func readThread(t *testing.T, h *harness.Harness, c *apiclient.Client, id, when string) apiclient.ThreadDetail {
	t.Helper()
	var detail apiclient.ThreadDetail
	var err error
	runBounded(t, h, "GET /api/thread/"+id+" "+when, 30*time.Second, func(ctx context.Context) {
		detail, err = c.GetThread(ctx, id)
	})
	if err != nil {
		t.Fatalf("reading thread %s %s: %v", id, when, err)
	}
	return detail
}

// assertThreadUnchanged compares every message a thread held before a crash
// against what it holds after.
//
// Comparing the PARTS, not just the ids or the count, is the point. A row
// whose parts blob was half-written when the process died has the same id
// and keeps the count identical; only its content shows the tear. That is
// precisely the "silent partial write" the bar forbids.
func assertThreadUnchanged(t *testing.T, before, after apiclient.ThreadDetail) {
	t.Helper()
	if len(after.Messages) < len(before.Messages) {
		t.Fatalf("the thread lost messages across the crash: %d before, %d after\n  before: %s\n  after:  %s",
			len(before.Messages), len(after.Messages), describeMessages(before), describeMessages(after))
	}
	byID := map[string]apiclient.Message{}
	for _, m := range after.Messages {
		byID[m.ID] = m
	}
	for _, want := range before.Messages {
		got, present := byID[want.ID]
		if !present {
			t.Errorf("message %s (role %s) was in the thread before the crash and is gone after it",
				want.ID, want.Role)
			continue
		}
		if got.Role != want.Role {
			t.Errorf("message %s changed role across the crash: %q -> %q", want.ID, want.Role, got.Role)
		}
		if !json.Valid(got.Parts) {
			t.Errorf("message %s came back from the crash with a parts blob that is not valid JSON: %s",
				want.ID, truncateForLog(string(got.Parts)))
			continue
		}
		if string(got.Parts) != string(want.Parts) {
			t.Errorf("message %s changed content across the crash -- a partial write\n  before: %s\n  after:  %s",
				want.ID, truncateForLog(string(want.Parts)), truncateForLog(string(got.Parts)))
		}
	}
}

func threadContains(d apiclient.ThreadDetail, want string) bool {
	for _, m := range d.Messages {
		if strings.Contains(string(m.Parts), want) {
			return true
		}
	}
	return false
}

func describeMessages(d apiclient.ThreadDetail) string {
	var b strings.Builder
	for i, m := range d.Messages {
		if i > 0 {
			b.WriteString("; ")
		}
		b.WriteString(m.ID + "(" + m.Role + ")=" + truncateForLog(string(m.Parts)))
	}
	if b.Len() == 0 {
		return "(none)"
	}
	return b.String()
}
