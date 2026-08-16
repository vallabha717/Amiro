package bifrostai

import (
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
)

func strPtr(s string) *string { return &s }

func TestStepAccumulator_JoinsTextDeltasAndInvokesCallback(t *testing.T) {
	var seen []string
	acc := stepAccumulator{hooks: StepHooks{OnTextDelta: func(d string) { seen = append(seen, d) }}}

	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{Content: strPtr("Hello")})
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{Content: strPtr(", world")})
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{Content: strPtr("!")})

	result := acc.finish()
	if result.Text != "Hello, world!" {
		t.Fatalf("Text = %q, want %q", result.Text, "Hello, world!")
	}
	if len(seen) != 3 || seen[0] != "Hello" || seen[2] != "!" {
		t.Fatalf("onTextDelta calls = %v, want each fragment individually", seen)
	}
}

func TestStepAccumulator_EmptyOrNilContentNeverInvokesCallback(t *testing.T) {
	called := false
	acc := stepAccumulator{hooks: StepHooks{OnTextDelta: func(string) { called = true }}}

	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{Content: strPtr("")})
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{})
	acc.addDelta(nil)

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
	})
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{
		ToolCalls: []schemas.ChatAssistantMessageToolCall{{
			Index:    0,
			Function: schemas.ChatAssistantMessageToolCallFunction{Arguments: `ery":"go"`},
		}},
	})
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{
		ToolCalls: []schemas.ChatAssistantMessageToolCall{{
			Index:    0,
			Function: schemas.ChatAssistantMessageToolCallFunction{Arguments: `}`},
		}},
	})

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
	}})
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{ToolCalls: []schemas.ChatAssistantMessageToolCall{
		{Index: 1, ID: strPtr("call_b"), Function: schemas.ChatAssistantMessageToolCallFunction{Name: strPtr("toolB"), Arguments: `{"y":2`}},
	}})
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{ToolCalls: []schemas.ChatAssistantMessageToolCall{
		{Index: 0, Function: schemas.ChatAssistantMessageToolCallFunction{Arguments: `}`}},
	}})
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{ToolCalls: []schemas.ChatAssistantMessageToolCall{
		{Index: 1, Function: schemas.ChatAssistantMessageToolCallFunction{Arguments: `}`}},
	}})

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
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{Content: strPtr("hi")})
	if acc.finish().Usage != nil {
		t.Fatal("expected nil usage when setUsage was never called")
	}
}

// The behaviour that makes a four-chart turn paint one chart at a time
// instead of nothing-then-everything: a tool call is finalized as soon as
// the *next* one starts, so the caller can run and render it while the
// model is still writing the rest of the step.
func TestStepAccumulator_FinalizesEachToolCallAsTheNextOneBegins(t *testing.T) {
	var started []string
	var ready []string
	acc := stepAccumulator{hooks: StepHooks{
		OnToolCallStart: func(_, name string) { started = append(started, name) },
		OnToolCallReady: func(tc ToolCall) { ready = append(ready, tc.Name+":"+tc.Arguments) },
	}}

	begin := func(idx uint16, id, name, args string) {
		acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{
			ToolCalls: []schemas.ChatAssistantMessageToolCall{{
				Index: idx, ID: strPtr(id),
				Function: schemas.ChatAssistantMessageToolCallFunction{Name: strPtr(name), Arguments: args},
			}},
		})
	}

	begin(0, "call_1", "createPieChart", `{"a":1}`)
	if len(started) != 1 || started[0] != "createPieChart" {
		t.Fatalf("started = %v, want the first call announced immediately", started)
	}
	if len(ready) != 0 {
		t.Fatalf("ready = %v, want nothing finalized while the first call is still open", ready)
	}

	// The second call beginning is what proves the first one is complete.
	begin(1, "call_2", "createBarChart", `{"b":2}`)
	if len(ready) != 1 || ready[0] != `createPieChart:{"a":1}` {
		t.Fatalf("ready = %v, want the first call finalized once the second began", ready)
	}

	begin(2, "call_3", "createTable", `{"c":3}`)
	if len(ready) != 2 || ready[1] != `createBarChart:{"b":2}` {
		t.Fatalf("ready = %v, want the second call finalized once the third began", ready)
	}

	// The stream ending finalizes whatever is still open.
	result := acc.finish()
	if len(ready) != 3 || ready[2] != `createTable:{"c":3}` {
		t.Fatalf("ready = %v, want the last call finalized at stream end", ready)
	}
	if len(result.ToolCalls) != 3 {
		t.Fatalf("got %d tool calls in the result, want 3", len(result.ToolCalls))
	}
}

// Found live: a chart tool rendered with no data at all, crashing the chat.
// The next call opening is only a hint that the previous one is done -- a
// provider can put a call's last argument fragment in the same chunk that
// opens its successor, and delta.ToolCalls is not ordered, so the successor
// can be listed first. Finalizing on that hint alone hands the client
// truncated JSON, which executeToolCall degrades to `{}`.
func TestStepAccumulator_NeverFinalizesACallWithIncompleteArguments(t *testing.T) {
	var ready []ToolCall
	acc := stepAccumulator{hooks: StepHooks{
		OnToolCallReady: func(tc ToolCall) { ready = append(ready, tc) },
	}}

	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{
		ToolCalls: []schemas.ChatAssistantMessageToolCall{{
			Index: 0, ID: strPtr("call_1"),
			Function: schemas.ChatAssistantMessageToolCallFunction{Name: strPtr("createLineChart"), Arguments: `{"title":"t"`},
		}},
	})
	// One chunk carrying the next call's header *before* the tail of the
	// previous call's arguments.
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{
		ToolCalls: []schemas.ChatAssistantMessageToolCall{
			{
				Index: 1, ID: strPtr("call_2"),
				Function: schemas.ChatAssistantMessageToolCallFunction{Name: strPtr("createTable"), Arguments: `{"rows":[]}`},
			},
			{
				Index:    0,
				Function: schemas.ChatAssistantMessageToolCallFunction{Arguments: `,"data":[1,2]}`},
			},
		},
	})

	if len(ready) != 1 {
		t.Fatalf("ready = %+v, want exactly the completed first call", ready)
	}
	if ready[0].ID != "call_1" || ready[0].Arguments != `{"title":"t","data":[1,2]}` {
		t.Fatalf("got %+v, want call_1 finalized with its whole arguments", ready[0])
	}

	acc.finish()
	if len(ready) != 2 || ready[1].Arguments != `{"rows":[]}` {
		t.Fatalf("ready = %+v, want the second call finalized at stream end", ready)
	}
}

// Once a call has been announced complete, replaying more of its arguments
// would make the client re-parse a partial input over the whole one it
// already has (the AI SDK re-runs parsePartialJson on every input delta).
func TestStepAccumulator_IgnoresArgumentsAfterACallIsFinalized(t *testing.T) {
	var deltas []string
	acc := stepAccumulator{hooks: StepHooks{
		OnToolCallDelta: func(_, argsDelta string) { deltas = append(deltas, argsDelta) },
	}}

	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{
		ToolCalls: []schemas.ChatAssistantMessageToolCall{{
			Index: 0, ID: strPtr("call_1"),
			Function: schemas.ChatAssistantMessageToolCallFunction{Name: strPtr("toolA"), Arguments: `{"a":1}`},
		}},
	})
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{
		ToolCalls: []schemas.ChatAssistantMessageToolCall{{
			Index: 1, ID: strPtr("call_2"),
			Function: schemas.ChatAssistantMessageToolCallFunction{Name: strPtr("toolB"), Arguments: `{"b":2}`},
		}},
	})
	// Too late: call_1 was finalized when call_2 opened.
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{
		ToolCalls: []schemas.ChatAssistantMessageToolCall{{
			Index:    0,
			Function: schemas.ChatAssistantMessageToolCallFunction{Arguments: `{"stray":true}`},
		}},
	})

	result := acc.finish()
	if got := result.ToolCalls[0].Arguments; got != `{"a":1}` {
		t.Fatalf("call 0 arguments = %q, want the value it was finalized with", got)
	}
	for _, d := range deltas {
		if d == `{"stray":true}` {
			t.Fatalf("deltas = %v, want no input delta forwarded after finalization", deltas)
		}
	}
}

// A call must never be reported twice, however the provider fragments it.
func TestStepAccumulator_FinalizesEachToolCallExactlyOnce(t *testing.T) {
	var ready []string
	acc := stepAccumulator{hooks: StepHooks{
		OnToolCallReady: func(tc ToolCall) { ready = append(ready, tc.ID) },
	}}

	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{
		ToolCalls: []schemas.ChatAssistantMessageToolCall{{
			Index: 0, ID: strPtr("call_1"),
			Function: schemas.ChatAssistantMessageToolCallFunction{Name: strPtr("http"), Arguments: `{"url":`},
		}},
	})
	acc.addDelta(&schemas.ChatStreamResponseChoiceDelta{
		ToolCalls: []schemas.ChatAssistantMessageToolCall{{
			Index:    0,
			Function: schemas.ChatAssistantMessageToolCallFunction{Arguments: `"http://x"}`},
		}},
	})
	acc.finish()
	acc.finish() // a second finish must not re-fire anything

	if len(ready) != 1 || ready[0] != "call_1" {
		t.Fatalf("ready = %v, want exactly one finalization", ready)
	}
}

func TestEstimatePromptTokens(t *testing.T) {
	system := "You are a helpful AI assistant."
	messages := []Message{
		{Role: RoleUser, Text: "Hello world, what is the weather today?"},
		{Role: RoleAssistant, Text: "It is sunny.", ToolCalls: []ToolCall{{ID: "c1", Name: "getWeather", Arguments: `{"city":"Austin"}`}}},
		{Role: RoleTool, ToolCallID: "c1", Text: `{"temp": 75}`},
	}
	tools := []ToolSpec{
		{Name: "getWeather", Description: "Get current weather", ParametersSchema: []byte(`{"type":"object"}`)},
	}

	promptTokens := EstimatePromptTokens(system, messages, tools)
	if promptTokens <= 0 {
		t.Fatalf("expected positive prompt tokens estimate, got %d", promptTokens)
	}
}

func TestEstimateCompletionTokens(t *testing.T) {
	text := "The weather in Austin is sunny and 75 degrees."
	reasoning := "Checking temperature in city Austin."
	toolCalls := []ToolCall{
		{ID: "c2", Name: "formatOutput", Arguments: `{"format":"json"}`},
	}

	compTokens := EstimateCompletionTokens(text, reasoning, toolCalls)
	if compTokens <= 0 {
		t.Fatalf("expected positive completion tokens estimate, got %d", compTokens)
	}
}

func TestStepAccumulator_SetsUsageFromChunk(t *testing.T) {
	var acc stepAccumulator
	acc.setUsage(&Usage{PromptTokens: 120, CompletionTokens: 45, TotalTokens: 165})
	res := acc.finish()
	if res.Usage == nil || res.Usage.PromptTokens != 120 || res.Usage.CompletionTokens != 45 || res.Usage.TotalTokens != 165 {
		t.Fatalf("unexpected usage: %+v", res.Usage)
	}
}

