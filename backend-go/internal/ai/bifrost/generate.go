package bifrostai

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/maximhq/bifrost/core/schemas"
)

// GenerateResult is the non-streaming counterpart to Stream's Chunk channel,
// used by nodes that need a single complete reply rather than incremental
// deltas (workflow LLM/Tool nodes -- Phase 5 -- have no UI to stream into,
// unlike chat's route.go).
type GenerateResult struct {
	Text  string
	Usage *Usage
}

// Generate sends a non-streaming ChatCompletionRequest and returns the full
// reply text, porting the ai package's generateText for workflow nodes
// (node-executor.ts's llmNodeExecutor "isTextResponse" branch). system is
// folded into messages as a leading system-role turn only when non-empty;
// callers that already have a full role-annotated message list (e.g. a
// workflow LLM node's own system/user/assistant messages) can pass
// system="" and put everything in messages, exactly like Stream.
func (c *Client) Generate(ctx context.Context, resolved ResolvedModel, system string, messages []Message) (*GenerateResult, error) {
	bctx := schemas.NewBifrostContext(ctx, schemas.NoDeadline)
	req := &schemas.BifrostChatRequest{
		Provider: resolved.Provider,
		Model:    resolved.BifrostModel,
		Input:    toBifrostMessages(system, messages),
	}

	resp, bErr := c.bf.ChatCompletionRequest(bctx, req)
	if bErr != nil {
		return nil, toError(bErr)
	}
	text, err := responseText(resp)
	if err != nil {
		return nil, err
	}
	return &GenerateResult{Text: text, Usage: responseUsage(resp)}, nil
}

// GenerateObject requests a JSON reply constrained to schema (a JSON Schema
// object, e.g. an outputSchema.properties.answer node from workflow.interface's
// ObjectJsonSchema7), porting generateObject's role in llmNodeExecutor. The
// returned bytes are the model's raw JSON text, not yet validated against
// schema -- callers unmarshal it into whatever Go value they need, the same
// way the TS route trusts generateObject's own schema-guided output.
//
// Unlike the TS call (maxRetries: 3), this makes exactly one request --  a
// malformed reply fails the node once instead of silently retrying.
func (c *Client) GenerateObject(ctx context.Context, resolved ResolvedModel, system string, messages []Message, schema json.RawMessage) (json.RawMessage, *Usage, error) {
	responseFormat, err := jsonSchemaResponseFormat("workflow_node_output", schema)
	if err != nil {
		return nil, nil, err
	}

	bctx := schemas.NewBifrostContext(ctx, schemas.NoDeadline)
	req := &schemas.BifrostChatRequest{
		Provider: resolved.Provider,
		Model:    resolved.BifrostModel,
		Input:    toBifrostMessages(system, messages),
		Params:   &schemas.ChatParameters{ResponseFormat: &responseFormat},
	}

	resp, bErr := c.bf.ChatCompletionRequest(bctx, req)
	if bErr != nil {
		return nil, nil, toError(bErr)
	}
	text, err := responseText(resp)
	if err != nil {
		return nil, nil, err
	}
	if !json.Valid([]byte(text)) {
		return nil, nil, errors.New("model did not return valid JSON for the requested schema")
	}
	return json.RawMessage(text), responseUsage(resp), nil
}

// GenerateWithTool forces a single named tool call and returns its
// arguments, porting toolNodeExecutor's parameter-generation step
// (generateText with toolChoice: "required" and exactly one tool). Returns
// nil arguments (not an error) if the model returns no tool call at all --
// callers treat that the same way the TS executor's
// `response.toolCalls.find(...)?.input` (possibly undefined) does.
func (c *Client) GenerateWithTool(ctx context.Context, resolved ResolvedModel, prompt string, toolName, toolDescription string, paramSchema json.RawMessage) (json.RawMessage, error) {
	var params schemas.ToolFunctionParameters
	if len(paramSchema) > 0 {
		if err := json.Unmarshal(paramSchema, &params); err != nil {
			return nil, err
		}
	} else {
		params = schemas.ToolFunctionParameters{Type: "object"}
	}

	desc := toolDescription
	required := "required"
	bctx := schemas.NewBifrostContext(ctx, schemas.NoDeadline)
	req := &schemas.BifrostChatRequest{
		Provider: resolved.Provider,
		Model:    resolved.BifrostModel,
		Input:    toBifrostMessages("", []Message{{Role: RoleUser, Text: prompt}}),
		Params: &schemas.ChatParameters{
			Tools: []schemas.ChatTool{{
				Type: schemas.ChatToolTypeFunction,
				Function: &schemas.ChatToolFunction{
					Name:        toolName,
					Description: &desc,
					Parameters:  &params,
				},
			}},
			ToolChoice: &schemas.ChatToolChoice{ChatToolChoiceStr: &required},
		},
	}

	resp, bErr := c.bf.ChatCompletionRequest(bctx, req)
	if bErr != nil {
		return nil, toError(bErr)
	}
	if resp == nil || len(resp.Choices) == 0 {
		return nil, nil
	}
	choice := resp.Choices[0]
	if choice.ChatNonStreamResponseChoice == nil || choice.ChatNonStreamResponseChoice.Message == nil {
		return nil, nil
	}
	msg := choice.ChatNonStreamResponseChoice.Message
	if msg.ChatAssistantMessage == nil || len(msg.ChatAssistantMessage.ToolCalls) == 0 {
		return nil, nil
	}
	for _, call := range msg.ChatAssistantMessage.ToolCalls {
		if call.Function.Name != nil && *call.Function.Name != toolName {
			continue
		}
		args := call.Function.Arguments
		if args == "" {
			return nil, nil
		}
		return json.RawMessage(args), nil
	}
	return nil, nil
}

// jsonSchemaResponseFormat builds the OpenAI-shaped
// {"type":"json_schema","json_schema":{"name","strict","schema"}} value
// ChatParameters.ResponseFormat expects (confirmed against
// schemas/mux_test.go's makeJSONSchemaResponseFormat helper -- there's no
// exported constructor for it). strict is deliberately false: workflow
// output schemas are user-authored JSON Schema that don't consistently set
// additionalProperties: false, and strict mode rejects those outright on
// providers that enforce it.
func jsonSchemaResponseFormat(name string, schema json.RawMessage) (interface{}, error) {
	schemaValue := map[string]interface{}{"type": "object"}
	if len(schema) > 0 {
		if err := json.Unmarshal(schema, &schemaValue); err != nil {
			return nil, err
		}
	}
	return map[string]interface{}{
		"type": "json_schema",
		"json_schema": map[string]interface{}{
			"name":   name,
			"strict": false,
			"schema": schemaValue,
		},
	}, nil
}

func responseText(resp *schemas.BifrostChatResponse) (string, error) {
	if resp == nil || len(resp.Choices) == 0 {
		return "", errors.New("bifrost: empty response")
	}
	choice := resp.Choices[0]
	if choice.ChatNonStreamResponseChoice == nil || choice.ChatNonStreamResponseChoice.Message == nil {
		return "", errors.New("bifrost: response has no message")
	}
	content := choice.ChatNonStreamResponseChoice.Message.Content
	if content == nil || content.ContentStr == nil {
		return "", nil
	}
	return *content.ContentStr, nil
}

func responseUsage(resp *schemas.BifrostChatResponse) *Usage {
	if resp == nil || resp.Usage == nil {
		return nil
	}
	return &Usage{
		PromptTokens:     resp.Usage.PromptTokens,
		CompletionTokens: resp.Usage.CompletionTokens,
		TotalTokens:      resp.Usage.TotalTokens,
	}
}
