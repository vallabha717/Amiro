package bifrostai

import (
	"context"
	"strings"

	"github.com/maximhq/bifrost/core/schemas"
)

// stepAccumulator folds a sequence of ChatStreamResponseChoiceDelta values
// into a StepResult -- split out from StreamStep as its own type so the
// index-keyed tool-call fragment assembly (the one genuinely tricky part
// of streaming) is directly unit-testable without a real Bifrost
// connection, the same reason internal/api/chat's tool loading logic lives
// in ordinary functions rather than inline in an HTTP handler.
type stepAccumulator struct {
	textBuf strings.Builder
	usage   *Usage

	calls map[uint16]*buildingToolCall
	order []uint16 // first-seen order, for deterministic ToolCalls output
}

type buildingToolCall struct {
	id, name string
	args     strings.Builder
}

// addDelta folds one delta into the accumulator, invoking onTextDelta for
// any non-empty text fragment (never for tool-call fragments -- a tool
// call's streamed arguments aren't user-facing text).
//
// Tool-call deltas arrive fragmented and index-keyed (a provider streams a
// tool call's id/name once, then its arguments string across many
// chunks); this accumulates by ChatAssistantMessageToolCall.Index and only
// finalizes each call once the stream ends (finish), same shape a
// non-streaming response's ChatAssistantMessage.ToolCalls already has
// fully formed.
func (a *stepAccumulator) addDelta(delta *schemas.ChatStreamResponseChoiceDelta, onTextDelta func(string)) {
	if delta == nil {
		return
	}
	if delta.Content != nil && *delta.Content != "" {
		a.textBuf.WriteString(*delta.Content)
		if onTextDelta != nil {
			onTextDelta(*delta.Content)
		}
	}

	for _, tc := range delta.ToolCalls {
		if a.calls == nil {
			a.calls = map[uint16]*buildingToolCall{}
		}
		b, ok := a.calls[tc.Index]
		if !ok {
			b = &buildingToolCall{}
			a.calls[tc.Index] = b
			a.order = append(a.order, tc.Index)
		}
		if tc.ID != nil && *tc.ID != "" {
			b.id = *tc.ID
		}
		if tc.Function.Name != nil && *tc.Function.Name != "" {
			b.name = *tc.Function.Name
		}
		b.args.WriteString(tc.Function.Arguments)
	}
}

func (a *stepAccumulator) setUsage(u *Usage) {
	a.usage = u
}

func (a *stepAccumulator) finish() *StepResult {
	result := &StepResult{Text: a.textBuf.String(), Usage: a.usage}
	for _, idx := range a.order {
		b := a.calls[idx]
		result.ToolCalls = append(result.ToolCalls, ToolCall{ID: b.id, Name: b.name, Arguments: b.args.String()})
	}
	return result
}

// StreamStep sends one ChatCompletionStreamRequest with tools attached
// (same request shape a non-streaming call would build, toolChoice
// "auto") and reports the resulting StepResult -- over Bifrost's real
// network stream, calling onTextDelta as each text fragment arrives so the
// caller (tool_loop.go) can write it straight to the client instead of
// waiting for the whole reply and re-chunking it after the fact (this
// package's earlier GenerateStep did exactly that, word-chunking a
// blocking non-streaming response to fake an incremental feel;
// StreamStep replaces it with a real incremental stream).
func (c *Client) StreamStep(ctx context.Context, resolved ResolvedModel, system string, messages []Message, toolSpecs []ToolSpec, onTextDelta func(string)) (*StepResult, error) {
	tools, err := buildChatTools(toolSpecs)
	if err != nil {
		return nil, err
	}

	bctx := schemas.NewBifrostContext(ctx, schemas.NoDeadline)
	req := &schemas.BifrostChatRequest{
		Provider: resolved.Provider,
		Model:    resolved.BifrostModel,
		Input:    toBifrostMessages(system, messages),
	}
	if len(tools) > 0 {
		auto := "auto"
		req.Params = &schemas.ChatParameters{
			Tools:      tools,
			ToolChoice: &schemas.ChatToolChoice{ChatToolChoiceStr: &auto},
		}
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
			return nil, toError(sc.BifrostError)
		}
		if sc.BifrostChatResponse == nil {
			continue
		}
		for _, choice := range sc.BifrostChatResponse.Choices {
			if choice.ChatStreamResponseChoice == nil {
				continue
			}
			acc.addDelta(choice.ChatStreamResponseChoice.Delta, onTextDelta)
		}
		if u := sc.BifrostChatResponse.Usage; u != nil {
			acc.setUsage(&Usage{PromptTokens: u.PromptTokens, CompletionTokens: u.CompletionTokens, TotalTokens: u.TotalTokens})
		}
	}

	return acc.finish(), nil
}
