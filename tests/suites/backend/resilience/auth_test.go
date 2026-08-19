package resilience_test

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// Auth faults. The phase document's row is:
//
//	A session expiring mid-turn; a token revoked mid-stream
//
// Both are injected while a turn is genuinely in flight -- the fake
// provider holds the outbound call open, the credential is destroyed, and
// only then is the provider released -- because the interesting question is
// not "does a dead token get rejected" (suites/backend/matrix already
// covers that for every route) but "what happens to work already underway
// when the credential behind it stops being valid".
//
// The bar has a specific shape here. A turn that was authorised when it
// started is allowed to finish; that is a legitimate design choice and
// internal/auth is explicit that ValidateSession runs per request, not per
// byte. What is NOT allowed is the turn hanging, the backend wedging, or
// the thread being left in a state the user cannot get back to after
// signing in again. That last one is the assertion that matters: a
// credential ending must not cost the user their data.
//
// One honest limitation, recorded as a skip in
// TestResilience_AuthExpiryNotCoveredHere as well as here: "expiring" is
// exercised as INVALIDATION, not as the clock passing. auth.SessionTTL is a
// 30-day const with no configuration hook, so a test cannot make a session
// age out. ValidateSession's two failure branches -- ErrSessionNotFound for
// a deleted row and ErrSessionExpired for an aged one -- are adjacent
// lines, and both end in the same 401, but only the first is proven here.

// TestResilience_SessionEndedMidTurnLeavesThreadRecoverable signs the user
// out from underneath a turn that is already talking to the provider.
func TestResilience_SessionEndedMidTurnLeavesThreadRecoverable(t *testing.T) {
	h := harness.New(t)
	identity := h.Identity("user")
	user := h.As("user")

	const threadID = "thread-resilience-session-ended"

	// A completed turn first, so there is something whose survival can be
	// asserted after the credential dies.
	h.Fake().OnPrompt(fakeprovider.Contains("resilience-session-before")).StreamText("Before the sign-out.")
	var err error
	runBounded(t, h, "the pre-sign-out turn", 60*time.Second, func(ctx context.Context) {
		_, err = user.ChatTurn(ctx, apiclient.ChatRequest{
			ID:      threadID,
			Message: apiclient.TextMessage("msg-auth-1", "resilience-session-before please"),
		})
	})
	if err != nil {
		t.Fatalf("the pre-sign-out turn failed: %v", err)
	}

	out := runTurnWithMidFlightFault(t, h, user, threadID, "msg-auth-2", "resilience-session-during",
		func(ctx context.Context) {
			if logoutErr := user.Logout(ctx); logoutErr != nil {
				t.Errorf("signing the user out mid-turn: %v", logoutErr)
			}
		})
	t.Logf("turn whose session was destroyed mid-flight: %s", out)

	// Client-visible: the credential really is gone, and the server says so
	// with 401 rather than 500 or a silent empty result.
	assertSessionRejected(t, h, user, "after signing out")

	// Recoverable: a fresh sign-in with the same account gets the thread
	// back, whole, and can carry on in it.
	reborn := signInAgain(t, h, identity.Email, identity.Password)
	before := readThread(t, h, reborn, threadID, "after signing in again")
	if !threadContains(before, "Before the sign-out") {
		t.Fatalf("the turn that completed before the session ended is missing after signing in again: %s",
			describeMessages(before))
	}
	assertBackendHealthy(t, h, reborn, "a session ended mid-turn")
	assertRecoversOnSameThread(t, h, reborn, threadID)
}

// TestResilience_TokenRevokedMidStreamLeavesThreadRecoverable has an ADMIN
// end the session, from another connection, while the user's stream is
// open.
//
// Different from signing out: the user did not ask, does not know, and is
// mid-sentence. It is also the path an operator actually uses -- banning an
// account is expected to stop it NOW, which is why
// internal/api/admin.UpdateBanStatus calls RevokeSessions rather than
// leaving the live session to expire on its own.
func TestResilience_TokenRevokedMidStreamLeavesThreadRecoverable(t *testing.T) {
	h := harness.New(t)
	identity := h.Identity("user")
	user := h.As("user")
	admin := h.As("admin")

	const threadID = "thread-resilience-token-revoked"

	h.Fake().OnPrompt(fakeprovider.Contains("resilience-revoke-before")).StreamText("Before the revocation.")
	var err error
	runBounded(t, h, "the pre-revocation turn", 60*time.Second, func(ctx context.Context) {
		_, err = user.ChatTurn(ctx, apiclient.ChatRequest{
			ID:      threadID,
			Message: apiclient.TextMessage("msg-revoke-1", "resilience-revoke-before please"),
		})
	})
	if err != nil {
		t.Fatalf("the pre-revocation turn failed: %v", err)
	}

	reason := "resilience suite: revoking a live session mid-stream"
	out := runTurnWithMidFlightFault(t, h, user, threadID, "msg-revoke-2", "resilience-revoke-during",
		func(ctx context.Context) {
			if banErr := admin.BanUser(ctx, identity.UserID, true, &reason); banErr != nil {
				t.Errorf("banning the user mid-stream: %v", banErr)
			}
		})
	t.Logf("turn whose token was revoked mid-stream: %s", out)

	assertSessionRejected(t, h, user, "after an admin revoked the session")

	// Lift the ban and sign in again: the account is usable, and so is
	// everything it had. A revocation that cost the user their threads
	// would be a data-loss bug wearing an access-control hat.
	runBounded(t, h, "lifting the ban", 30*time.Second, func(ctx context.Context) {
		if unbanErr := admin.BanUser(ctx, identity.UserID, false, nil); unbanErr != nil {
			t.Fatalf("lifting the ban: %v", unbanErr)
		}
	})
	reborn := signInAgain(t, h, identity.Email, identity.Password)
	before := readThread(t, h, reborn, threadID, "after the ban was lifted")
	if !threadContains(before, "Before the revocation") {
		t.Fatalf("the turn that completed before the revocation is missing afterwards: %s",
			describeMessages(before))
	}
	assertBackendHealthy(t, h, reborn, "a token revoked mid-stream")
	assertRecoversOnSameThread(t, h, reborn, threadID)
}

// runTurnWithMidFlightFault starts a streaming turn, waits until the
// backend's outbound provider call has genuinely begun, runs fault, then
// releases the provider and collects whatever the client saw.
//
// The handshake through providerReached is what makes "mid-turn" true
// rather than hoped for. Without it the fault could land before the request
// was routed or after the turn had finished, and the test would sometimes
// assert on a case it was not written for.
func runTurnWithMidFlightFault(t *testing.T, h *harness.Harness, c *apiclient.Client,
	threadID, msgID, marker string, fault func(ctx context.Context)) turnOutcome {
	t.Helper()

	providerReached := make(chan struct{})
	release := make(chan struct{})
	var reachedOnce, releasedOnce sync.Once
	h.Fake().OnPrompt(fakeprovider.Contains(marker)).
		Handle(func(w http.ResponseWriter, r *http.Request) bool {
			reachedOnce.Do(func() { close(providerReached) })
			select {
			case <-release:
			case <-r.Context().Done():
				return true
			}
			flusher, _ := w.(http.Flusher)
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			writeOpenAIDelta(w, "Answered after the credential was destroyed.")
			writeOpenAIFinish(w)
			if flusher != nil {
				flusher.Flush()
			}
			return true
		})

	result := make(chan turnOutcome, 1)
	turnCtx, cancelTurn := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancelTurn()
	go func() {
		var out turnOutcome
		stream, streamErr := c.Chat(turnCtx, apiclient.ChatRequest{
			ID:      threadID,
			Message: apiclient.TextMessage(msgID, marker+" please"),
		})
		if streamErr != nil {
			out.Err = streamErr
			result <- out
			return
		}
		turn, collectErr := stream.Collect()
		_ = stream.Close()
		out.Turn, out.Finished, out.Err = turn, turn.Finished, collectErr
		result <- out
	}()

	select {
	case <-providerReached:
	case <-time.After(60 * time.Second):
		releasedOnce.Do(func() { close(release) })
		t.Fatalf("the backend never reached the provider, so the fault could not be injected mid-turn\n"+
			"  provider calls served: %d, last prompt: %q\n  artifacts: %s",
			h.Fake().CallCount(), h.Fake().LastPrompt(), h.Dir())
	}

	faultCtx, cancelFault := context.WithTimeout(t.Context(), 30*time.Second)
	fault(faultCtx)
	cancelFault()

	releasedOnce.Do(func() { close(release) })

	select {
	case out := <-result:
		return out
	case <-time.After(60 * time.Second):
		t.Fatalf("the client was still blocked 60s after the mid-turn credential fault and the provider "+
			"was released; a turn whose credential died must end, one way or the other\n  artifacts: %s", h.Dir())
		return turnOutcome{}
	}
}

// assertSessionRejected is the client-visible half: the dead credential
// gets 401, not 200, not 500.
func assertSessionRejected(t *testing.T, h *harness.Harness, c *apiclient.Client, when string) {
	t.Helper()
	var err error
	runBounded(t, h, "GET /api/auth/session "+when, 30*time.Second, func(ctx context.Context) {
		_, err = c.Me(ctx)
	})
	if err == nil {
		t.Fatalf("the session still works %s; the credential was supposed to be gone", when)
	}
	if status := apiclient.StatusOf(err); status != http.StatusUnauthorized {
		t.Errorf("a destroyed session %s answers with HTTP %d, want 401: %v\n"+
			"  anything other than 401 tells the client the wrong thing to do about it", when, status, err)
	}
}

// signInAgain gets a working client back for the same account.
func signInAgain(t *testing.T, h *harness.Harness, email, password string) *apiclient.Client {
	t.Helper()
	var session apiclient.Session
	var err error
	runBounded(t, h, "signing in again as "+email, 30*time.Second, func(ctx context.Context) {
		session, err = h.Client().Login(ctx, email, password)
	})
	if err != nil {
		t.Fatalf("signing in again as %s after the credential fault: %v\n"+
			"  the account itself must survive; only the session was supposed to end", email, err)
	}
	return h.Client().As("user-reborn", session.Token)
}

// TestResilience_AuthExpiryNotCoveredHere records the one thing in the
// phase document's Auth row this suite proves by proxy rather than
// directly.
func TestResilience_AuthExpiryNotCoveredHere(t *testing.T) {
	h := harness.New(t, harness.NoBackend())
	h.Skip("PARTIAL, the phase document's \"a session expiring mid-turn\": the mid-turn credential loss is " +
		"proven by TestResilience_SessionEndedMidTurnLeavesThreadRecoverable, but by DELETING the session " +
		"row (auth.Service.Logout), not by letting one age out. auth.SessionTTL is a 30-day const in " +
		"backend-go/internal/auth/token.go with no environment or config hook, so no test can advance a " +
		"session past it; ValidateSession's ErrSessionExpired branch is therefore unexercised while its " +
		"ErrSessionNotFound branch is. Closing it needs either a configurable TTL on the application side " +
		"or a harness-owned way to write a past ExpiresAt, and writing the row directly would break the " +
		"rule that this module talks to Amiro only over its public surfaces.")
}
