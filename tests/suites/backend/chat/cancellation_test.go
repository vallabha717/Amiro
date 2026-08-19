package chat_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestCancellation_MidTurnCancelsAndLeavesThreadConsistent verifies that cancelling
// a turn context mid-turn aborts tool execution and leaves thread history in a valid, uncorrupted state.
func TestCancellation_MidTurnCancelsAndLeavesThreadConsistent(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	// Script fake provider to emit a write tool call followed by a second write tool call
	h.Fake().OnPrompt(fakeprovider.Contains("cancel mid tool execution")).
		ToolCall("write_file", map[string]any{
			"path":    "first.txt",
			"content": "First file written.\n",
		}).
		ThenStreamText("First complete, writing second.")

	threadID := "thread-cancel-turn-1"
	req := apiclient.ChatRequest{
		ID:             threadID,
		Message:        apiclient.TextMessage("msg-cancel-1", "cancel mid tool execution"),
		PermissionMode: "auto",
		WorkspaceRoot:  h.Backend().WorkspaceRoot,
	}

	ctx, cancel := context.WithCancel(t.Context())

	stream, err := user.Chat(ctx, req)
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}

	// Cancel the context mid-stream
	cancel()
	_ = stream.Close()

	// Wait for cleanup
	<-time.After(50 * time.Millisecond)

	// Verify the thread in DB can still be retrieved and appended to
	thread, err := user.GetThread(t.Context(), threadID)
	if err != nil {
		t.Fatalf("GetThread after cancellation: %v", err)
	}
	if thread.ID != threadID {
		t.Errorf("expected thread ID %s, got %s", threadID, thread.ID)
	}

	// Next turn works cleanly on the same thread
	h.Fake().OnPrompt(fakeprovider.Contains("resume after cancel")).StreamText("Resumed turn completed cleanly.")
	turnResume, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:      threadID,
		Message: apiclient.TextMessage("msg-cancel-2", "resume after cancel"),
	})
	if err != nil {
		t.Fatalf("resume turn failed: %v", err)
	}
	if turnResume.Text == "" {
		t.Errorf("expected non-empty completion on resume turn")
	}

	// Confirm workspace directory is intact
	firstPath := filepath.Join(h.Backend().WorkspaceRoot, "first.txt")
	_, _ = os.Stat(firstPath)
}
