package session

import (
	"testing"

	"amiro/backend/internal/ai/uimessage"
)

// TestReduce_StreamingTextAccumulatesInOrder is the Phase 1 TUI gate's
// "streaming-text reduce test" (docs/tui-implementation-plan.md Part 5):
// proof that a Frame sequence like the one RunTurn actually emits
// (TestRunTurn_StreamFramesGolden in internal/api/chat) turns into growing
// text on one message, not a new message per delta and not lost deltas.
func TestReduce_StreamingTextAccumulatesInOrder(t *testing.T) {
	s := New("thread-1")
	s.SendUserMessage("user-msg-1", "how many files are in this repo?")

	frames := []uimessage.Frame{
		{Type: uimessage.FrameStart, MessageID: "asst-1"},
		{Type: uimessage.FrameStartStep},
		{Type: uimessage.FrameTextStart, ID: "text-1"},
		{Type: uimessage.FrameTextDelta, ID: "text-1", Delta: "Let "},
		{Type: uimessage.FrameTextDelta, ID: "text-1", Delta: "me "},
		{Type: uimessage.FrameTextDelta, ID: "text-1", Delta: "check."},
		{Type: uimessage.FrameTextEnd, ID: "text-1"},
		{Type: uimessage.FrameFinishStep},
		{Type: uimessage.FrameFinish},
		{Type: uimessage.FrameDone},
	}

	if !s.Streaming {
		t.Fatalf("Streaming = false after SendUserMessage, want true")
	}

	for _, f := range frames {
		s.Reduce(f)
	}

	if s.Streaming {
		t.Fatalf("Streaming = true after FrameDone, want false")
	}
	if len(s.Messages) != 2 {
		t.Fatalf("len(Messages) = %d, want 2 (user + assistant)", len(s.Messages))
	}
	if got := s.Messages[0]; got.Role != RoleUser || got.Text() != "how many files are in this repo?" {
		t.Fatalf("Messages[0] = %+v, want the user's message unchanged", got)
	}
	want := "Let me check."
	if got := s.Messages[1]; got.Role != RoleAssistant || got.ID != "asst-1" || got.Text() != want {
		t.Fatalf("Messages[1] = %+v, want {ID: asst-1, Role: assistant, Text: %q}", got, want)
	}
	if s.Err != nil {
		t.Fatalf("Err = %v, want nil", s.Err)
	}
}

// TestReduce_MultiStepToolTurnKeepsTextOnOneMessage guards against the
// exact bug RunTurn's own doc comment describes for the browser side: a
// turn that pauses mid-stream (a tool call between two text spans) must
// still read back as one assistant message, not a new bubble per step --
// and Phase 2 extends the assertion to the tool call itself: it must land
// as its own Part, in order, fully resolved.
func TestReduce_MultiStepToolTurnKeepsTextOnOneMessage(t *testing.T) {
	s := New("thread-1")
	s.SendUserMessage("user-msg-1", "list the go files")

	frames := []uimessage.Frame{
		{Type: uimessage.FrameStart, MessageID: "asst-1"},
		{Type: uimessage.FrameStartStep},
		{Type: uimessage.FrameToolInputStart, ToolCallID: "call-1", ToolName: "list_dir"},
		{Type: uimessage.FrameToolInputAvailable, ToolCallID: "call-1", ToolName: "list_dir", Input: []byte(`{"path":"."}`)},
		{Type: uimessage.FrameToolOutputAvailable, ToolCallID: "call-1", Output: []byte(`{"file_count":3}`)},
		{Type: uimessage.FrameFinishStep},
		{Type: uimessage.FrameStartStep},
		{Type: uimessage.FrameTextStart, ID: "text-1"},
		{Type: uimessage.FrameTextDelta, ID: "text-1", Delta: "Found 3 files."},
		{Type: uimessage.FrameTextEnd, ID: "text-1"},
		{Type: uimessage.FrameFinishStep},
		{Type: uimessage.FrameFinish},
		{Type: uimessage.FrameDone},
	}
	for _, f := range frames {
		s.Reduce(f)
	}

	if len(s.Messages) != 2 {
		t.Fatalf("len(Messages) = %d, want 2 -- a tool step must not start a new message", len(s.Messages))
	}
	msg := s.Messages[1]
	if got, want := msg.Text(), "Found 3 files."; got != want {
		t.Fatalf("Messages[1].Text() = %q, want %q", got, want)
	}
	if len(msg.Parts) != 2 {
		t.Fatalf("len(Parts) = %d, want 2 (tool, then text)", len(msg.Parts))
	}
	tool := msg.Parts[0]
	if tool.Kind != PartTool || tool.Tool == nil {
		t.Fatalf("Parts[0] = %+v, want a PartTool", tool)
	}
	if tool.Tool.Name != "list_dir" || tool.Tool.Status != ToolDone {
		t.Fatalf("Parts[0].Tool = %+v, want {Name: list_dir, Status: done}", tool.Tool)
	}
	if string(tool.Tool.Input) != `{"path":"."}` {
		t.Fatalf("Parts[0].Tool.Input = %s, want the tool-input-available payload", tool.Tool.Input)
	}
	if msg.Parts[1].Kind != PartText {
		t.Fatalf("Parts[1].Kind = %v, want PartText", msg.Parts[1].Kind)
	}
}

// TestReduce_ReasoningIsItsOwnPart proves reasoning deltas accumulate on a
// PartReasoning distinct from any surrounding text, in the order the model
// produced them -- the same interleaving guarantee the tool-call test above
// checks, for the other kind of non-text part.
func TestReduce_ReasoningIsItsOwnPart(t *testing.T) {
	s := New("thread-1")
	s.SendUserMessage("user-msg-1", "why is the sky blue?")

	frames := []uimessage.Frame{
		{Type: uimessage.FrameStart, MessageID: "asst-1"},
		{Type: uimessage.FrameReasoningStart, ID: "r1"},
		{Type: uimessage.FrameReasoningDelta, ID: "r1", Delta: "Rayleigh "},
		{Type: uimessage.FrameReasoningDelta, ID: "r1", Delta: "scattering."},
		{Type: uimessage.FrameReasoningEnd, ID: "r1"},
		{Type: uimessage.FrameTextStart, ID: "t1"},
		{Type: uimessage.FrameTextDelta, ID: "t1", Delta: "Rayleigh scattering."},
		{Type: uimessage.FrameTextEnd, ID: "t1"},
		{Type: uimessage.FrameFinish},
		{Type: uimessage.FrameDone},
	}
	for _, f := range frames {
		s.Reduce(f)
	}

	msg := s.Messages[1]
	if len(msg.Parts) != 2 {
		t.Fatalf("len(Parts) = %d, want 2 (reasoning, then text)", len(msg.Parts))
	}
	if msg.Parts[0].Kind != PartReasoning || msg.Parts[0].Text != "Rayleigh scattering." {
		t.Fatalf("Parts[0] = %+v, want the accumulated reasoning text", msg.Parts[0])
	}
	if msg.Parts[1].Kind != PartText {
		t.Fatalf("Parts[1].Kind = %v, want PartText", msg.Parts[1].Kind)
	}
	// Text() only ever returns text parts -- reasoning is not "what was
	// said", and a caller that wants just the reply must not see it twice.
	if got, want := msg.Text(), "Rayleigh scattering."; got != want {
		t.Fatalf("Text() = %q, want %q (reasoning excluded)", got, want)
	}
}

// TestReduce_ToolOutputErrorMarksTheCallFailed proves a tool that errors
// (not the turn -- the specific call) is distinguishable from one that
// succeeded, which is what tells a toolcard renderer to show a red border
// instead of a result.
func TestReduce_ToolOutputErrorMarksTheCallFailed(t *testing.T) {
	s := New("thread-1")
	s.SendUserMessage("user-msg-1", "run the build")

	s.Reduce(uimessage.Frame{Type: uimessage.FrameStart, MessageID: "asst-1"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameToolInputStart, ToolCallID: "call-1", ToolName: "run_shell"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameToolInputAvailable, ToolCallID: "call-1", ToolName: "run_shell"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameToolOutputError, ToolCallID: "call-1", ErrorText: "permission denied"})

	tool := s.Messages[1].Parts[0].Tool
	if tool.Status != ToolError {
		t.Fatalf("Status = %v, want error", tool.Status)
	}
	if tool.ErrorText != "permission denied" {
		t.Fatalf("ErrorText = %q, want %q", tool.ErrorText, "permission denied")
	}
}

// TestState_Interrupted_MarksAnyPendingToolCallInterrupted is the Phase 2
// TUI gate's "interrupt-mid-tool test": Ctrl+C during a tool call that
// never got a result must not leave the card showing "running" forever --
// abandonPendingTools is what state.go's Interrupted calls to fix that.
func TestState_Interrupted_MarksAnyPendingToolCallInterrupted(t *testing.T) {
	s := New("thread-1")
	s.SendUserMessage("user-msg-1", "run the tests")
	s.Reduce(uimessage.Frame{Type: uimessage.FrameStart, MessageID: "asst-1"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameToolInputStart, ToolCallID: "call-1", ToolName: "run_shell"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameToolInputAvailable, ToolCallID: "call-1", ToolName: "run_shell", Input: []byte(`{"command":"go test ./..."}`)})
	// No ToolOutputAvailable/-Error ever arrives -- the connection is about
	// to be interrupted mid-command.

	s.Interrupted()

	tool := s.Messages[1].Parts[0].Tool
	if tool.Status != ToolInterrupted {
		t.Fatalf("Status = %v, want interrupted", tool.Status)
	}
	if s.Streaming {
		t.Fatalf("Streaming = true after Interrupted, want false")
	}
	if s.Err != nil {
		t.Fatalf("Err = %v, want nil -- an interrupt is not a failure", s.Err)
	}
}

// TestState_Interrupted_LeavesACompletedToolCallAlone is
// abandonPendingTools' other half: a tool that already finished before the
// interrupt must keep its real status, not get overwritten to
// "interrupted" just because it happened to be the most recent call.
func TestState_Interrupted_LeavesACompletedToolCallAlone(t *testing.T) {
	s := New("thread-1")
	s.SendUserMessage("user-msg-1", "read the readme")
	s.Reduce(uimessage.Frame{Type: uimessage.FrameStart, MessageID: "asst-1"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameToolInputStart, ToolCallID: "call-1", ToolName: "read_file"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameToolInputAvailable, ToolCallID: "call-1", ToolName: "read_file"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameToolOutputAvailable, ToolCallID: "call-1", Output: []byte(`{"total_lines":10}`)})
	// The model is still composing its reply when the interrupt lands.

	s.Interrupted()

	tool := s.Messages[1].Parts[0].Tool
	if tool.Status != ToolDone {
		t.Fatalf("Status = %v, want done -- a finished call must not be relabeled by an interrupt", tool.Status)
	}
}

func TestState_Interrupted_StopsStreamingWithoutError(t *testing.T) {
	s := New("thread-1")
	s.SendUserMessage("user-msg-1", "run the tests")
	s.Reduce(uimessage.Frame{Type: uimessage.FrameStart, MessageID: "asst-1"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameTextStart, ID: "text-1"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameTextDelta, ID: "text-1", Delta: "Running"})

	s.Interrupted()

	if s.Streaming {
		t.Fatalf("Streaming = true after Interrupted, want false")
	}
	if s.Err != nil {
		t.Fatalf("Err = %v, want nil -- an interrupt is not a failure", s.Err)
	}
	if got, want := s.Messages[1].Text(), "Running"; got != want {
		t.Fatalf("Messages[1].Text() = %q, want %q -- interrupt must not truncate what already streamed", got, want)
	}
}

func TestState_Failed_RecordsErrAndStopsStreaming(t *testing.T) {
	s := New("thread-1")
	s.SendUserMessage("user-msg-1", "hi")

	s.Failed(errTransport)

	if s.Streaming {
		t.Fatalf("Streaming = true after Failed, want false")
	}
	if s.Err != errTransport {
		t.Fatalf("Err = %v, want %v", s.Err, errTransport)
	}
}

// TestReduce_TodoWriteUpdatesTheLivePlan proves a todo_write call's output
// lands on State.Todos (the panel's data source), independent of the
// transcript -- and that a later call replaces the list wholesale rather
// than appending to it, matching the tool's own "the whole plan, every
// call" contract (internal/ai/tools.TodoList).
func TestReduce_TodoWriteUpdatesTheLivePlan(t *testing.T) {
	s := New("thread-1")
	s.SendUserMessage("user-msg-1", "fix the bug and add a test")
	s.Reduce(uimessage.Frame{Type: uimessage.FrameStart, MessageID: "asst-1"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameToolInputStart, ToolCallID: "call-1", ToolName: "todo_write"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameToolInputAvailable, ToolCallID: "call-1", ToolName: "todo_write"})
	s.Reduce(uimessage.Frame{
		Type:       uimessage.FrameToolOutputAvailable,
		ToolCallID: "call-1",
		Output:     []byte(`{"items":[{"content":"fix the bug","status":"in_progress"},{"content":"add a test","status":"pending"}],"done":0,"in_progress":1,"pending":1}`),
	})

	if len(s.Todos) != 2 {
		t.Fatalf("len(Todos) = %d, want 2", len(s.Todos))
	}
	if s.Todos[0].Status != TodoInProgress || s.Todos[1].Status != TodoPending {
		t.Fatalf("Todos = %+v, want [in_progress, pending]", s.Todos)
	}

	// A second call replaces, not appends.
	s.Reduce(uimessage.Frame{Type: uimessage.FrameToolInputStart, ToolCallID: "call-2", ToolName: "todo_write"})
	s.Reduce(uimessage.Frame{Type: uimessage.FrameToolInputAvailable, ToolCallID: "call-2", ToolName: "todo_write"})
	s.Reduce(uimessage.Frame{
		Type:       uimessage.FrameToolOutputAvailable,
		ToolCallID: "call-2",
		Output:     []byte(`{"items":[{"content":"fix the bug","status":"done"},{"content":"add a test","status":"in_progress"}]}`),
	})
	if len(s.Todos) != 2 || s.Todos[0].Status != TodoDone {
		t.Fatalf("Todos after second write = %+v, want the plan replaced, not appended", s.Todos)
	}
}

// TestReduce_FinishMetadataPopulatesModelUsageAndDuration is what the
// status bar reads (component/status/bar.go's Info): model, usage and
// duration only exist once the Finish frame's messageMetadata decodes.
func TestReduce_FinishMetadataPopulatesModelUsageAndDuration(t *testing.T) {
	s := New("thread-1")
	s.SendUserMessage("user-msg-1", "hi")
	s.Reduce(uimessage.Frame{Type: uimessage.FrameStart, MessageID: "asst-1"})

	if s.Usage != nil || s.Model != "" {
		t.Fatalf("Usage/Model set before Finish: Usage=%+v Model=%q", s.Usage, s.Model)
	}

	s.Reduce(uimessage.Frame{
		Type: uimessage.FrameFinish,
		MessageMetadata: []byte(
			`{"usage":{"PromptTokens":120,"CompletionTokens":40,"TotalTokens":160},"chatModel":{"provider":"anthropic","model":"claude-sonnet-5"},"durationMs":2500}`,
		),
	})

	if s.Usage == nil || s.Usage.TotalTokens != 160 {
		t.Fatalf("Usage = %+v, want TotalTokens 160", s.Usage)
	}
	if s.Model != "anthropic/claude-sonnet-5" {
		t.Fatalf("Model = %q, want %q", s.Model, "anthropic/claude-sonnet-5")
	}
	if s.DurationMS != 2500 {
		t.Fatalf("DurationMS = %d, want 2500", s.DurationMS)
	}
}

var errTransport = textError("connection reset")
