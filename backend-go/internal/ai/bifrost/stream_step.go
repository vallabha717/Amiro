package bifrostai

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/maximhq/bifrost/core/schemas"
)

// StepHooks are the live callbacks a caller can attach to a streamed model
// turn. All are optional.
//
// The tool hooks exist so the client can render a tool call while it is
// still being written. Without them a turn that calls four chart tools
// shows nothing at all until the entire step lands and then paints all four
// at once -- the model streams tool arguments for several seconds, and that
// whole time is dead air on screen.
type StepHooks struct {
	// OnTextDelta receives each user-facing text fragment as it arrives.
	OnTextDelta func(delta string)

	// OnReasoningDelta receives a reasoning model's thinking as it streams.
	// Providers send this well before any content or tool call, so it is
	// what a client can show during the several seconds a reasoning model
	// spends before its first visible output.
	OnReasoningDelta func(delta string)

	// OnToolCallStart fires once per tool call, as soon as the provider
	// names it and before any arguments are known.
	OnToolCallStart func(id, name string)

	// OnToolCallDelta receives raw JSON argument fragments for a call, in
	// the order the provider emitted them.
	OnToolCallDelta func(id, argsDelta string)

	// OnToolCallReady fires when a call's arguments are complete. Providers
	// stream tool calls one after another, so this fires for call N as soon
	// as call N+1 begins -- letting the caller run and render call N while
	// the model is still writing call N+1. The last call of a step is
	// finalized when the stream ends.
	OnToolCallReady func(tc ToolCall)
}

func (h StepHooks) textDelta(s string) {
	if h.OnTextDelta != nil {
		h.OnTextDelta(s)
	}
}

// stepAccumulator folds a sequence of ChatStreamResponseChoiceDelta values
// into a StepResult -- split out from StreamStep as its own type so the
// index-keyed tool-call fragment assembly (the one genuinely tricky part
// of streaming) is directly unit-testable without a real Bifrost
// connection, the same reason internal/api/chat's tool loading logic lives
// in ordinary functions rather than inline in an HTTP handler.
type stepAccumulator struct {
	textBuf      strings.Builder
	reasoningBuf strings.Builder
	usage        *Usage

	calls    map[uint16]*buildingToolCall
	order    []uint16 // first-seen order, for deterministic ToolCalls output
	maxIndex uint16   // highest tool-call index seen so far

	hooks StepHooks
}

type buildingToolCall struct {
	id, name  string
	args      strings.Builder
	started   bool // OnToolCallStart already fired
	finalized bool // OnToolCallReady already fired
}

// addDelta folds one delta into the accumulator, invoking the text hook for
// any non-empty text fragment (never for tool-call fragments -- a tool
// call's streamed arguments aren't user-facing text).
//
// Tool-call deltas arrive fragmented and index-keyed (a provider streams a
// tool call's id/name once, then its arguments string across many chunks);
// this accumulates by ChatAssistantMessageToolCall.Index. A call is
// finalized as soon as a *later* index appears, which is how a step's
// earlier tool calls get executed and drawn while the model is still
// emitting the rest.
func (a *stepAccumulator) addDelta(delta *schemas.ChatStreamResponseChoiceDelta) {
	if delta == nil {
		return
	}
	if delta.Reasoning != nil && *delta.Reasoning != "" {
		a.reasoningBuf.WriteString(*delta.Reasoning)
		if a.hooks.OnReasoningDelta != nil {
			a.hooks.OnReasoningDelta(*delta.Reasoning)
		}
	}
	if delta.Content != nil && *delta.Content != "" {
		a.textBuf.WriteString(*delta.Content)
		a.hooks.textDelta(*delta.Content)
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
			if tc.Index > a.maxIndex {
				a.maxIndex = tc.Index
			}
		}
		if tc.ID != nil && *tc.ID != "" {
			b.id = *tc.ID
		}
		if tc.Function.Name != nil && *tc.Function.Name != "" {
			b.name = *tc.Function.Name
		}

		// Announce only once we know both id and name; providers send them
		// in the call's first fragment, so this is the same chunk in
		// practice.
		if !b.started && b.id != "" && b.name != "" {
			b.started = true
			if a.hooks.OnToolCallStart != nil {
				a.hooks.OnToolCallStart(b.id, b.name)
			}
		}

		if tc.Function.Arguments != "" {
			// Arguments arriving for a call already announced complete would
			// make the client re-parse a *partial* input over the whole one it
			// already has (the SDK re-runs parsePartialJson on every
			// tool-input-delta), so the call keeps the arguments it was
			// finalized with.
			if b.finalized {
				continue
			}
			b.args.WriteString(tc.Function.Arguments)
			if b.started && a.hooks.OnToolCallDelta != nil {
				a.hooks.OnToolCallDelta(b.id, tc.Function.Arguments)
			}
		}

		// Re-check after every fragment, not only when a new index appears: a
		// provider can deliver a call's last argument fragment in the same
		// chunk that opens the next call, and (since delta.ToolCalls is not
		// ordered) can list the new call first.
		a.finalizeBefore(a.maxIndex)
	}
}

// finalizeBefore fires OnToolCallReady for every complete, not-yet-finalized
// call whose index is below idx.
func (a *stepAccumulator) finalizeBefore(idx uint16) {
	for _, i := range a.order {
		if i < idx {
			a.finalizeCall(i, false)
		}
	}
}

// finalizeCall announces one call as ready to run. atStreamEnd distinguishes
// the two things that can tell us a call is finished.
func (a *stepAccumulator) finalizeCall(idx uint16, atStreamEnd bool) {
	b, ok := a.calls[idx]
	if !ok || b.finalized || !b.started {
		return
	}
	// Mid-stream, a higher index having appeared is only a *hint* that this
	// call is done being written. Requiring the accumulated arguments to parse
	// turns the hint into evidence -- and a truncated prefix of a JSON object
	// never parses, so this is exact rather than heuristic. It matters because
	// finalizing early is not recoverable: executeToolCall falls back to `{}`
	// on unparseable arguments, and a chart tool invoked with `{}` renders
	// with no data at all. A call that is still incomplete here is simply held
	// until the stream ends, costing it its early render but never its
	// correctness.
	if !atStreamEnd && !json.Valid([]byte(b.args.String())) {
		return
	}
	b.finalized = true
	if a.hooks.OnToolCallReady != nil {
		a.hooks.OnToolCallReady(a.toolCall(b))
	}
}

// finalizeAll closes out whatever the stream ended mid-flight, which is
// always at least the step's last tool call.
func (a *stepAccumulator) finalizeAll() {
	for _, i := range a.order {
		a.finalizeCall(i, true)
	}
}

func (a *stepAccumulator) toolCall(b *buildingToolCall) ToolCall {
	return ToolCall{ID: b.id, Name: b.name, Arguments: b.args.String()}
}

func (a *stepAccumulator) setUsage(u *Usage) {
	a.usage = u
}

func (a *stepAccumulator) finish() *StepResult {
	a.finalizeAll()
	result := &StepResult{Text: a.textBuf.String(), Reasoning: a.reasoningBuf.String(), Usage: a.usage}
	for _, idx := range a.order {
		result.ToolCalls = append(result.ToolCalls, a.toolCall(a.calls[idx]))
	}
	return result
}

// StreamStep sends one ChatCompletionStreamRequest with tools attached
// (same request shape a non-streaming call would build, toolChoice
// "auto") and reports the resulting StepResult -- over Bifrost's real
// network stream, invoking hooks as each fragment arrives so the caller
// (tool_loop.go) can write text and tool activity straight to the client
// instead of waiting for the whole reply and re-chunking it after the fact.
func (c *Client) StreamStep(ctx context.Context, resolved ResolvedModel, system string, messages []Message, toolSpecs []ToolSpec, hooks StepHooks) (*StepResult, error) {
	tools, err := buildChatTools(toolSpecs)
	if err != nil {
		return nil, err
	}

	bctx := schemas.NewBifrostContext(ctx, schemas.NoDeadline)
	includeUsage := true
	req := &schemas.BifrostChatRequest{
		Provider: resolved.Provider,
		Model:    resolved.BifrostModel,
		Input:    toBifrostMessages(system, messages),
		Params: &schemas.ChatParameters{
			StreamOptions: &schemas.ChatStreamOptions{
				IncludeUsage: &includeUsage,
			},
		},
	}
	if len(tools) > 0 {
		auto := "auto"
		req.Params.Tools = tools
		req.Params.ToolChoice = &schemas.ChatToolChoice{ChatToolChoiceStr: &auto}
	}

	stream, bErr := c.bf.ChatCompletionStreamRequest(bctx, req)
	if bErr != nil {
		return nil, toError(bErr)
	}

	acc := stepAccumulator{hooks: hooks}
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
			acc.setUsage(&Usage{PromptTokens: u.PromptTokens, CompletionTokens: u.CompletionTokens, TotalTokens: u.TotalTokens})
		}
		// See stream_finish.go: without this, a gateway that never sends
		// [DONE] leaves the chat's tool loop blocked after a complete reply.
		if streamTurnFinished(sc.BifrostChatResponse) {
			bctx.Cancel()
			break
		}
	}

	res := acc.finish()
	if res != nil && (res.Usage == nil || res.Usage.PromptTokens == 0) {
		estPrompt := EstimatePromptTokens(system, messages, toolSpecs)
		estCompletion := EstimateCompletionTokens(res.Text, res.Reasoning, res.ToolCalls)
		if res.Usage == nil {
			res.Usage = &Usage{
				PromptTokens:     estPrompt,
				CompletionTokens: estCompletion,
				TotalTokens:      estPrompt + estCompletion,
			}
		} else {
			if res.Usage.PromptTokens == 0 {
				res.Usage.PromptTokens = estPrompt
			}
			if res.Usage.CompletionTokens == 0 {
				res.Usage.CompletionTokens = estCompletion
			}
			if res.Usage.TotalTokens == 0 {
				res.Usage.TotalTokens = res.Usage.PromptTokens + res.Usage.CompletionTokens
			}
		}
	}

	return res, nil
}
