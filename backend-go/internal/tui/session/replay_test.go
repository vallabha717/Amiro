package session

import (
	"encoding/json"
	"testing"
)

// TestReplayThread_DecodesTextReasoningAndToolParts is the round trip that
// matters for the thread switcher's resume path: persisted parts.go-shaped
// JSON, decoded back into the same Message/Part shape live streaming
// produces, so page.Chat's existing renderer draws a resumed thread with no
// second code path.
func TestReplayThread_DecodesTextReasoningAndToolParts(t *testing.T) {
	messages := []PersistedMessage{
		{ID: "user-1", Role: "user", Parts: rawParts(`{"type":"text","text":"read state.go and summarize it"}`)},
		{
			ID:   "asst-1",
			Role: "assistant",
			Parts: rawParts(
				`{"type":"reasoning","text":"I'll read the file first."}`,
				`{"type":"tool-read_file","toolCallId":"call-1","input":{"path":"state.go"},"state":"output-available","output":{"total_lines":120}}`,
				`{"type":"text","text":"It defines the State type."}`,
			),
			Metadata: []byte(`{"usage":{"PromptTokens":100,"CompletionTokens":20,"TotalTokens":120},"chatModel":{"provider":"anthropic","model":"claude-sonnet-5"},"durationMs":2000}`),
		},
	}

	s := ReplayThread("thread-1", messages)

	if len(s.Messages) != 2 {
		t.Fatalf("len(Messages) = %d, want 2", len(s.Messages))
	}
	if got := s.Messages[0]; got.Role != RoleUser || got.Text() != "read state.go and summarize it" {
		t.Fatalf("Messages[0] = %+v, want the user's text", got)
	}

	asst := s.Messages[1]
	if len(asst.Parts) != 3 {
		t.Fatalf("assistant Parts = %d, want 3 (reasoning, tool, text)", len(asst.Parts))
	}
	if asst.Parts[0].Kind != PartReasoning || asst.Parts[0].Text != "I'll read the file first." {
		t.Fatalf("Parts[0] = %+v, want the reasoning part", asst.Parts[0])
	}
	tc := asst.Parts[1].Tool
	if tc == nil || tc.Name != "read_file" || tc.Status != ToolDone || string(tc.Output) != `{"total_lines":120}` {
		t.Fatalf("Parts[1].Tool = %+v, want a done read_file call with its output", tc)
	}
	if asst.Parts[2].Kind != PartText || asst.Parts[2].Text != "It defines the State type." {
		t.Fatalf("Parts[2] = %+v, want the closing text", asst.Parts[2])
	}

	if s.Model != "anthropic/claude-sonnet-5" || s.Usage == nil || s.Usage.TotalTokens != 120 || s.DurationMS != 2000 {
		t.Fatalf("metadata = model=%q usage=%+v duration=%d, want the assistant message's own metadata replayed", s.Model, s.Usage, s.DurationMS)
	}
	if s.PendingApproval != nil {
		t.Fatalf("PendingApproval = %+v, want nil -- nothing in this thread is still suspended", s.PendingApproval)
	}
}

// TestReplayThread_StillSuspendedTurnReopensTheDialog covers resuming a
// thread whose last turn is still waiting on a human: the same
// data-tool-approval part that would open the dialog live must open it on
// resume too, not silently strand the call.
func TestReplayThread_StillSuspendedTurnReopensTheDialog(t *testing.T) {
	messages := []PersistedMessage{
		{ID: "user-1", Role: "user", Parts: rawParts(`{"type":"text","text":"run the tests"}`)},
		{
			ID:   "asst-1",
			Role: "assistant",
			Parts: rawParts(
				`{"type":"tool-run_shell","toolCallId":"call-1","input":{"command":"go test ./..."},"state":"input-available"}`,
				`{"type":"data-tool-approval","id":"call-1","data":{"toolCallId":"call-1","toolName":"run_shell","risk":"exec","reason":"needs approval","command":"go test ./...","compound":false}}`,
			),
		},
	}

	s := ReplayThread("thread-1", messages)

	if s.PendingApproval == nil {
		t.Fatalf("PendingApproval = nil, want the still-suspended call's request")
	}
	if s.PendingApproval.ToolCallID != "call-1" || s.PendingApproval.Command != "go test ./..." {
		t.Fatalf("PendingApproval = %+v, want ToolCallID=call-1 Command=%q", s.PendingApproval, "go test ./...")
	}
	tc := s.Messages[1].Parts[0].Tool
	if tc.Status != ToolAwaitingApproval {
		t.Fatalf("tool call Status = %v, want ToolAwaitingApproval", tc.Status)
	}

	// A resumed, still-suspended turn must be answerable exactly like a live
	// one -- BuildApprovalResubmission needs s.current pointed at this
	// message.
	id, parts, ok := s.BuildApprovalResubmission(true, "once")
	if !ok || id != "asst-1" || len(parts) != 2 {
		t.Fatalf("BuildApprovalResubmission after resume = id=%q parts=%d ok=%v, want asst-1, 2 parts, true", id, len(parts), ok)
	}
}

// TestReplayThread_ADoneTurnDoesNotReopenTheDialog guards the other
// direction: a tool call left at "input-available" with no
// data-tool-approval part (some other reason a turn was cut off) must not
// be mistaken for one awaiting a human -- there is no live turn to answer
// for it, so no dialog should open just because the thread was reopened.
func TestReplayThread_ADoneTurnDoesNotReopenTheDialog(t *testing.T) {
	messages := []PersistedMessage{
		{ID: "user-1", Role: "user", Parts: rawParts(`{"type":"text","text":"hi"}`)},
		{
			ID:    "asst-1",
			Role:  "assistant",
			Parts: rawParts(`{"type":"tool-read_file","toolCallId":"call-1","input":{"path":"a.go"},"state":"input-available"}`),
		},
	}

	s := ReplayThread("thread-1", messages)

	if s.PendingApproval != nil {
		t.Fatalf("PendingApproval = %+v, want nil for a call with no approval data part", s.PendingApproval)
	}
	tc := s.Messages[1].Parts[0].Tool
	if tc.Status != ToolPending {
		t.Fatalf("tool call Status = %v, want ToolPending", tc.Status)
	}
}

func rawParts(parts ...string) []json.RawMessage {
	out := make([]json.RawMessage, len(parts))
	for i, p := range parts {
		out[i] = json.RawMessage(p)
	}
	return out
}
