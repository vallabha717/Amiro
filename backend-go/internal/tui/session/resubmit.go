package session

import "encoding/json"

// approvalAnswerTag is the wire tag the backend's approvals.go recognizes
// (approvalAnswer.Tag, `json:"__tag"`) -- the marker that turns a tool
// part's "output" from a real result into a suspended call's answer.
const approvalAnswerTag = "manual-tool-confirm"

// approvalAnswerWire mirrors chat.approvalAnswer -- the exact bytes both
// approvals.go's parseApprovalAnswer and the desktop app's
// ManualToolConfirmTag.create must agree on. See that type's doc comment
// in src/types/chat.ts: a frontend copy of this shape once used the wrong
// key (lib/tag.ts's generic `__$ref__` instead of `__tag`) and silently
// never answered a single approval -- the confirmation object round-tripped
// back to the model as if it were the tool's own result.
type approvalAnswerWire struct {
	Tag     string `json:"__tag"`
	Confirm bool   `json:"confirm"`
	Scope   string `json:"scope,omitempty"`
}

// wireTextPart, wireToolPart, wireApprovalDataPart mirror parts.go's
// map[string]any literals -- this package's usual reason for a local
// mirror applies again: the shape is defined once, server-side, and
// reproduced here rather than imported.
type wireTextPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type wireToolPart struct {
	Type       string          `json:"type"`
	ToolCallID string          `json:"toolCallId"`
	Input      json.RawMessage `json:"input"`
	State      string          `json:"state"`
	Output     json.RawMessage `json:"output,omitempty"`
	ErrorText  string          `json:"errorText,omitempty"`
}

type wireApprovalDataPart struct {
	Type string          `json:"type"`
	ID   string          `json:"id"`
	Data json.RawMessage `json:"data"`
}

func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		// Every type fed to this file marshals unconditionally (strings,
		// bools, already-valid json.RawMessage) -- unreachable in practice,
		// and an empty object beats panicking mid-resubmission.
		return json.RawMessage("{}")
	}
	return b
}

// BuildApprovalResubmission answers s.PendingApproval and returns the full
// set of wire parts for the assistant message being continued -- what
// client.AssistantResubmission.Parts must carry, per RunTurn's contract
// that a continuation's req.Message.Parts *is* the turn so far
// (runner.go's "continuing" branch persists exactly this array, spliced
// with whatever the next round adds).
//
// ok is false with no PendingApproval to answer -- callers should not be
// asking otherwise.
//
// The answered call's local status is optimistically set to ToolDone (or
// ToolError, worded the same as approvals.go's declinedToolMessage, for a
// denial) purely for how the transcript renders from this point on. That
// is genuinely all the client can know about the outcome: resolveApprovals
// executes an approved call server-side and folds its real result straight
// into persisted history without ever streaming it back as a frame -- the
// same limitation the desktop app's own tool card has today (it reads
// "pending" until the thread is reloaded). page/threads.go's resume path,
// which replays the persisted parts, is what recovers the real output.
func (s *State) BuildApprovalResubmission(confirm bool, scope string) (messageID string, parts []json.RawMessage, ok bool) {
	req := s.PendingApproval
	if req == nil || s.current < 0 || s.current >= len(s.Messages) {
		return "", nil, false
	}
	msg := &s.Messages[s.current]

	answer := mustMarshal(approvalAnswerWire{Tag: approvalAnswerTag, Confirm: confirm, Scope: scope})

	found := false
	parts = make([]json.RawMessage, 0, len(msg.Parts)+1)
	for i := range msg.Parts {
		p := &msg.Parts[i]
		switch p.Kind {
		case PartText:
			parts = append(parts, mustMarshal(wireTextPart{Type: "text", Text: p.Text}))
		case PartReasoning:
			parts = append(parts, mustMarshal(wireTextPart{Type: "reasoning", Text: p.Text}))
		case PartTool:
			if p.Tool == nil {
				continue
			}
			if p.Tool.ID != req.ToolCallID {
				parts = append(parts, toolWireParts(*p.Tool)...)
				continue
			}
			found = true
			parts = append(parts, mustMarshal(wireToolPart{
				Type: "tool-" + p.Tool.Name, ToolCallID: p.Tool.ID,
				Input: rawOrEmptyObject(p.Tool.Input), State: "output-available", Output: answer,
			}))
			if p.Tool.Approval != nil {
				parts = append(parts, mustMarshal(wireApprovalDataPart{
					Type: "data-" + approvalDataPart, ID: p.Tool.Approval.ToolCallID, Data: p.Tool.Approval.Raw,
				}))
			}
			if confirm {
				p.Tool.Status = ToolDone
			} else {
				p.Tool.Status = ToolError
				p.Tool.ErrorText = declinedToolMessage(p.Tool.Name)
			}
			p.Tool.Approval = nil
		}
	}
	if !found {
		return "", nil, false
	}

	s.PendingApproval = nil
	return msg.ID, parts, true
}

// declinedToolMessage mirrors approvals.go's sentence of the same name --
// what the model is told, and now what the transcript shows locally too,
// when a human says no. Two surfaces phrasing a refusal differently is a
// difference nobody chose (that file's own doc comment); this is the
// display-only echo of the sentence the server actually sends the model.
func declinedToolMessage(toolName string) string {
	return "The user declined to run " + toolName + "."
}

// toolWireParts is one tool call's wire representation -- toolCallPart in
// parts.go, mirrored the same way every renderer in this tree mirrors a
// server-side shape rather than importing it. Used for every tool part in
// a resubmitted message other than the one just answered.
func toolWireParts(tc ToolCall) []json.RawMessage {
	part := wireToolPart{Type: "tool-" + tc.Name, ToolCallID: tc.ID, Input: rawOrEmptyObject(tc.Input)}
	switch tc.Status {
	case ToolDone:
		part.State = "output-available"
		part.Output = tc.Output
	case ToolError:
		part.State = "output-error"
		part.ErrorText = tc.ErrorText
	default:
		// Pending, interrupted, or (defensively) a second still-open
		// approval: nothing resolved this call yet, so it round-trips
		// exactly as it arrived -- parts.go's own fallback for "a turn cut
		// off mid-call".
		part.State = "input-available"
	}

	out := []json.RawMessage{mustMarshal(part)}
	if tc.Approval != nil {
		out = append(out, mustMarshal(wireApprovalDataPart{
			Type: "data-" + approvalDataPart, ID: tc.Approval.ToolCallID, Data: tc.Approval.Raw,
		}))
	}
	return out
}

func rawOrEmptyObject(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("{}")
	}
	return raw
}
