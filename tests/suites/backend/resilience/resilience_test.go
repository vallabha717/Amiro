// Package resilience_test is Phase 7 section 2: deliberate failure
// injection at every layer Amiro depends on, asserting the one bar the
// phase document sets for all of them --
//
//	"a clean, client-visible error and a recoverable state. Never a hang,
//	never a panic, never a corrupt thread, never a silent partial write."
//
// and the two exit criteria it is measured by, quoted verbatim from
// docs/testing/phases/phase-07-cross-surface.md:
//
//	"3. Every resilience class produces a clean error and a recoverable
//	state; no test hangs."
//
//	"4. Killing the backend mid-turn leaves a thread that is intact and
//	resumable after restart."
//
// Two rules shape every file here.
//
// The first is that a hang must FAIL, fast, with state. A resilience test
// that blocks until `go test`'s own timeout kills the binary produces a
// stack dump of every goroutine in the process and no answer to the only
// question that matters -- what was the backend doing. Everything that
// could hang goes through runBounded, which has its own deadline, its own
// diagnostic, and names the artifact directory.
//
// The second is that a chaos test cleans up after itself. The phase
// document's risk section is explicit: "Chaos tests can leak resources...
// harness/process's teardown assertions are what keep this from silently
// degrading later tests." Anything here that kills a process asserts the
// process is gone and its port is free before it returns.
package resilience_test

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/fakeprovider"
)

// hangGrace is how much longer than its own context deadline an operation
// gets before runBounded calls it hung.
//
// The gap is the point: a well-behaved operation notices its context is
// done and returns an error, so it finishes INSIDE the deadline. Only an
// operation that ignores cancellation -- the actual failure mode "never a
// hang" is about -- runs past deadline+grace. Reporting the two separately
// is what makes the diagnostic say "it ignored cancellation" rather than
// "it was slow".
const hangGrace = 10 * time.Second

// runBounded runs fn with a deadline and fails the test with a real
// diagnostic if it does not return.
//
// A bare `context deadline exceeded` bubbling out of an HTTP client tells
// you nothing about which of the three processes involved was stuck. This
// prints what was being attempted, both deadlines, the backend that was
// meant to answer, how many provider calls the fake had served by then, and
// where the logs are.
func runBounded(t *testing.T, h *harness.Harness, what string, within time.Duration, fn func(ctx context.Context)) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), within)
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		fn(ctx)
	}()

	select {
	case <-done:
	case <-time.After(within + hangGrace):
		t.Fatalf("HUNG: %s did not return within %s, %s past its own %s deadline.\n"+
			"  This is exactly the failure this suite exists to catch: the bar is a clean,\n"+
			"  client-visible error and a recoverable state -- never a hang.\n"+
			"  backend:              %s\n"+
			"  provider calls served: %d\n"+
			"  last prompt seen:      %q\n"+
			"  artifacts:             %s",
			what, within+hangGrace, hangGrace, within,
			backendURL(h), h.Fake().CallCount(), h.Fake().LastPrompt(), h.Dir())
	}
}

// backendURL reports the backend's address for the hang diagnostic above.
//
// Only ever called from inside a t.Fatalf argument list on the timeout
// branch, so a test that never started a harness-owned backend pays nothing
// for it on the happy path.
func backendURL(h *harness.Harness) string {
	be := h.Backend()
	if be == nil {
		return "(none started)"
	}
	return be.URL
}

// apiClientFor builds a client against a backend this test started itself,
// rather than the one harness.Backend() owns.
//
// The sidecar token is minted per process, so a server started by hand
// needs its own client; the user's SESSION lives in the database and is
// therefore the same one across every server pointed at that database,
// which is what makes a crash-and-restart test able to keep acting as the
// same person.
func apiClientFor(h *harness.Harness, be *backend.Backend, identity ...string) *apiclient.Client {
	c := apiclient.New(apiclient.Options{
		BaseURL:      be.URL,
		Token:        be.Token,
		Log:          h.Log,
		NDJSONPath:   "backend/" + h.TestID + "/http.ndjson",
		Surface:      h.Surface,
		Address:      h.Address,
		LogBodies:    h.Config.Logging.HTTPBodies,
		MaxBodyBytes: h.Config.Logging.MaxBodyBytes,
	})
	if len(identity) == 1 {
		return c.As(identity[0], h.Identity(identity[0]).Token)
	}
	return c
}

// turnOutcome is what a fault-injected turn produced, flattened so an
// assertion can talk about "did the client learn something went wrong"
// without caring whether the news arrived as a transport error, an HTTP
// status, or an in-band error frame. All three are legitimate ways for the
// server to report a provider failure and which one you get depends on how
// far into the turn the failure happened.
type turnOutcome struct {
	Err      error
	Turn     apiclient.Turn
	Finished bool
}

// Failed reports whether the client was told, one way or another, that the
// turn did not succeed.
func (o turnOutcome) Failed() bool {
	return o.Err != nil || len(o.Turn.Errors) > 0
}

func (o turnOutcome) String() string {
	return fmt.Sprintf("err=%v errorFrames=%v finished=%t text=%q frames=%d",
		o.Err, o.Turn.Errors, o.Finished, o.Turn.Text, len(o.Turn.Frames))
}

// faultedTurn runs one chat turn that is expected to fail, bounded by a
// deadline, and returns everything the client observed.
func faultedTurn(t *testing.T, h *harness.Harness, c *apiclient.Client, what string,
	within time.Duration, req apiclient.ChatRequest) turnOutcome {
	t.Helper()
	var out turnOutcome
	runBounded(t, h, what, within, func(ctx context.Context) {
		stream, err := c.Chat(ctx, req)
		if err != nil {
			out.Err = err
			return
		}
		defer func() { _ = stream.Close() }()
		turn, collectErr := stream.Collect()
		out.Turn = turn
		out.Finished = turn.Finished
		if collectErr != nil {
			out.Err = collectErr
		}
	})
	return out
}

// probeCounter mints the marker a recovery turn is matched on.
//
// Deliberately unrelated to the thread id. Rules accumulate on the fake and
// findMatchingRule returns the FIRST whose matcher accepts, so a recovery
// prompt built out of the thread id would be matched by the fault rule
// registered against that same thread -- the recovery turn would re-run the
// fault and the test would report "did not recover" for the wrong reason.
// That is not hypothetical: it is what the first run of this suite did.
var probeCounter atomic.Int64

// assertRecoversOnSameThread is the second half of every provider-failure
// case, and the half that distinguishes "the error was reported" from "the
// error left something usable".
//
// A backend can return a perfectly clean 500 to the client and still have
// wedged the thread -- a half-written row, a session left in a failed
// state, a mutex never released. The only assertion that rules that out is
// a real, successful turn on the SAME thread afterwards, and then reading
// the thread back and finding both turns in it.
//
// This is the gap this suite closes: suites/backend/chat/errors_test.go
// asserts it for the 429 case only.
func assertRecoversOnSameThread(t *testing.T, h *harness.Harness, c *apiclient.Client, threadID string) {
	t.Helper()
	marker := fmt.Sprintf("zz-recovery-probe-%d", probeCounter.Add(1))
	want := "Recovered via " + marker
	h.Fake().OnPrompt(fakeprovider.Contains(marker)).StreamText(want)

	var turn apiclient.Turn
	var err error
	runBounded(t, h, "the recovery turn on thread "+threadID, 60*time.Second, func(ctx context.Context) {
		turn, err = c.ChatTurn(ctx, apiclient.ChatRequest{
			ID:      threadID,
			Message: apiclient.TextMessage(marker+"-msg", marker+" please"),
		})
	})
	if err != nil {
		t.Fatalf("the thread did not recover: a normal turn on %s after the injected fault failed: %v", threadID, err)
	}
	if !strings.Contains(turn.Text, want) {
		t.Fatalf("the thread did not recover: recovery turn on %s returned %q, want it to contain %q\nframes: %d, errors: %v",
			threadID, turn.Text, want, len(turn.Frames), turn.Errors)
	}

	// Reading the thread back is the "never a corrupt thread" half. A turn
	// that streamed fine but persisted nothing would pass the assertion
	// above and fail this one.
	var detail apiclient.ThreadDetail
	runBounded(t, h, "reading thread "+threadID+" back", 30*time.Second, func(ctx context.Context) {
		detail, err = c.GetThread(ctx, threadID)
	})
	if err != nil {
		t.Fatalf("the thread is not readable after the injected fault: GET /api/thread/%s: %v", threadID, err)
	}
	if len(detail.Messages) == 0 {
		t.Fatalf("thread %s came back with no messages at all after a successful recovery turn; "+
			"the recovery turn streamed %q but persisted nothing", threadID, turn.Text)
	}
	foundRecovery := false
	for _, m := range detail.Messages {
		if strings.Contains(string(m.Parts), want) {
			foundRecovery = true
		}
	}
	if !foundRecovery {
		t.Errorf("thread %s has %d messages but none contains the recovery turn's text %q; "+
			"the turn streamed successfully but was not persisted",
			threadID, len(detail.Messages), want)
	}
}

// assertBackendHealthy is the "never a panic" assertion: a server that
// crashed on the injected fault answers nothing at all here.
func assertBackendHealthy(t *testing.T, h *harness.Harness, c *apiclient.Client, after string) {
	t.Helper()
	var err error
	runBounded(t, h, "/health after "+after, 30*time.Second, func(ctx context.Context) {
		err = c.Health(ctx)
	})
	if err != nil {
		t.Fatalf("the backend is not healthy after %s: %v\n"+
			"  a fault injected at one layer must not take the server down; artifacts: %s",
			after, err, h.Dir())
	}
}
