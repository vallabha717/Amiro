package session

import (
	"encoding/json"
	"testing"

	"amiro/backend/internal/ai/uimessage"
)

// approvalFrame builds the exact data-tool-approval frame
// tool_scheduler.go's suspendForApproval writes, so this test exercises the
// real wire shape rather than a shape convenient for the test.
func approvalFrame(toolCallID, toolName, risk, reason, command string, compound bool) uimessage.Frame {
	data := map[string]any{"toolCallId": toolCallID, "toolName": toolName, "risk": risk, "reason": reason}
	if command != "" {
		data["command"] = command
		data["compound"] = compound
	}
	raw, _ := json.Marshal(data)
	return uimessage.Frame{Type: uimessage.DataFrameType(approvalDataPart), ID: toolCallID, Data: raw}
}

// suspendedTurnFrames is one turn that calls run_shell and pauses for
// approval -- FrameFinish/FrameDone still arrive (RunTurn always writes
// them, paused or not), so Streaming goes false the same as a completed
// turn.
var suspendedTurnFrames = []uimessage.Frame{
	{Type: uimessage.FrameStart, MessageID: "asst-1"},
	{Type: uimessage.FrameStartStep},
	{Type: uimessage.FrameTextStart, ID: "t1"},
	{Type: uimessage.FrameTextDelta, ID: "t1", Delta: "I'll run the tests."},
	{Type: uimessage.FrameTextEnd, ID: "t1"},
	{Type: uimessage.FrameToolInputStart, ToolCallID: "call-1", ToolName: "run_shell"},
	{Type: uimessage.FrameToolInputAvailable, ToolCallID: "call-1", ToolName: "run_shell", Input: []byte(`{"command":"go test ./..."}`)},
	approvalFrame("call-1", "run_shell", "exec", "run_shell needs approval", "go test ./...", false),
	{Type: uimessage.FrameFinishStep},
	{Type: uimessage.FrameFinish, MessageMetadata: []byte(`{"usage":{"PromptTokens":10,"CompletionTokens":5,"TotalTokens":15},"durationMs":500}`)},
	{Type: uimessage.FrameDone},
}

func newSuspendedState(t *testing.T) *State {
	t.Helper()
	s := New("thread-1")
	s.SendUserMessage("user-1", "run the tests")
	for _, f := range suspendedTurnFrames {
		s.Reduce(f)
	}
	return s
}

// TestReduce_ApprovalFrame_MarksCallAwaitingAndSetsPending is the Phase 3
// TUI gate's approval-frame reduce coverage: the exact frame
// suspendForApproval emits turns into a PendingApproval and marks the tool
// call, rather than silently vanishing the way an unhandled data frame does
// today for compaction markers.
func TestReduce_ApprovalFrame_MarksCallAwaitingAndSetsPending(t *testing.T) {
	s := newSuspendedState(t)

	if s.Streaming {
		t.Fatalf("Streaming = true after FrameDone, want false (a paused turn still finishes the stream)")
	}
	if s.PendingApproval == nil {
		t.Fatalf("PendingApproval = nil, want the suspended call's request")
	}
	if s.PendingApproval.ToolCallID != "call-1" || s.PendingApproval.Command != "go test ./..." {
		t.Fatalf("PendingApproval = %+v, want ToolCallID=call-1, Command=%q", s.PendingApproval, "go test ./...")
	}

	asst := s.Messages[1]
	if asst.Role != RoleAssistant || len(asst.Parts) != 2 {
		t.Fatalf("assistant message = %+v, want 2 parts (text, tool)", asst)
	}
	tc := asst.Parts[1].Tool
	if tc == nil || tc.Status != ToolAwaitingApproval {
		t.Fatalf("tool call = %+v, want Status=ToolAwaitingApproval", tc)
	}
	if tc.Approval != s.PendingApproval {
		t.Fatalf("tool call's Approval does not point at State.PendingApproval")
	}
}

// TestReduce_FrameStart_ContinuationReusesTheSameMessage is the fix for a
// real bug this phase's own work found: a continuation (an approval
// answered, or any resumed turn) starts with the *same* message id RunTurn
// minted before it paused. Appending a fresh Message on that FrameStart
// would split one turn into two transcript rows and orphan the already-
// rendered awaiting-approval tool call in the first one.
func TestReduce_FrameStart_ContinuationReusesTheSameMessage(t *testing.T) {
	s := newSuspendedState(t)
	before := len(s.Messages)

	// The continuation: same MessageID as the paused turn, a new step
	// answering with the model's next reply.
	s.Reduce(uimessage.Frame{Type: uimessage.FrameStart, MessageID: "asst-1"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameStartStep})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameTextStart, ID: "t2"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameTextDelta, ID: "t2", Delta: " Done."})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameTextEnd, ID: "t2"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameFinishStep})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameFinish})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameDone})

	if got := len(s.Messages); got != before {
		t.Fatalf("len(Messages) = %d after a continuation, want %d (no new row)", got, before)
	}
	asst := s.Messages[before-1]
	if len(asst.Parts) != 3 {
		t.Fatalf("continued message has %d parts, want 3 (original text, tool, new text)", len(asst.Parts))
	}
	if asst.Parts[2].Kind != PartText || asst.Parts[2].Text != " Done." {
		t.Fatalf("Parts[2] = %+v, want the continuation's new text appended after the paused tool call", asst.Parts[2])
	}
}

// TestBuildApprovalResubmission_ApprovedOnce covers the shape RunTurn's
// "continuing" branch requires: a full wire-parts array for the message so
// far, with the answered call's output set to the exact approvalAnswerWire
// bytes approvals.go's parseApprovalAnswer looks for, and every other part
// (the leading text) carried over untouched.
func TestBuildApprovalResubmission_ApprovedOnce(t *testing.T) {
	s := newSuspendedState(t)

	id, parts, ok := s.BuildApprovalResubmission(true, "once")
	if !ok {
		t.Fatalf("BuildApprovalResubmission ok = false, want true")
	}
	if id != "asst-1" {
		t.Fatalf("messageID = %q, want asst-1 (the paused message's own id)", id)
	}
	if len(parts) != 3 {
		t.Fatalf("len(parts) = %d, want 3 (text, tool-run_shell, data-tool-approval)", len(parts))
	}

	var textPart struct{ Type, Text string }
	if err := json.Unmarshal(parts[0], &textPart); err != nil || textPart.Type != "text" || textPart.Text != "I'll run the tests." {
		t.Fatalf("parts[0] = %s, want the original text part unchanged", parts[0])
	}

	var toolPart struct {
		Type       string          `json:"type"`
		ToolCallID string          `json:"toolCallId"`
		State      string          `json:"state"`
		Output     json.RawMessage `json:"output"`
	}
	if err := json.Unmarshal(parts[1], &toolPart); err != nil {
		t.Fatalf("parts[1] did not decode: %v", err)
	}
	if toolPart.Type != "tool-run_shell" || toolPart.ToolCallID != "call-1" {
		t.Fatalf("parts[1] = %+v, want type=tool-run_shell toolCallId=call-1", toolPart)
	}
	var answer struct {
		Tag     string `json:"__tag"`
		Confirm bool   `json:"confirm"`
		Scope   string `json:"scope"`
	}
	if err := json.Unmarshal(toolPart.Output, &answer); err != nil {
		t.Fatalf("parts[1].output did not decode: %v", err)
	}
	if answer.Tag != "manual-tool-confirm" || !answer.Confirm || answer.Scope != "once" {
		t.Fatalf("answer = %+v, want {__tag:manual-tool-confirm confirm:true scope:once} -- exactly what approvals.go's parseApprovalAnswer requires", answer)
	}

	var dataPart struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if err := json.Unmarshal(parts[2], &dataPart); err != nil || dataPart.Type != "data-tool-approval" || dataPart.ID != "call-1" {
		t.Fatalf("parts[2] = %s, want the approval-request data part echoed back verbatim", parts[2])
	}

	// State updates locally too: the dialog closes and the card no longer
	// reads "awaiting approval".
	if s.PendingApproval != nil {
		t.Fatalf("PendingApproval still set after answering")
	}
	tc := s.Messages[1].Parts[1].Tool
	if tc.Status != ToolDone {
		t.Fatalf("tool call Status = %v after approval, want ToolDone", tc.Status)
	}
}

// TestBuildApprovalResubmission_Denied covers the deny path -- confirm:false
// and no scope, and the local status reads as an error the same way a real
// server-side denial reads to the model.
func TestBuildApprovalResubmission_Denied(t *testing.T) {
	s := newSuspendedState(t)

	_, parts, ok := s.BuildApprovalResubmission(false, "")
	if !ok {
		t.Fatalf("ok = false, want true")
	}
	var toolPart struct {
		Output json.RawMessage `json:"output"`
	}
	_ = json.Unmarshal(parts[1], &toolPart)
	var answer struct {
		Confirm bool   `json:"confirm"`
		Scope   string `json:"scope"`
	}
	_ = json.Unmarshal(toolPart.Output, &answer)
	if answer.Confirm {
		t.Fatalf("confirm = true, want false for a denial")
	}
	if answer.Scope != "" {
		t.Fatalf("scope = %q, want empty (omitempty) for a one-time denial", answer.Scope)
	}

	tc := s.Messages[1].Parts[1].Tool
	if tc.Status != ToolError || tc.ErrorText == "" {
		t.Fatalf("tool call = %+v, want Status=ToolError with a non-empty message", tc)
	}
}

// TestBuildApprovalResubmission_NoPendingApproval covers the guard: nothing
// to answer means ok=false, not a panic or an empty-but-successful result.
func TestBuildApprovalResubmission_NoPendingApproval(t *testing.T) {
	s := New("thread-1")
	s.SendUserMessage("user-1", "hi")
	if _, _, ok := s.BuildApprovalResubmission(true, "once"); ok {
		t.Fatalf("ok = true with no PendingApproval, want false")
	}
}
