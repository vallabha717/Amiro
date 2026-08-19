package session

import (
	"encoding/json"

	"amiro/backend/internal/ai/uimessage"
)

// textError adapts a plain string into an error, for FrameError's
// ErrorText -- the frame carries text, not a wrapped error chain, and
// nothing here needs more than Error() to display it.
type textError string

func (e textError) Error() string { return string(e) }

// This package decodes tool output through its own small mirrored structs
// (below and in toolcard's renderers) instead of importing
// internal/ai/tools: that package pulls in agent/lsp, agent/memory,
// agent/workspace and db/repository -- real backend internals with real
// weight -- into a binary whose entire architectural point (plan §2.2) is
// being a thin client that knows nothing about the server's insides beyond
// the wire protocol. internal/tui/client/http.go already sets this
// precedent for the request side (wireMessage/chatRequest mirror, rather
// than import, chatapi's unexported DTOs); this is the same call for the
// response side.
const (
	toolNameTodoWrite = "todo_write"
	toolNameTodoRead  = "todo_read"
)

// approvalDataPart mirrors tool_scheduler.go's const of the same name: the
// data part's name (the frame's type is "data-" + this).
const approvalDataPart = "tool-approval"

// approvalRequestWire is what a data-tool-approval frame's Data carries --
// suspendForApproval's payload, mirrored rather than imported.
type approvalRequestWire struct {
	ToolCallID string `json:"toolCallId"`
	ToolName   string `json:"toolName"`
	Risk       string `json:"risk"`
	Reason     string `json:"reason"`
	Command    string `json:"command"`
	Compound   bool   `json:"compound"`
}

// todoToolOutput is the subset of tools.TodoList this package reads.
type todoToolOutput struct {
	Items []TodoItem `json:"items"`
}

// finishMetadata is the subset of chatapi's unexported chatMetadata (the
// Finish frame's MessageMetadata) this package reads.
type finishMetadata struct {
	Usage     *Usage `json:"usage"`
	ChatModel *struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
	} `json:"chatModel"`
	DurationMS int64 `json:"durationMs"`
}

// Reduce folds one frame into the state. Data frames this package does not
// yet render (approval requests, compaction markers -- Phase 3's job) are
// consumed without effect, exactly like a browser tab that hasn't loaded a
// renderer for a part type it doesn't know.
func (s *State) Reduce(f uimessage.Frame) {
	switch f.Type {
	case uimessage.FrameStart:
		// A continuation (an approval answered) resumes with the *same*
		// message id RunTurn minted before it paused (runner.go's
		// "continuing" branch) -- appending a fresh Message here would
		// split one turn into two transcript entries and orphan the
		// answered tool call in the first one. Continue that message
		// instead when the id matches: the same rule runner.go's own
		// "one message however many times it had to stop" comment states
		// for the server side of this exact case.
		if n := len(s.Messages); n > 0 && s.Messages[n-1].ID == f.MessageID && s.Messages[n-1].Role == RoleAssistant {
			s.current = n - 1
		} else {
			s.Messages = append(s.Messages, Message{ID: f.MessageID, Role: RoleAssistant})
			s.current = len(s.Messages) - 1
		}
		s.Streaming = true
		s.openText = map[string]int{}
		s.openReasoning = map[string]int{}
		s.openTool = map[string]int{}

	case uimessage.FrameTextStart:
		s.openText[f.ID] = s.appendPart(Part{Kind: PartText})

	case uimessage.FrameTextDelta:
		s.appendToText(s.openText, f.ID, f.Delta)

	case uimessage.FrameTextEnd:
		delete(s.openText, f.ID)

	case uimessage.FrameReasoningStart:
		s.openReasoning[f.ID] = s.appendPart(Part{Kind: PartReasoning})

	case uimessage.FrameReasoningDelta:
		s.appendToText(s.openReasoning, f.ID, f.Delta)

	case uimessage.FrameReasoningEnd:
		delete(s.openReasoning, f.ID)

	case uimessage.FrameToolInputStart:
		s.openTool[f.ToolCallID] = s.appendPart(Part{
			Kind: PartTool,
			Tool: &ToolCall{ID: f.ToolCallID, Name: f.ToolName, Status: ToolPending},
		})

	case uimessage.FrameToolInputAvailable:
		tc := s.toolAt(s.toolIndex(f.ToolCallID, f.ToolName))
		if tc == nil {
			return
		}
		tc.Name = f.ToolName
		tc.Input = f.Input

	case uimessage.FrameToolOutputAvailable:
		tc := s.toolAt(s.toolIndex(f.ToolCallID, ""))
		if tc == nil {
			return
		}
		tc.Output = f.Output
		tc.Status = ToolDone
		s.observeToolOutput(*tc)

	case uimessage.FrameToolOutputError:
		tc := s.toolAt(s.toolIndex(f.ToolCallID, ""))
		if tc == nil {
			return
		}
		tc.ErrorText = f.ErrorText
		tc.Status = ToolError

	case uimessage.FrameError:
		s.Err = textError(f.ErrorText)

	case uimessage.DataFrameType(approvalDataPart):
		s.handleApprovalRequest(f)

	case uimessage.FrameFinish:
		s.Streaming = false
		s.applyFinishMetadata(f.MessageMetadata)

	case uimessage.FrameDone:
		s.Streaming = false
	}
}

// appendPart adds p to the in-flight assistant message and returns its
// index. Every frame handler that opens a new part (text, reasoning, tool)
// goes through this so "which message do I append to" is answered in one
// place.
func (s *State) appendPart(p Part) int {
	if s.current < 0 || s.current >= len(s.Messages) {
		return -1
	}
	s.Messages[s.current].Parts = append(s.Messages[s.current].Parts, p)
	return len(s.Messages[s.current].Parts) - 1
}

// appendToText appends delta to the part open[id] refers to, in the current
// message. Shared by TextDelta and ReasoningDelta -- the two are identical
// except which map and which frame field they read.
func (s *State) appendToText(open map[string]int, id, delta string) {
	if s.current < 0 || s.current >= len(s.Messages) {
		return
	}
	idx, ok := open[id]
	if !ok || idx < 0 || idx >= len(s.Messages[s.current].Parts) {
		return
	}
	s.Messages[s.current].Parts[idx].Text += delta
}

// toolIndex resolves a tool call's Part index by id, falling back to
// appending a fresh pending call if no ToolInputStart ever opened one --
// defensive against a frame sequence this package doesn't control the
// ordering of.
func (s *State) toolIndex(toolCallID, toolName string) int {
	if idx, ok := s.openTool[toolCallID]; ok {
		return idx
	}
	idx := s.appendPart(Part{Kind: PartTool, Tool: &ToolCall{ID: toolCallID, Name: toolName, Status: ToolPending}})
	if idx >= 0 {
		s.openTool[toolCallID] = idx
	}
	return idx
}

func (s *State) toolAt(idx int) *ToolCall {
	if s.current < 0 || s.current >= len(s.Messages) || idx < 0 || idx >= len(s.Messages[s.current].Parts) {
		return nil
	}
	return s.Messages[s.current].Parts[idx].Tool
}

// observeToolOutput updates thread-scoped state a tool call's result feeds
// beyond its own card -- today just the todo panel. Silently ignores output
// it can't decode: a tool answering in a shape this package doesn't
// recognize should still render its own card fine, and a bad todo payload
// is not a reason to crash the transcript.
func (s *State) observeToolOutput(tc ToolCall) {
	if tc.Name != toolNameTodoWrite && tc.Name != toolNameTodoRead {
		return
	}
	var todos todoToolOutput
	if err := json.Unmarshal(tc.Output, &todos); err != nil {
		return
	}
	s.Todos = todos.Items
}

// handleApprovalRequest reduces a data-tool-approval frame: marks the tool
// call it describes as awaiting a human answer and records the request at
// thread level, where the chat page looks for it to decide whether to show
// the approval dialog instead of the composer.
//
// Silently ignores a frame it can't decode or whose call it can't find --
// same posture as observeToolOutput: a malformed or out-of-order data part
// should not crash the transcript, just fail to render the extra state it
// describes.
func (s *State) handleApprovalRequest(f uimessage.Frame) {
	var w approvalRequestWire
	if err := json.Unmarshal(f.Data, &w); err != nil || w.ToolCallID == "" {
		return
	}
	req := &ApprovalRequest{
		ToolCallID: w.ToolCallID, ToolName: w.ToolName, Risk: w.Risk,
		Reason: w.Reason, Command: w.Command, Compound: w.Compound,
		Raw: f.Data,
	}
	if tc := s.toolAt(s.toolIndex(w.ToolCallID, w.ToolName)); tc != nil {
		tc.Status = ToolAwaitingApproval
		tc.Approval = req
	}
	s.PendingApproval = req
}

func (s *State) applyFinishMetadata(raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	var meta finishMetadata
	if err := json.Unmarshal(raw, &meta); err != nil {
		return
	}
	if meta.Usage != nil {
		s.Usage = meta.Usage
	}
	if meta.ChatModel != nil && meta.ChatModel.Model != "" {
		s.Model = meta.ChatModel.Provider + "/" + meta.ChatModel.Model
	}
	s.DurationMS = meta.DurationMS
}
