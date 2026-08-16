package bifrostai

import (
	"encoding/json"
	"fmt"

	"github.com/maximhq/bifrost/core/schemas"
)

// ToolSpec is the provider-agnostic shape internal/ai/tools.Definition
// reduces to for a Bifrost request -- this package doesn't depend on
// internal/ai/tools (nothing here needs to know how a tool executes, only
// how to declare and detect it), so callers (internal/api/chat) convert
// their own tool definitions into these.
type ToolSpec struct {
	Name             string
	Description      string
	ParametersSchema json.RawMessage
}

// StepResult is one model turn's outcome, accumulated from
// StreamStep's real-time deltas: either plain text (no tool calls: the
// model is done) or one or more tool calls the caller must resolve before
// the conversation can continue -- porting the same "assistant produces
// tool_calls with no further content" shape GenerateWithTool already reads
// off ChatAssistantMessage.ToolCalls.
type StepResult struct {
	Text string
	// Reasoning is the model's thinking for this step, when it exposes
	// any. Streamed live via StepHooks.OnReasoningDelta.
	Reasoning string
	ToolCalls []ToolCall
	Usage     *Usage
}

// buildChatTools converts ToolSpecs into schemas.ChatTool, reusing
// ToolFunctionParameters' own JSON-Schema UnmarshalJSON (confirmed against
// GenerateWithTool's identical use) rather than hand-building the
// OrderedMap/AdditionalPropertiesStruct fields directly.
func buildChatTools(specs []ToolSpec) ([]schemas.ChatTool, error) {
	if len(specs) == 0 {
		return nil, nil
	}
	out := make([]schemas.ChatTool, 0, len(specs))
	for _, spec := range specs {
		var params schemas.ToolFunctionParameters
		if len(spec.ParametersSchema) > 0 {
			if err := json.Unmarshal(spec.ParametersSchema, &params); err != nil {
				return nil, fmt.Errorf("tool %q: invalid parameters schema: %w", spec.Name, err)
			}
		} else {
			params = schemas.ToolFunctionParameters{Type: "object"}
		}
		desc := spec.Description
		out = append(out, schemas.ChatTool{
			Type: schemas.ChatToolTypeFunction,
			Function: &schemas.ChatToolFunction{
				Name:        spec.Name,
				Description: &desc,
				Parameters:  &params,
			},
		})
	}
	return out, nil
}
