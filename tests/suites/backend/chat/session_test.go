package chat_test

import (
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestSession_LogsStepHistoryAndToolActions verifies that internal/agent/session
// and chat turn execution accurately log every step (messages, tool calls, tool results).
func TestSession_LogsStepHistoryAndToolActions(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	h.Fake().OnPrompt(fakeprovider.Contains("inspect workspace")).
		ToolCall("list_dir", map[string]any{"path": "."}).
		ThenStreamText("The workspace contains initialized files.")

	threadID := "thread-session-log-1"
	req := apiclient.ChatRequest{
		ID:             threadID,
		Message:        apiclient.TextMessage("msg-sess-1", "please inspect workspace"),
		PermissionMode: "auto",
		WorkspaceRoot:  h.Backend().WorkspaceRoot,
	}

	turn, err := user.ChatTurn(t.Context(), req)
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	if !strings.Contains(turn.Text, "contains initialized files") {
		t.Errorf("expected completion text, got %q", turn.Text)
	}

	// Verify frames logged all expected types across step progression
	var hasStart, hasToolCall, hasToolResult, hasFinish bool
	for _, f := range turn.Frames {
		switch f.Type {
		case apiclient.FrameStart:
			hasStart = true
		case apiclient.FrameToolInputAvailable:
			hasToolCall = true
		case apiclient.FrameToolOutputAvailable:
			hasToolResult = true
		case apiclient.FrameFinish:
			hasFinish = true
		}
	}

	if !hasStart || !hasToolCall || !hasToolResult || !hasFinish {
		t.Errorf("missing expected session step frames: start=%v, toolCall=%v, toolResult=%v, finish=%v",
			hasStart, hasToolCall, hasToolResult, hasFinish)
	}

	// Check thread retrieval to ensure session turn state is persisted
	thread, err := user.GetThread(t.Context(), threadID)
	if err != nil {
		t.Fatalf("GetThread: %v", err)
	}
	if thread.ID != threadID {
		t.Errorf("expected thread ID %s, got %s", threadID, thread.ID)
	}
}
