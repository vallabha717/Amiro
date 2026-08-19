package chat_test

import (
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestMultiTurn_ThreadStatePersistsAndResumes verifies that conversation history persists across turns.
func TestMultiTurn_ThreadStatePersistsAndResumes(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	threadID := "thread-multiturn-1"

	// Turn 1
	h.Fake().OnPrompt(fakeprovider.Contains("favorite color is navy blue")).StreamText("Noted that your favorite color is navy blue.")
	req1 := apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-1", "My favorite color is navy blue"),
	}
	turn1, err := user.ChatTurn(t.Context(), req1)
	if err != nil {
		t.Fatalf("Turn 1 failed: %v", err)
	}
	if !strings.Contains(turn1.Text, "navy blue") {
		t.Errorf("turn 1 unexpected text: %s", turn1.Text)
	}

	// Turn 2
	h.Fake().OnPrompt(fakeprovider.Contains("What is my favorite color")).StreamText("Your favorite color is navy blue.")
	req2 := apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-2", "What is my favorite color?"),
	}
	turn2, err := user.ChatTurn(t.Context(), req2)
	if err != nil {
		t.Fatalf("Turn 2 failed: %v", err)
	}
	if !strings.Contains(turn2.Text, "navy blue") {
		t.Errorf("turn 2 unexpected text: %s", turn2.Text)
	}

	// Verify thread is persisted in DB
	thread, err := user.GetThread(t.Context(), threadID)
	if err != nil {
		t.Fatalf("GetThread: %v", err)
	}
	if thread.ID != threadID {
		t.Errorf("expected thread ID %s, got %s", threadID, thread.ID)
	}
}

// TestMultiTurn_TruncateRebuildsContext verifies truncating messages in a thread rebuilds context cleanly.
func TestMultiTurn_TruncateRebuildsContext(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	threadID := "thread-multiturn-trunc-1"

	h.Fake().OnPrompt(fakeprovider.Any()).StreamText("Response message")

	// Create 3 turns
	for i := 1; i <= 3; i++ {
		req := apiclient.ChatRequest{
			ID:      threadID,
			Message: apiclient.TextMessage("msg-turn", "message step"),
		}
		_, err := user.ChatTurn(t.Context(), req)
		if err != nil {
			t.Fatalf("turn %d failed: %v", i, err)
		}
	}

	// Fetch thread to get message ID
	thr, err := user.GetThread(t.Context(), threadID)
	if err != nil || len(thr.Messages) == 0 {
		t.Fatalf("expected messages in thread: %v", err)
	}

	// Truncate from second message
	if len(thr.Messages) >= 2 {
		if err := user.TruncateFrom(t.Context(), thr.Messages[1].ID); err != nil {
			t.Fatalf("TruncateFrom: %v", err)
		}
	}

	// Follow-up turn succeeds
	reqNext := apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-after-trunc", "message after truncation"),
	}
	turnNext, err := user.ChatTurn(t.Context(), reqNext)
	if err != nil {
		t.Fatalf("turn after truncation failed: %v", err)
	}
	if turnNext.Text == "" {
		t.Errorf("expected non-empty response after truncation")
	}
}
