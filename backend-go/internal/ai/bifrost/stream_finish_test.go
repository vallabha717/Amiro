package bifrostai

import (
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
)

// strPtr is defined in stream_step_test.go, same package.

func TestIsTerminalFinishReason(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reason *string
		want   bool
	}{
		{"nil mid-stream", nil, false},
		{"empty mid-stream", strPtr(""), false},
		{"stop", strPtr("stop"), true},
		{"length", strPtr("length"), true},
		{"tool_calls", strPtr("tool_calls"), true},
		// Anthropic and several gateways use their own vocabulary here;
		// any non-empty value still means the turn is over.
		{"vendor-specific end_turn", strPtr("end_turn"), true},
	} {
		if got := isTerminalFinishReason(tc.reason); got != tc.want {
			t.Fatalf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

// The regression this guards: the Nous Research gateway ends a stream with a
// finish_reason chunk and never sends `data: [DONE]`, which left every
// consumer in this package blocked on an idle connection after a complete
// reply. See stream_finish.go.
func TestStreamTurnFinished_DetectsAGatewayThatEndsWithoutTheDoneSentinel(t *testing.T) {
	mid := &schemas.BifrostChatResponse{
		Choices: []schemas.BifrostResponseChoice{{
			ChatStreamResponseChoice: &schemas.ChatStreamResponseChoice{},
		}},
	}
	if streamTurnFinished(mid) {
		t.Fatalf("a chunk with no finish_reason must not end the turn")
	}

	final := &schemas.BifrostChatResponse{
		Choices: []schemas.BifrostResponseChoice{{
			FinishReason:             strPtr("stop"),
			ChatStreamResponseChoice: &schemas.ChatStreamResponseChoice{},
		}},
	}
	if !streamTurnFinished(final) {
		t.Fatalf("a chunk carrying finish_reason \"stop\" must end the turn")
	}

	if streamTurnFinished(nil) {
		t.Fatalf("a nil response must not end the turn")
	}
}
