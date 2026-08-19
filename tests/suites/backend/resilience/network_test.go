package resilience_test

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// writeOpenAIDelta and writeOpenAIFinish emit the two SSE frames a
// hand-rolled fakeprovider handler needs. fakeprovider builds these itself
// for its declarative rules; a Handle() that controls its own timing has to
// spell them out, and spelling them out twice in one file is one time too
// many.
func writeOpenAIDelta(w io.Writer, text string) {
	payload := map[string]any{
		"id":      "chatcmpl-fake-timed",
		"object":  "chat.completion.chunk",
		"created": 1700000000,
		"model":   "gpt-4.1",
		"choices": []map[string]any{
			{"index": 0, "delta": map[string]any{"content": text}},
		},
	}
	b, _ := json.Marshal(payload)
	_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
}

func writeOpenAIFinish(w io.Writer) {
	payload := map[string]any{
		"id":      "chatcmpl-fake-timed",
		"object":  "chat.completion.chunk",
		"created": 1700000000,
		"model":   "gpt-4.1",
		"choices": []map[string]any{
			{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"},
		},
	}
	b, _ := json.Marshal(payload)
	_, _ = fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", b)
}

// Network faults. The phase document's row is:
//
//	Slow responses, connection reset mid-stream, DNS failure, TLS failure
//
// The first two are injected at the fake provider. The last two cannot be:
// harness/fakeprovider is an httptest.Server on 127.0.0.1, and a request to
// a loopback literal over plain HTTP performs neither a DNS lookup nor a
// TLS handshake -- there is nothing there to break. Returning an HTTP error
// and calling it "DNS failure" would be a test that proves nothing, which
// is the failure mode this project's standards single out.
//
// So they are injected one layer out instead, at the place the application
// actually resolves and dials: a provider connection's own base URL, which
// POST /api/ai/providers stores and internal/ai/bifrost's account.go hands
// to the client as NetworkConfig.BaseURL. Pointing one at a hostname under
// the .invalid TLD (RFC 6761 guarantees it never resolves) makes the
// backend perform, and fail, a real DNS lookup. Pointing another at an
// httptest TLS server with a self-signed certificate makes it perform, and
// fail, a real TLS handshake. Both are genuine faults in the real outbound
// code path, not simulations of one.

// TestResilience_SlowProviderResponseStreamsWithoutHanging asserts that a
// provider which stalls indefinitely between chunks does not stall the
// client's first token, and that the turn completes when the provider
// eventually continues.
//
// The stall is a channel the test itself closes, not a duration. That
// matters twice over: there is no sleep, and the test is deterministic --
// the provider is held open until the client has PROVABLY received the
// first delta, which is a stronger statement than "it was still fast after
// 200ms" and cannot flake on a loaded machine.
func TestResilience_SlowProviderResponseStreamsWithoutHanging(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	release := make(chan struct{})
	const head = "FIRST-TOKEN. "
	const tail = "AND-THE-REST."

	h.Fake().OnPrompt(fakeprovider.Contains("resilience-slow-provider")).
		Handle(func(w http.ResponseWriter, r *http.Request) bool {
			flusher, _ := w.(http.Flusher)
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.WriteHeader(http.StatusOK)
			writeOpenAIDelta(w, head)
			if flusher != nil {
				flusher.Flush()
			}
			// Stall. Only the test releasing this, or the request being
			// cancelled, ends it.
			select {
			case <-release:
			case <-r.Context().Done():
				return true
			}
			writeOpenAIDelta(w, tail)
			writeOpenAIFinish(w)
			if flusher != nil {
				flusher.Flush()
			}
			return true
		})

	const threadID = "thread-resilience-slow"
	var text strings.Builder
	var finished bool
	var streamErr error

	runBounded(t, h, "a turn against a provider stalled mid-stream", 60*time.Second, func(ctx context.Context) {
		stream, err := user.Chat(ctx, apiclient.ChatRequest{
			ID:      threadID,
			Message: apiclient.TextMessage("msg-slow", "resilience-slow-provider please"),
		})
		if err != nil {
			streamErr = err
			return
		}
		defer func() { _ = stream.Close() }()

		releasedOnce := false
		for stream.Next() {
			f := stream.Frame()
			if f.Type == apiclient.FrameTextDelta {
				text.WriteString(f.Delta)
				// The first delta reaching the client while the provider is
				// still holding its connection open is the whole assertion:
				// nothing between here and the provider buffered the turn.
				if !releasedOnce && strings.Contains(text.String(), head) {
					releasedOnce = true
					close(release)
				}
			}
		}
		finished = stream.Done()
		streamErr = stream.Err()
		if !releasedOnce {
			// Unblock the handler regardless, so the fake's goroutine cannot
			// outlive the test holding a connection.
			close(release)
		}
	})

	if streamErr != nil {
		t.Fatalf("a stalled-then-resumed provider stream failed: %v (text so far %q)", streamErr, text.String())
	}
	if !strings.Contains(text.String(), head) || !strings.Contains(text.String(), tail) {
		t.Errorf("stalled stream delivered %q, want it to contain both %q and %q", text.String(), head, tail)
	}
	if !finished {
		t.Errorf("a stalled-then-resumed stream did not end with [DONE]; text was %q", text.String())
	}

	assertBackendHealthy(t, h, user, "a slow provider response")
}

// TestResilience_ConnectionResetMidStream covers two rows of the phase
// document at once, because they are the same fault: "connection reset
// mid-stream" under Network, and the transport half of "stream dying
// mid-chunk" under Provider failures.
//
// fakeprovider.Rule.ResetMidStream, added for this test, hijacks the
// connection and closes it with SO_LINGER 0 so the client gets a TCP RST
// partway through the body. That is a different fault from
// TruncateStreamAfter, which returns from the handler and lets net/http end
// the response properly -- see the note at the top of provider_test.go.
func TestResilience_ConnectionResetMidStream(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	const threadID = "thread-resilience-reset"
	h.Fake().OnPrompt(fakeprovider.Contains("resilience-connection-reset")).
		ResetMidStream("Chunk one. Chunk two. Chunk three. Chunk four.", 2)

	out := faultedTurn(t, h, user, "the reset-mid-stream turn", 60*time.Second, apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-reset", "resilience-connection-reset please"),
	})
	t.Logf("connection reset outcome: %s", out)

	// A turn whose provider connection was destroyed mid-frame must not
	// report an orderly completion. [DONE] is the sentinel both the TUI and
	// the dashboard treat as "the turn is over, safe to act on"; emitting it
	// after a transport failure would tell a client the truncated answer is
	// the whole answer.
	if out.Finished && !out.Failed() {
		t.Errorf("a stream whose provider connection was reset mid-chunk reported an orderly, error-free finish: %s\n"+
			"  the client cannot tell a destroyed connection from a completed answer", out)
	}

	assertBackendHealthy(t, h, user, "a connection reset mid-stream")
	assertRecoversOnSameThread(t, h, user, threadID)
}

// TestResilience_DNSFailureOnProviderCall points a real provider connection
// at a hostname that cannot resolve and asserts the turn fails cleanly.
//
// .invalid is reserved by RFC 6761 precisely so that it never resolves,
// anywhere, which is what makes this deterministic offline and on a
// developer machine behind a resolver that NXDOMAIN-hijacks.
func TestResilience_DNSFailureOnProviderCall(t *testing.T) {
	h := harness.New(t)
	admin := h.As("admin")
	user := h.As("user")

	cfgID := saveProviderConnection(t, h, admin, "resilience-dns", "https://amiro-provider-does-not-resolve.invalid/v1")

	const threadID = "thread-resilience-dns"
	out := faultedTurn(t, h, user, "a turn against a non-resolving provider host", 60*time.Second, apiclient.ChatRequest{
		ID:        threadID,
		Message:   apiclient.TextMessage("msg-dns", "hello over a broken resolver"),
		ChatModel: &apiclient.ChatModel{Provider: cfgID, Model: "gpt-4.1"},
	})
	t.Logf("DNS failure outcome: %s", out)
	if !out.Failed() {
		t.Errorf("a provider whose hostname cannot resolve produced no client-visible error: %s", out)
	}

	assertBackendHealthy(t, h, user, "a DNS failure on a provider call")
	assertRecoversOnSameThread(t, h, user, threadID)
}

// TestResilience_TLSFailureOnProviderCall points a real provider connection
// at an HTTPS endpoint whose certificate the backend has no reason to
// trust, and asserts the handshake failure is reported rather than ignored.
//
// The second assertion is the security-relevant one and is why this test is
// not merely "another way to make a request fail": a backend that answered
// successfully here would be one that skips certificate verification on
// outbound provider calls, which is how an API key leaves the machine to
// whoever is holding the socket.
func TestResilience_TLSFailureOnProviderCall(t *testing.T) {
	h := harness.New(t)
	admin := h.As("admin")
	user := h.As("user")

	// A self-signed certificate minted by httptest, trusted by nothing.
	// Whatever reaches it is recorded so the assertion below can tell
	// "the handshake failed" from "the handshake succeeded and the body
	// was rejected".
	var handshakesCompleted atomic.Int64
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		handshakesCompleted.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":{"message":"this server should never have been reached"}}`))
	}))
	tlsSrv.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	t.Cleanup(tlsSrv.Close)

	cfgID := saveProviderConnection(t, h, admin, "resilience-tls", tlsSrv.URL+"/v1")

	const threadID = "thread-resilience-tls"
	out := faultedTurn(t, h, user, "a turn against an untrusted TLS endpoint", 60*time.Second, apiclient.ChatRequest{
		ID:        threadID,
		Message:   apiclient.TextMessage("msg-tls", "hello over an untrusted certificate"),
		ChatModel: &apiclient.ChatModel{Provider: cfgID, Model: "gpt-4.1"},
	})
	t.Logf("TLS failure outcome: %s (requests that got past the handshake: %d)", out, handshakesCompleted.Load())

	if handshakesCompleted.Load() != 0 {
		t.Errorf("the backend completed a TLS handshake with a self-signed certificate it has no reason to trust "+
			"(%d request(s) reached the server); outbound provider calls are not verifying certificates",
			handshakesCompleted.Load())
	}
	if !out.Failed() {
		t.Errorf("a failed TLS handshake produced no client-visible error: %s", out)
	}

	assertBackendHealthy(t, h, user, "a TLS failure on a provider call")
	assertRecoversOnSameThread(t, h, user, threadID)
}

// saveProviderConnection stores a provider connection whose base URL points
// somewhere deliberately broken, and returns the id a chat request names it
// by.
//
// Two details here are load-bearing, and both were found by this test
// failing:
//
//   - The turn names the connection by its generated ID, not by a provider
//     type. internal/ai/bifrost's Resolve passes chatModel.provider straight
//     through as the Bifrost provider key, and the id is unambiguous.
//   - The stored provider TYPE must not be "openai".
//     repository.ProviderRepository.Get matches `id = ? OR provider = ?` and
//     takes First(), so a second row typed "openai" is a coin flip against
//     the seeded one -- and the coin came up broken: the recovery turn,
//     which asks for no particular model and therefore falls back to the
//     "openai" key, resolved to THIS deliberately broken connection and
//     failed. The test read as "the thread did not recover" when the thread
//     was fine. An unmatched type falls back to the OpenAI wire protocol in
//     bifrost's GetConfigForProvider, which is what these fixtures want.
func saveProviderConnection(t *testing.T, h *harness.Harness, admin *apiclient.Client, name, baseURL string) string {
	t.Helper()
	var saved apiclient.Provider
	var err error
	runBounded(t, h, "saving the "+name+" provider connection", 30*time.Second, func(ctx context.Context) {
		saved, err = admin.SaveProvider(ctx, apiclient.ProviderInput{
			Name:     name,
			Provider: name,
			// Synthetic and obviously fake. Nothing here is a real credential
			// and nothing here should ever leave the machine -- which is
			// itself one of the things TestResilience_TLSFailureOnProviderCall
			// asserts.
			APIKey:  "not-a-real-key-" + name,
			BaseURL: baseURL,
			Models:  []string{"gpt-4.1"},
		})
	})
	if err != nil {
		t.Fatalf("saving the %s provider connection: %v", name, err)
	}
	if saved.ID == "" {
		t.Fatalf("POST /api/ai/providers returned no id for %s; the chat request has nothing to name it by", name)
	}
	return saved.ID
}
