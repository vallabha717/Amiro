package bifrostai

import (
	"context"

	"github.com/maximhq/bifrost/core/schemas"
)

// TestStepMaxTokens bounds a connectivity test's output.
//
// It exists because StreamStep deliberately sends no token cap -- a real
// chat turn should run as long as the answer needs. A test is the opposite:
// the caller is a user watching a spinner on the providers page, and a
// reasoning model handed even a trivial prompt (observed with
// z-ai/glm-5.2 through the Nous gateway) will happily spend minutes
// thinking before emitting its first content token. Capping the test keeps
// a slow-but-working model from reading as a hung one.
const TestStepMaxTokens = 1024

// TestStep runs one bounded, streamed round trip -- the same request shape
// StreamStep builds (tools attached, tool_choice auto) plus a hard output
// cap. Used only by the provider model test; nothing on the chat path
// should borrow it, since the cap would truncate real answers.
//
// A model that exhausts the cap on reasoning tokens returns an empty
// StepResult.Text with no error. That is a successful test -- the key, base
// URL and model id all resolved -- and the caller is expected to report it
// as such rather than as a failure.
func (c *Client) TestStep(
	ctx context.Context,
	resolved ResolvedModel,
	system string,
	messages []Message,
	toolSpecs []ToolSpec,
) (*StepResult, error) {
	tools, err := buildChatTools(toolSpecs)
	if err != nil {
		return nil, err
	}

	bctx := schemas.NewBifrostContext(ctx, schemas.NoDeadline)
	maxTokens := TestStepMaxTokens
	params := &schemas.ChatParameters{MaxCompletionTokens: &maxTokens}
	if len(tools) > 0 {
		auto := "auto"
		params.Tools = tools
		params.ToolChoice = &schemas.ChatToolChoice{ChatToolChoiceStr: &auto}
	}

	req := &schemas.BifrostChatRequest{
		Provider: resolved.Provider,
		Model:    resolved.BifrostModel,
		Input:    toBifrostMessages(system, messages),
		Params:   params,
	}

	stream, bErr := c.bf.ChatCompletionStreamRequest(bctx, req)
	if bErr != nil {
		return nil, toError(bErr)
	}

	var acc stepAccumulator
	for sc := range stream {
		if sc == nil {
			continue
		}
		if sc.BifrostError != nil {
			bctx.Cancel()
			return nil, toError(sc.BifrostError)
		}
		if sc.BifrostChatResponse == nil {
			continue
		}
		for _, choice := range sc.BifrostChatResponse.Choices {
			if choice.ChatStreamResponseChoice == nil {
				continue
			}
			acc.addDelta(choice.ChatStreamResponseChoice.Delta)
		}
		if u := sc.BifrostChatResponse.Usage; u != nil {
			acc.setUsage(&Usage{
				PromptTokens:     u.PromptTokens,
				CompletionTokens: u.CompletionTokens,
				TotalTokens:      u.TotalTokens,
			})
		}
		// See stream_finish.go: a gateway that never sends [DONE] would
		// otherwise leave this loop blocked on an idle connection.
		if streamTurnFinished(sc.BifrostChatResponse) {
			bctx.Cancel()
			break
		}
	}

	return acc.finish(), nil
}
