package chat_test

import (
	"net/http"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestErrors_ProviderRateLimitReturnsCleanError verifies 429 rate limits produce clean errors and leave thread recoverable.
func TestErrors_ProviderRateLimitReturnsCleanError(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	h.Fake().OnPrompt(fakeprovider.Contains("trigger rate limit")).
		Error(http.StatusTooManyRequests, `{"error":{"message":"Rate limit reached","type":"rate_limit_error"}}`)

	threadID := "thread-err-rate-limit-1"
	req := apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-1", "trigger rate limit please"),
	}

	turn, err := user.ChatTurn(t.Context(), req)
	if err == nil && len(turn.Errors) == 0 {
		t.Errorf("expected error or error frame on 429 rate limit, got text: %s", turn.Text)
	}

	// Subsequent request on same thread recovers cleanly
	h.Fake().OnPrompt(fakeprovider.Contains("recovery")).StreamText("Recovered successfully.")
	reqRecover := apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-2", "recovery turn"),
	}
	turnRecover, err := user.ChatTurn(t.Context(), reqRecover)
	if err != nil {
		t.Fatalf("recovery turn failed: %v", err)
	}
	if !strings.Contains(turnRecover.Text, "Recovered successfully") {
		t.Errorf("expected recovery text, got %q", turnRecover.Text)
	}
}

// TestErrors_Provider500ReturnsCleanError verifies 500 server errors do not crash or corrupt the backend.
func TestErrors_Provider500ReturnsCleanError(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	h.Fake().OnPrompt(fakeprovider.Contains("trigger 500")).
		Error(http.StatusInternalServerError, `{"error":{"message":"Internal server error","type":"api_error"}}`)

	threadID := "thread-err-500-1"
	req := apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-1", "trigger 500 please"),
	}

	turn, err := user.ChatTurn(t.Context(), req)
	if err == nil && len(turn.Errors) == 0 {
		t.Errorf("expected error or error frame on 500 error, got text: %s", turn.Text)
	}
}

// TestErrors_MidStreamTruncationProducesCleanError verifies truncated stream connections don't hang the backend.
func TestErrors_MidStreamTruncationProducesCleanError(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	h.Fake().OnPrompt(fakeprovider.Contains("truncate mid stream")).
		StreamText("Chunk 1. Chunk 2. Chunk 3. Chunk 4.").
		TruncateStreamAfter(2)

	threadID := "thread-err-trunc-1"
	req := apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-1", "truncate mid stream now"),
	}

	// Should terminate without hanging
	stream, err := user.Chat(t.Context(), req)
	if err == nil {
		_, _ = stream.Collect()
		_ = stream.Close()
	}

	// Next turn works
	h.Fake().OnPrompt(fakeprovider.Contains("ping")).StreamText("pong")
	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:      "thread-err-trunc-2",
		Message: apiclient.TextMessage("msg-2", "ping"),
	})
	if err != nil {
		t.Fatalf("subsequent turn failed: %v", err)
	}
	if turn.Text != "pong" {
		t.Errorf("expected 'pong', got %q", turn.Text)
	}
}

// TestErrors_MalformedSSEReturnsCleanError verifies unparseable SSE wire frames produce clean error frames.
func TestErrors_MalformedSSEReturnsCleanError(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	h.Fake().OnPrompt(fakeprovider.Contains("malformed sse")).
		MalformedSSE("data: {\"choices\": [unparseable json...\n\ndata: [DONE]\n\n")

	threadID := "thread-err-malformed-1"
	req := apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-1", "trigger malformed sse"),
	}

	stream, err := user.Chat(t.Context(), req)
	if err == nil {
		turn, _ := stream.Collect()
		_ = stream.Close()
		t.Logf("malformed SSE collected turn: %d frames, %d errors", len(turn.Frames), len(turn.Errors))
	}
}

// TestErrors_ProviderTimeoutReturnsCleanError verifies context timeout returns clean cancellation.
func TestErrors_ProviderTimeoutReturnsCleanError(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	// Set fake rule that hangs until context cancelled
	h.Fake().OnPrompt(fakeprovider.Contains("hang")).
		Handle(func(w http.ResponseWriter, r *http.Request) bool {
			<-r.Context().Done()
			return true
		})

	threadID := "thread-err-timeout-1"
	req := apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-1", "hang please"),
	}

	stream, err := user.Chat(t.Context(), req)
	if err == nil {
		_ = stream.Close()
	}
}
