package chat

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/uimessage"
)

// fakeStreamEngine is a canned Engine, so runToolLoop tests exercise the
// step loop's control flow without a real Bifrost client. Each entry in
// steps is one StreamStep call's result, consumed in order.
type fakeStreamEngine struct {
	steps []bifrostai.StepResult
	calls int

	// blockUntilCtxDone, when true, makes StreamStep ignore steps entirely
	// and instead wait for ctx.Done() before returning ctx.Err() -- this
	// mirrors a real HTTP client that properly respects context
	// cancellation, so the test proves runToolLoop's own timeout actually
	// bounds the call rather than trusting an unbounded wait.
	blockUntilCtxDone bool
}

func (f *fakeStreamEngine) StreamStep(ctx context.Context, _ bifrostai.ResolvedModel, _ string, _ []bifrostai.Message, _ []bifrostai.ToolSpec, _ bifrostai.StepHooks) (*bifrostai.StepResult, error) {
	f.calls++
	if f.blockUntilCtxDone {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	step := f.steps[f.calls-1]
	return &step, nil
}

// Stream is unused by runToolLoop (only StreamStep is) but required to
// satisfy the Engine interface.
func (f *fakeStreamEngine) Stream(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message) (<-chan bifrostai.Chunk, error) {
	panic("not implemented")
}

// TestRunToolLoop_ModelCallTimesOutInsteadOfHangingForever guards against
// the bug found live immediately after the unknown-tool-name fix above: a
// tool-augmented follow-up model call (history includes a completed tool
// call + result) against a custom OpenAI-compatible endpoint hung with no
// data ever arriving, and nothing bounded it -- bifrost/core deliberately
// adds no deadline of its own (schemas.NoDeadline), and this app's request
// context has none either (only canceled by client disconnect, never by a
// timeout). A plain single-step chat against the same model worked fine,
// confirming the gap was specifically an unbounded model call, not MCP.
func TestRunToolLoop_ModelCallTimesOutInsteadOfHangingForever(t *testing.T) {
	orig := modelStepTimeout
	modelStepTimeout = 50 * time.Millisecond
	t.Cleanup(func() { modelStepTimeout = orig })

	engine := &fakeStreamEngine{blockUntilCtxDone: true}
	rec := httptest.NewRecorder()
	sw := uimessage.NewWriter(rec)

	start := time.Now()
	_, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, nil, testPerms(), nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("want an error once modelStepTimeout fires, got nil")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("err = %q, want it to mention the timeout", err)
	}
	if elapsed > time.Second {
		t.Fatalf("runToolLoop took %s, want it bounded by modelStepTimeout instead of hanging on the stalled model call", elapsed)
	}
}

// TestRunToolLoop_UnknownToolNameSurfacesErrorAndContinuesInsteadOfHangingForever
// guards against the exact bug found live: a model calling a tool name that
// isn't among activeTools (typo'd, hallucinated, or referencing an MCP tool
// that was renamed/removed after the model was given the original list) was
// being treated identically to a legitimate client-executed tool (nil
// Execute, e.g. code.go's JS/Python tools) -- both took the same
// "write input-available, stop generation, wait for the frontend to
// resubmit" path. For a real client tool the frontend knows to resubmit;
// for an unknown name nothing ever does, so the chat hung forever with no
// way to recover, Stop included (the HTTP response had already completed
// normally by that point). The fix: !found must surface as a tool
// execution error fed back to the model, exactly like a real Execute
// returning an error, so the loop continues instead of stalling.
func TestRunToolLoop_UnknownToolNameSurfacesErrorAndContinuesInsteadOfHangingForever(t *testing.T) {
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{{ID: "call-1", Name: "bogus-tool", Arguments: `{}`}}},
		{Text: "done"},
	}}
	rec := httptest.NewRecorder()
	sw := uimessage.NewWriter(rec)

	result, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, nil, testPerms(), nil)
	if err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}
	if engine.calls != 2 {
		t.Fatalf("StreamStep called %d times, want 2 -- an unknown tool name must not stop the loop after the first step", engine.calls)
	}
	if result.Text != "done" {
		t.Fatalf("Text = %q, want %q -- the loop must reach the second step's text", result.Text, "done")
	}
	if !strings.Contains(string(result.Parts), "output-error") {
		t.Fatalf("Parts = %s, want an output-error entry for the unknown tool call", result.Parts)
	}
	if !strings.Contains(string(result.Parts), "unknown tool") {
		t.Fatalf("Parts = %s, want the error text to name the problem", result.Parts)
	}
}

// TestRunToolLoop_ClientOnlyToolStillPausesGenerationForFrontendResubmit
// guards the other half of the same branch: a genuinely registered tool
// with a nil Execute (client-rendered, e.g. code.go's JS/Python tools) must
// keep pausing generation exactly as before -- the fix above must not turn
// this legitimate pause into an error too.
func TestRunToolLoop_ClientOnlyToolStillPausesGenerationForFrontendResubmit(t *testing.T) {
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{{ID: "call-1", Name: "client-tool", Arguments: `{}`}}},
	}}
	rec := httptest.NewRecorder()
	sw := uimessage.NewWriter(rec)
	activeTools := []tools.Definition{{Name: "client-tool", Execute: nil}}

	result, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, activeTools, testPerms(), nil)
	if err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}
	if engine.calls != 1 {
		t.Fatalf("StreamStep called %d times, want 1 -- a client-only tool must still pause after its step", engine.calls)
	}
	if !strings.Contains(string(result.Parts), "input-available") {
		t.Fatalf("Parts = %s, want an input-available entry, not an error", result.Parts)
	}
	if strings.Contains(string(result.Parts), "output-error") {
		t.Fatalf("Parts = %s, a legitimate client-only tool must not be treated as an error", result.Parts)
	}
}

func TestRunToolLoop_AccumulatesUsageAcrossMultipleSteps(t *testing.T) {
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{
			ToolCalls: []bifrostai.ToolCall{{ID: "call-1", Name: "server-tool", Arguments: `{}`}},
			Usage:     &bifrostai.Usage{PromptTokens: 500, CompletionTokens: 50, TotalTokens: 550},
		},
		{
			Text:  "Final answer",
			Usage: &bifrostai.Usage{PromptTokens: 800, CompletionTokens: 100, TotalTokens: 900},
		},
	}}
	rec := httptest.NewRecorder()
	sw := uimessage.NewWriter(rec)
	activeTools := []tools.Definition{{
		Name: "server-tool",
		Execute: func(ctx context.Context, args json.RawMessage) (any, error) {
			return map[string]string{"result": "ok"}, nil
		},
	}}

	result, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, activeTools, testPerms(), nil)
	if err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}
	if result.Usage == nil {
		t.Fatal("expected result.Usage to be non-nil")
	}
	if result.Usage.PromptTokens != 1300 {
		t.Fatalf("expected PromptTokens 1300, got %d", result.Usage.PromptTokens)
	}
	if result.Usage.CompletionTokens != 150 {
		t.Fatalf("expected CompletionTokens 150, got %d", result.Usage.CompletionTokens)
	}
	if result.Usage.TotalTokens != 1450 {
		t.Fatalf("expected TotalTokens 1450, got %d", result.Usage.TotalTokens)
	}
}

