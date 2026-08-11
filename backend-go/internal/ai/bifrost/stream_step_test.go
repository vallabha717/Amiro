package bifrostai

import (
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
)

func strPtr(s string) *string { return &s }

func TestStepAccumulator_JoinsTextDeltasAndInvokesCallback(t *testing.T) {
	var acc stepAccumulator
	var seen []string
	onDelta := func(d string) { seen = append(seen, d) }

	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{Content: strPtr("Hello")}, onDelta)
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{Content: strPtr(", world")}, onDelta)
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{Content: strPtr("!")}, onDelta)

	result := acc.finish()
	if result.Text != "Hello, world!" {
		t.Fatalf("Text = %q, want %q", result.Text, "Hello, world!")
	}
	if len(seen) != 3 || seen[0] != "Hello" || seen[2] != "!" {
		t.Fatalf("onTextDelta calls = %v, want each fragment individually", seen)
	}
}

func TestStepAccumulator_EmptyOrNilContentNeverInvokesCallback(t *testing.T) {
	var acc stepAccumulator
	called := false
	onDelta := func(string) { called = true }

	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{Content: strPtr("")}, onDelta)
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{}, onDelta)
	acc.addDelta(nil, onDelta)

	if called {
		t.Fatal("onTextDelta should never fire for empty/nil content")
	}
	if acc.finish().Text != "" {
		t.Fatalf("Text = %q, want empty", acc.finish().Text)
	}
}

func TestStepAccumulator_AssemblesOneToolCallAcrossFragmentedDeltas(t *testing.T) {
	var acc stepAccumulator

	// First chunk: id + name, empty/partial arguments (typical OpenAI-style
	// streaming shape -- id and name arrive once, arguments accumulate).
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{
		ToolCalls: []schemas.ChatAssistantMessageToolCall{{
			Index: 0, ID: strPtr("call_1"),
			Function: schemas.ChatAssistantMessageToolCallFunction{Name: strPtr("webSearch"), Arguments: `{"qu`},
		}},
	}, nil)
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{
		ToolCalls: []schemas.ChatAssistantMessageToolCall{{
			Index:    0,
			Function: schemas.ChatAssistantMessageToolCallFunction{Arguments: `ery":"go"`},
		}},
	}, nil)
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{
		ToolCalls: []schemas.ChatAssistantMessageToolCall{{
			Index:    0,
			Function: schemas.ChatAssistantMessageToolCallFunction{Arguments: `}`},
		}},
	}, nil)

	result := acc.finish()
	if len(result.ToolCalls) != 1 {
		t.Fatalf("got %d tool calls, want 1: %+v", len(result.ToolCalls), result.ToolCalls)
	}
	call := result.ToolCalls[0]
	if call.ID != "call_1" || call.Name != "webSearch" {
		t.Fatalf("got id=%q name=%q, want call_1/webSearch", call.ID, call.Name)
	}
	if call.Arguments != `{"query":"go"}` {
		t.Fatalf("got arguments %q, want the fully assembled JSON", call.Arguments)
	}
}

func TestStepAccumulator_InterleavedToolCallsByIndexDontCrossContaminate(t *testing.T) {
	var acc stepAccumulator

	// Two tool calls streamed interleaved (index 0 and 1 alternating),
	// mirroring a real provider emitting parallel tool calls.
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{ToolCalls: []schemas.ChatAssistantMessageToolCall{
		{Index: 0, ID: strPtr("call_a"), Function: schemas.ChatAssistantMessageToolCallFunction{Name: strPtr("toolA"), Arguments: `{"x":1`}},
	}}, nil)
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{ToolCalls: []schemas.ChatAssistantMessageToolCall{
		{Index: 1, ID: strPtr("call_b"), Function: schemas.ChatAssistantMessageToolCallFunction{Name: strPtr("toolB"), Arguments: `{"y":2`}},
	}}, nil)
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{ToolCalls: []schemas.ChatAssistantMessageToolCall{
		{Index: 0, Function: schemas.ChatAssistantMessageToolCallFunction{Arguments: `}`}},
	}}, nil)
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{ToolCalls: []schemas.ChatAssistantMessageToolCall{
		{Index: 1, Function: schemas.ChatAssistantMessageToolCallFunction{Arguments: `}`}},
	}}, nil)

	result := acc.finish()
	if len(result.ToolCalls) != 2 {
		t.Fatalf("got %d tool calls, want 2: %+v", len(result.ToolCalls), result.ToolCalls)
	}
	// order preserved by first-seen index (0 before 1)
	if result.ToolCalls[0].ID != "call_a" || result.ToolCalls[0].Arguments != `{"x":1}` {
		t.Fatalf("call 0 = %+v, want call_a with {\"x\":1}", result.ToolCalls[0])
	}
	if result.ToolCalls[1].ID != "call_b" || result.ToolCalls[1].Arguments != `{"y":2}` {
		t.Fatalf("call 1 = %+v, want call_b with {\"y\":2}", result.ToolCalls[1])
	}
}

func TestStepAccumulator_UsageFromLastSetWins(t *testing.T) {
	var acc stepAccumulator
	acc.setUsage(&Usage{TotalTokens: 10})
	acc.setUsage(&Usage{TotalTokens: 42})

	result := acc.finish()
	if result.Usage == nil || result.Usage.TotalTokens != 42 {
		t.Fatalf("got usage %+v, want the last-set value", result.Usage)
	}
}

func TestStepAccumulator_NoUsageEverSetLeavesItNil(t *testing.T) {
	var acc stepAccumulator
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{Content: strPtr("hi")}, nil)
	if acc.finish().Usage != nil {
		t.Fatal("expected nil usage when setUsage was never called")
	}
}
