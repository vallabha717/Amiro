package chat_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestTitle_GeneratesAndReturnsTitle verifies POST /api/chat/title uses LLM to name threads.
func TestTitle_GeneratesAndReturnsTitle(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	threadID := "thread-title-gen-1"

	// Create an initial message in thread
	h.Fake().OnPrompt(fakeprovider.Any()).StreamText("Golang Distributed Systems Architecture")
	req := apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-1", "How do Raft and Paxos consensus algorithms compare in Golang?"),
	}
	_, err := user.ChatTurn(t.Context(), req)
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	body := map[string]any{
		"threadId": threadID,
		"message":  "How do Raft and Paxos consensus algorithms compare in Golang?",
	}

	titleStream, err := user.GenerateTitle(t.Context(), body)
	if err != nil {
		t.Fatalf("GenerateTitle: %v", err)
	}
	defer titleStream.Close()

	turn, err := titleStream.Collect()
	if err != nil {
		t.Fatalf("titleStream.Collect: %v", err)
	}

	if len(turn.Text) == 0 {
		t.Errorf("expected non-empty generated title, got %q", turn.Text)
	}
}
