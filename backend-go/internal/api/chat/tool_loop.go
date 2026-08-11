package chat

import (
	"context"
	"encoding/json"

	bifrostai "betterchatbot/backend/internal/ai/bifrost"
	"betterchatbot/backend/internal/ai/tools"
	"betterchatbot/backend/internal/ai/uimessage"
	"betterchatbot/backend/internal/db/models"
)

// maxToolSteps ports route.ts's `stopWhen: stepCountIs(10)`.
const maxToolSteps = 10

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

		result, err := engine.StreamStep(ctx, resolved, system, messages, specs, onTextDelta)
		if err != nil {
			_ = sw.FinishStep()
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
			if !found || def.Execute == nil {
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
