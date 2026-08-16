package bifrostai

import "github.com/maximhq/bifrost/core/schemas"

// isTerminalFinishReason reports whether a streamed choice's finish_reason
// means the model is done producing this turn.
//
// This exists to work around a real, observed hang. Bifrost's SSE reader
// ends a stream when it sees OpenAI's `data: [DONE]` sentinel -- but that
// sentinel is a convention, not a requirement, and not every
// OpenAI-compatible gateway emits it. The Nous Research inference gateway
// (an OpenRouter-backed endpoint) sends a final chunk carrying
// finish_reason "stop" plus a usage block and then simply stops writing,
// leaving the keep-alive connection open. Bifrost's reader blocks on the
// next read, our `for range stream` never sees the channel close, and the
// user's chat sits there with a complete answer on screen and a spinner
// that never stops -- until some upstream idle timeout minutes later.
//
// Every stream consumer in this package therefore treats a terminal
// finish_reason as end-of-turn in its own right and cancels the Bifrost
// context, which closes the channel and releases the reader. On a
// well-behaved provider this changes nothing: the [DONE] sentinel arrives
// immediately after the same chunk, so the stream was ending anyway.
func isTerminalFinishReason(reason *string) bool {
	if reason == nil {
		return false
	}
	switch schemas.BifrostFinishReason(*reason) {
	case schemas.BifrostFinishReasonStop,
		schemas.BifrostFinishReasonLength,
		schemas.BifrostFinishReasonToolCalls:
		return true
	}
	// Providers also send vendor-specific values here (Anthropic's
	// "end_turn"/"max_tokens", for one). Any non-empty finish_reason means
	// the turn is over as far as the model is concerned.
	return *reason != ""
}

// streamTurnFinished reports whether a whole streamed response marks the end
// of the turn, i.e. any of its choices carries a terminal finish_reason.
func streamTurnFinished(resp *schemas.BifrostChatResponse) bool {
	if resp == nil {
		return false
	}
	for _, choice := range resp.Choices {
		if isTerminalFinishReason(choice.FinishReason) {
			return true
		}
	}
	return false
}
