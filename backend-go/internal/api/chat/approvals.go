package chat

import (
	"context"
	"encoding/json"
	"strings"

	"amiro/backend/internal/agent/permission"
	"amiro/backend/internal/ai/tools"
)

// approvalAnswer is what the frontend sends back as a suspended tool call's
// "output" once the user has answered. It matches ManualToolConfirmTag in
// src/types/chat.ts.
//
// The tag wrapper is the frontend's existing convention for "this output is
// a control message, not a real tool result", and reusing it is what lets
// the approval round trip ride the manual-tool-invocation rail that already
// exists on both sides rather than needing a second one.
type approvalAnswer struct {
	Tag     string `json:"__tag"`
	Confirm bool   `json:"confirm"`
	// Scope is "once" (default) or "always". "always" adds the tool -- or,
	// for a command-shaped call, that exact command line -- to the session's
	// grants, so the rest of the conversation stops asking.
	Scope string `json:"scope,omitempty"`
}

const approvalTag = "manual-tool-confirm"

// parseApprovalAnswer recognizes a tool part's output as an approval answer
// rather than a real result.
func parseApprovalAnswer(raw json.RawMessage) (approvalAnswer, bool) {
	var a approvalAnswer
	if err := json.Unmarshal(raw, &a); err != nil {
		return approvalAnswer{}, false
	}
	if a.Tag != approvalTag {
		return approvalAnswer{}, false
	}
	return a, true
}

// resolveApprovals runs the tool calls the user just approved, and turns the
// ones they rejected into results the model can read, rewriting the
// resubmitted message in place.
//
// This is the second half of the suspend in tool_scheduler.go's
// suspendForApproval. The turn that asked ended; the browser rendered a
// card; the user answered; the AI SDK resubmitted the whole assistant
// message with the answer sitting where the tool's output goes. Without
// this pass, that answer -- `{"__tag":"manual-tool-confirm","confirm":true}`
// -- would be handed to the model as if it were what read_file returned,
// and the approved work would simply never happen.
func resolveApprovals(
	ctx context.Context,
	msg *uiMessage,
	activeTools []tools.Definition,
	perms *permission.Engine,
) {
	if msg == nil || msg.Role != "assistant" {
		return
	}

	for i, raw := range msg.Parts {
		var p struct {
			Type       string          `json:"type"`
			ToolCallID string          `json:"toolCallId"`
			State      string          `json:"state"`
			Input      json.RawMessage `json:"input"`
			Output     json.RawMessage `json:"output"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			continue
		}
		if !strings.HasPrefix(p.Type, "tool-") || len(p.Output) == 0 {
			continue
		}
		answer, ok := parseApprovalAnswer(p.Output)
		if !ok {
			continue
		}

		toolName := strings.TrimPrefix(p.Type, "tool-")
		input := p.Input
		if len(input) == 0 || !json.Valid(input) {
			input = json.RawMessage("{}")
		}

		var replacement map[string]any
		switch {
		case !answer.Confirm:
			// A rejection is a normal tool result, not an error: the model
			// needs to read it, understand the user said no, and pick
			// another route rather than retry the same call.
			replacement = map[string]any{
				"type": p.Type, "toolCallId": p.ToolCallID, "state": "output-error",
				"input":     input,
				"errorText": declinedToolMessage(toolName),
			}
		default:
			def, found := tools.FindByName(activeTools, toolName)
			switch {
			case !found:
				replacement = map[string]any{
					"type": p.Type, "toolCallId": p.ToolCallID, "state": "output-error",
					"input": input, "errorText": "approved, but " + toolName + " is not available in this turn",
				}
			case def.Execute == nil:
				// Unreachable today -- no built-in tool is both
				// client-executed and permission-gated -- but the gate runs
				// before the client-tool branch on purpose, so this is the
				// branch that would catch a future one instead of silently
				// dropping the call.
				replacement = map[string]any{
					"type": p.Type, "toolCallId": p.ToolCallID, "state": "output-error",
					"input": input, "errorText": toolName + " has no server-side implementation to run after approval",
				}
			default:
				rememberApproval(perms, def, input, answer)
				output, execErr := def.Execute(ctx, input)
				if execErr != nil {
					replacement = map[string]any{
						"type": p.Type, "toolCallId": p.ToolCallID, "state": "output-error",
						"input": input, "errorText": execErr.Error(),
					}
				} else {
					replacement = map[string]any{
						"type": p.Type, "toolCallId": p.ToolCallID, "state": "output-available",
						"input": input, "output": output,
					}
				}
			}
		}

		encoded, err := json.Marshal(replacement)
		if err != nil {
			continue
		}
		msg.Parts[i] = encoded
	}
}

// rememberApproval records an "always" answer against the session.
//
// Command-shaped calls remember the command, not the tool: approving
// `git commit -m "wip"` forever must not also approve `git add`, and
// approving one shell command must never mean approving the shell.
func rememberApproval(perms *permission.Engine, def tools.Definition, input json.RawMessage, answer approvalAnswer) {
	if perms == nil || answer.Scope != "always" {
		return
	}
	sess := perms.Session()
	if command := commandLineOf(def, input); command != "" {
		sess.AllowCommand(command)
		return
	}
	sess.AllowTool(def.Name)
}

// commandLineOf renders a call the way the permission engine and the
// approval card both see it.
func commandLineOf(def tools.Definition, input json.RawMessage) string {
	if def.CommandLine != nil {
		return strings.TrimSpace(def.CommandLine(input))
	}
	var in struct {
		Command string `json:"command"`
	}
	if err := json.Unmarshal(input, &in); err != nil {
		return ""
	}
	return strings.TrimSpace(in.Command)
}
