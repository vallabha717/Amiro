package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	bifrostai "betterchatbot/backend/internal/ai/bifrost"
	"betterchatbot/backend/internal/ai/tools"
	"betterchatbot/backend/internal/ai/uimessage"
	"betterchatbot/backend/internal/db/models"
)

// maxToolSteps ports route.ts's `stopWhen: stepCountIs(10)`.
const maxToolSteps = 10

// modelStepTimeout bounds a single StreamStep call (one full model turn,
// including every streamed chunk). bifrost/core deliberately imposes no
// deadline of its own here (schemas.NoDeadline -- see stream_step.go's
// bctx construction), trusting the caller's ctx alone, and this app's ctx
// otherwise has no deadline either: an httpserver request context only
// gets canceled by client disconnect, never by a timeout. Found live: a
// tool-augmented follow-up turn (model + tool history round-tripped back
// to the provider) against a custom OpenAI-compatible endpoint hung with
// no data ever arriving and no way to recover -- not an MCP problem at
// all, since a plain single-step chat against the same model completed
// normally. Generous on purpose: this bounds total call duration, not
// idle time between chunks, so it must comfortably exceed a real slow-but-
// actively-streaming response.
// A var, not a const, so tests can shrink it instead of waiting out the
// real duration.
var modelStepTimeout = 120 * time.Second

// toolLoopResult is what running the multi-step tool loop produced, ready
// for route.go to fold into an assistant models.ChatMessage the same way a
// tool-free reply already is.
type toolLoopResult struct {
	Text  string          // every step's text, in order, joined like textOf
	Parts json.RawMessage // the full ordered parts array to persist
	Usage *bifrostai.Usage
}

// runToolLoop ports route.ts's `streamText({tools, stopWhen:
// stepCountIs(10)})` multi-step tool-calling loop over Bifrost's real
// network stream (StreamStep): call the model, forwarding its text deltas
// to the client as they arrive, and if it made tool calls, resolve every
// one that has a server-side Execute (visualization, http, web search) and
// loop again with the result appended to history. A tool call whose
// Definition has a nil Execute (JS/Python execution -- internal/ai/tools/
// code.go) is a client tool: its call is written to the stream and the
// loop stops immediately, same as the TS route, where a tool with no
// `execute` pauses generation until the frontend resubmits with a result
// (chat-bot.tsx's sendAutomaticallyWhen). Any other tool calls in that same
// batch are left unresolved and dropped -- matching how the underlying
// step can't complete with only some of its tool calls answered.
func runToolLoop(
	ctx context.Context,
	engine Engine,
	sw *uimessage.Writer,
	resolved bifrostai.ResolvedModel,
	system string,
	messages []bifrostai.Message,
	activeTools []tools.Definition,
) (toolLoopResult, error) {
	specs := make([]bifrostai.ToolSpec, len(activeTools))
	for i, d := range activeTools {
		specs[i] = bifrostai.ToolSpec{Name: d.Name, Description: d.Description, ParametersSchema: d.ParametersSchema}
	}

	var fullText string
	parts := []map[string]any{}
	var usage *bifrostai.Usage

	for step := 0; step < maxToolSteps; step++ {
		_ = sw.StartStep()

		textID := models.NewID()
		started := false
		onTextDelta := func(delta string) {
			if !started {
				_ = sw.TextStart(textID)
				started = true
			}
			_ = sw.TextDelta(textID, delta)
		}

		stepCtx, cancel := context.WithTimeout(ctx, modelStepTimeout)
		result, err := engine.StreamStep(stepCtx, resolved, system, messages, specs, onTextDelta)
		cancel()
		if err != nil {
			_ = sw.FinishStep()
			if stepCtx.Err() == context.DeadlineExceeded {
				return toolLoopResult{}, fmt.Errorf("model call timed out after %s: %w", modelStepTimeout, err)
			}
			return toolLoopResult{}, err
		}
		if started {
			_ = sw.TextEnd(textID)
		}
		if result.Usage != nil {
			usage = result.Usage
		}

		if result.Text != "" {
			if fullText != "" {
				fullText += "\n\n"
			}
			fullText += result.Text
			parts = append(parts, map[string]any{"type": "text", "text": result.Text})
		}

		if len(result.ToolCalls) == 0 {
			_ = sw.FinishStep()
			break
		}

		stop := false
		for _, tc := range result.ToolCalls {
			input := json.RawMessage(tc.Arguments)
			if len(input) == 0 {
				input = json.RawMessage("{}")
			}

			def, found := tools.FindByName(activeTools, tc.Name)
			// A tool name the model invented/mis-typed and one this turn
			// genuinely offered but left client-executed (nil Execute --
			// e.g. code.go's JS/Python tools) look similar but are not:
			// the latter is a real, expected pause (the frontend resubmits
			// with a result, matching the TS route's
			// sendAutomaticallyWhen). !found has no such contract on
			// either side -- nothing will ever resubmit for it. Found
			// live: a model called a plausible-but-nonexistent MCP tool
			// name, and treating it as the same "pause and wait" case
			// left the chat stuck forever with no way to recover (Stop
			// included, since the request had already completed
			// normally from the server's point of view).
			if !found {
				_ = sw.ToolInputAvailable(tc.ID, tc.Name, input)
				errMsg := "unknown tool: " + tc.Name
				_ = sw.ToolOutputError(tc.ID, errMsg)
				messages = append(messages, bifrostai.Message{
					Role:      bifrostai.RoleAssistant,
					ToolCalls: []bifrostai.ToolCall{{ID: tc.ID, Name: tc.Name, Arguments: string(input)}},
				})
				messages = append(messages, bifrostai.Message{Role: bifrostai.RoleTool, ToolCallID: tc.ID, Text: errMsg})
				parts = append(parts, map[string]any{
					"type": "tool-" + tc.Name, "toolCallId": tc.ID, "state": "output-error", "input": input, "errorText": errMsg,
				})
				continue
			}
			if def.Execute == nil {
				_ = sw.ToolInputAvailable(tc.ID, tc.Name, input)
				parts = append(parts, map[string]any{
					"type": "tool-" + tc.Name, "toolCallId": tc.ID, "state": "input-available", "input": input,
				})
				stop = true
				break
			}

			_ = sw.ToolInputAvailable(tc.ID, tc.Name, input)
			output, execErr := def.Execute(ctx, input)
			messages = append(messages, bifrostai.Message{
				Role:      bifrostai.RoleAssistant,
				ToolCalls: []bifrostai.ToolCall{{ID: tc.ID, Name: tc.Name, Arguments: string(input)}},
			})
			if execErr != nil {
				_ = sw.ToolOutputError(tc.ID, execErr.Error())
				messages = append(messages, bifrostai.Message{Role: bifrostai.RoleTool, ToolCallID: tc.ID, Text: execErr.Error()})
				parts = append(parts, map[string]any{
					"type": "tool-" + tc.Name, "toolCallId": tc.ID, "state": "output-error", "input": input, "errorText": execErr.Error(),
				})
				continue
			}

			_ = sw.ToolOutputAvailable(tc.ID, output)
			outputJSON, _ := json.Marshal(output)
			messages = append(messages, bifrostai.Message{Role: bifrostai.RoleTool, ToolCallID: tc.ID, Text: stringifyToolOutput(outputJSON)})
			parts = append(parts, map[string]any{
				"type": "tool-" + tc.Name, "toolCallId": tc.ID, "state": "output-available", "input": input, "output": output,
			})
		}

		_ = sw.FinishStep()
		if stop {
			break
		}
	}

	partsJSON, err := json.Marshal(parts)
	if err != nil {
		return toolLoopResult{}, err
	}
	return toolLoopResult{Text: fullText, Parts: partsJSON, Usage: usage}, nil
}
