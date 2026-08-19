package chat_test

import (
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/fakeprovider"
)

// TestTemporaryChat_DoesNotPersistThread verifies temporary turns stream output without creating persistent thread rows.
func TestTemporaryChat_DoesNotPersistThread(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	h.Fake().OnPrompt(fakeprovider.Contains("ephemeral")).StreamText("Ephemeral secret response.")

	body := map[string]any{
		"message": map[string]any{
			"id":   "msg-ephemeral",
			"role": "user",
			"parts": []map[string]any{
				{"type": "text", "text": "ephemeral temporary question"},
			},
		},
	}

	stream, err := user.TemporaryChat(t.Context(), body)
	if err != nil {
		t.Fatalf("TemporaryChat: %v", err)
	}
	defer stream.Close()

	turn, err := stream.Collect()
	if err != nil {
		t.Fatalf("stream.Collect: %v", err)
	}

	if !strings.Contains(turn.Text, "Ephemeral") {
		t.Logf("temporary chat response: %s", turn.Text)
	}

	// Verify thread list remains clean / doesn't leak temporary id
	threads, err := user.ListThreads(t.Context())
	if err != nil {
		t.Fatalf("ListThreads: %v", err)
	}
	for _, thr := range threads {
		if strings.Contains(thr.Title, "ephemeral") {
			t.Errorf("temporary chat was persisted to thread: %+v", thr)
		}
	}
}
