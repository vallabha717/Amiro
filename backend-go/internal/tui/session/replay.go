package session

import (
	"encoding/json"
	"strings"
)

// PersistedMessage is one message the way client.ThreadDetail carries it --
// this package's own neutral shape rather than importing client's (the
// architectural rule cuts one way: client is the only package that knows a
// transport exists, not that nothing else may describe a persisted
// message). page/threads.go copies client.ThreadMessage's four fields into
// this on the way in.
type PersistedMessage struct {
	ID       string
	Role     string
	Parts    []json.RawMessage
	Metadata json.RawMessage
}

// ReplayThread rebuilds a State for display from a thread's persisted
// messages -- page/threads.go's resume path, and the inverse of
// wireParts/BuildApprovalResubmission: those turn live State into wire
// parts to send, this turns wire parts already on disk back into the same
// Message/Part shape live streaming produces, so page.Chat's existing
// renderParts draws a resumed thread with no second render path.
//
// A tool call still sitting at "input-available" with no matching
// data-tool-approval part (a turn that was cut off some other way, or an
// approval a future part kind obsoletes) renders as ToolPending rather than
// ToolAwaitingApproval -- there is no live turn to answer for it, so no
// dialog should open just because the thread was reopened. Only an actual
// data-tool-approval part -- proof this call is one a human has to bless --
// upgrades it to awaiting-approval, matching a session that resumes with
// the dialog open the same way it would if that frame had just arrived.
func ReplayThread(threadID string, messages []PersistedMessage) *State {
	s := New(threadID)
	for _, pm := range messages {
		msg := Message{ID: pm.ID, Role: Role(pm.Role)}
		toolByID := map[string]int{}

		for _, raw := range pm.Parts {
			var peek struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(raw, &peek); err != nil {
				continue
			}
			switch {
			case peek.Type == "text":
				var p wireTextPart
				if json.Unmarshal(raw, &p) == nil {
					msg.Parts = append(msg.Parts, Part{Kind: PartText, Text: p.Text})
				}
			case peek.Type == "reasoning":
				var p wireTextPart
				if json.Unmarshal(raw, &p) == nil {
					msg.Parts = append(msg.Parts, Part{Kind: PartReasoning, Text: p.Text})
				}
			case peek.Type == "data-"+approvalDataPart:
				var p wireApprovalDataPart
				if json.Unmarshal(raw, &p) != nil {
					continue
				}
				var w approvalRequestWire
				if json.Unmarshal(p.Data, &w) != nil || w.ToolCallID == "" {
					continue
				}
				if idx, ok := toolByID[w.ToolCallID]; ok && msg.Parts[idx].Tool != nil {
					msg.Parts[idx].Tool.Status = ToolAwaitingApproval
					msg.Parts[idx].Tool.Approval = &ApprovalRequest{
						ToolCallID: w.ToolCallID, ToolName: w.ToolName, Risk: w.Risk,
						Reason: w.Reason, Command: w.Command, Compound: w.Compound, Raw: p.Data,
					}
				}
			case strings.HasPrefix(peek.Type, "tool-"):
				var p wireToolPart
				if json.Unmarshal(raw, &p) != nil {
					continue
				}
				tc := &ToolCall{
					ID: p.ToolCallID, Name: strings.TrimPrefix(peek.Type, "tool-"),
					Input: p.Input, Output: p.Output, ErrorText: p.ErrorText,
				}
				switch p.State {
				case "output-available":
					tc.Status = ToolDone
				case "output-error":
					tc.Status = ToolError
				default:
					tc.Status = ToolPending
				}
				toolByID[p.ToolCallID] = len(msg.Parts)
				msg.Parts = append(msg.Parts, Part{Kind: PartTool, Tool: tc})
			}
		}

		s.Messages = append(s.Messages, msg)
		if msg.Role == RoleAssistant {
			s.applyFinishMetadata(pm.Metadata)
		}
	}

	// A thread can be reopened while its last turn is still waiting on a
	// human -- resuming it should offer the same dialog a live frame would
	// have, not silently drop the question.
	if n := len(s.Messages); n > 0 && s.Messages[n-1].Role == RoleAssistant {
		for _, p := range s.Messages[n-1].Parts {
			if p.Kind == PartTool && p.Tool != nil && p.Tool.Status == ToolAwaitingApproval {
				s.current = n - 1
				s.PendingApproval = p.Tool.Approval
				break
			}
		}
	}
	return s
}
