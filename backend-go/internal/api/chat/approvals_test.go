package chat

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"amiro/backend/internal/agent/permission"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/uimessage"
)

// countingTool is a write-risk tool that records how many times it actually
// ran. Every test here turns on whether it ran when it should not have, or
// failed to run when it should have.
func countingTool(name string, runs *atomic.Int32) tools.Definition {
	return tools.Definition{
		Name: name,
		Risk: tools.RiskWrite,
		Execute: func(ctx context.Context, in json.RawMessage) (any, error) {
			runs.Add(1)
			return map[string]any{"ran": name}, nil
		},
	}
}

func partsOf(t *testing.T, raw json.RawMessage) []map[string]any {
	t.Helper()
	var parts []map[string]any
	if err := json.Unmarshal(raw, &parts); err != nil {
		t.Fatalf("parts: %v", err)
	}
	return parts
}

// The gap Phase 3 closes, stated as a test: a write must not happen just
// because the model asked for it.
func TestToolLoop_WriteSuspendsInsteadOfRunning(t *testing.T) {
	var runs atomic.Int32
	activeTools := []tools.Definition{countingTool("write_file", &runs)}

	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{{ID: "call-1", Name: "write_file", Arguments: `{"path":"a.txt"}`}}},
		{Text: "should never be reached"},
	}}
	sw := uimessage.NewWriter(httptest.NewRecorder())

	perms := permission.New(permission.ModeInteractive, nil, nil, nil)
	result, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, activeTools, perms)
	if err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}
	if got := runs.Load(); got != 0 {
		t.Fatalf("tool ran %d times before approval, want 0", got)
	}

	parts := partsOf(t, result.Parts)
	var toolPart, approvalPart map[string]any
	for _, p := range parts {
		switch p["type"] {
		case "tool-write_file":
			toolPart = p
		case "data-tool-approval":
			approvalPart = p
		}
	}
	if toolPart == nil || toolPart["state"] != "input-available" {
		t.Fatalf("tool part = %+v, want state input-available", toolPart)
	}
	if approvalPart == nil {
		t.Fatal("no data-tool-approval part persisted -- a reloaded thread would show a stalled turn with no card")
	}
	if approvalPart["id"] != "call-1" {
		t.Fatalf("approval id = %v, want call-1 so the card can find its tool call", approvalPart["id"])
	}
	// The loop must stop, not carry on to the next step with a hole where
	// the tool result should be.
	if strings.Contains(result.Text, "should never be reached") {
		t.Fatalf("loop continued past the suspend: %q", result.Text)
	}
}

func TestToolLoop_PlanModeRefusesAndTellsTheModelWhy(t *testing.T) {
	var runs atomic.Int32
	activeTools := []tools.Definition{countingTool("write_file", &runs)}

	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{{ID: "call-1", Name: "write_file", Arguments: `{"path":"a.txt"}`}}},
		{Text: "ok, here is what I would change"},
	}}
	sw := uimessage.NewWriter(httptest.NewRecorder())

	perms := permission.New(permission.ModePlan, nil, nil, nil)
	result, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, activeTools, perms)
	if err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}
	if got := runs.Load(); got != 0 {
		t.Fatalf("tool ran %d times in plan mode, want 0", got)
	}

	// A refusal is a tool *result*, not a stream error: the turn continues
	// so the model can say what it would have done.
	var found bool
	for _, p := range partsOf(t, result.Parts) {
		if p["type"] == "tool-write_file" {
			found = true
			if p["state"] != "output-error" {
				t.Fatalf("state = %v, want output-error", p["state"])
			}
			if txt, _ := p["errorText"].(string); !strings.Contains(txt, "plan mode is read-only") {
				t.Fatalf("errorText = %q, want it to explain the mode", txt)
			}
		}
	}
	if !found {
		t.Fatal("no tool part recorded for the refused call")
	}
	if !strings.Contains(result.Text, "here is what I would change") {
		t.Fatalf("turn did not continue after the refusal: %q", result.Text)
	}
}

// The resume half. The browser answers by writing a confirmation where the
// tool's output goes; without this pass the model would be handed the
// confirmation itself as if it were the tool's result.
func TestResolveApprovals_RunsTheApprovedCallAndReplacesTheAnswer(t *testing.T) {
	var runs atomic.Int32
	activeTools := []tools.Definition{countingTool("write_file", &runs)}

	msg := &uiMessage{
		ID:   "assistant-1",
		Role: "assistant",
		Parts: []json.RawMessage{
			json.RawMessage(`{"type":"text","text":"I'll write that file."}`),
			json.RawMessage(`{"type":"tool-write_file","toolCallId":"call-1","state":"output-available",` +
				`"input":{"path":"a.txt"},"output":{"__tag":"manual-tool-confirm","confirm":true}}`),
		},
	}

	perms := permission.New(permission.ModeInteractive, nil, nil, permission.NewStore().For("thread-1"))
	resolveApprovals(context.Background(), msg, activeTools, perms)

	if got := runs.Load(); got != 1 {
		t.Fatalf("tool ran %d times after approval, want 1", got)
	}
	var part map[string]any
	if err := json.Unmarshal(msg.Parts[1], &part); err != nil {
		t.Fatal(err)
	}
	if part["state"] != "output-available" {
		t.Fatalf("state = %v, want output-available", part["state"])
	}
	out, _ := part["output"].(map[string]any)
	if out["ran"] != "write_file" {
		t.Fatalf("output = %+v, want the tool's real result, not the confirmation", part["output"])
	}
}

func TestResolveApprovals_RejectionBecomesAReadableResultAndRunsNothing(t *testing.T) {
	var runs atomic.Int32
	activeTools := []tools.Definition{countingTool("write_file", &runs)}

	msg := &uiMessage{
		ID:   "assistant-1",
		Role: "assistant",
		Parts: []json.RawMessage{
			json.RawMessage(`{"type":"tool-write_file","toolCallId":"call-1","state":"output-available",` +
				`"input":{"path":"a.txt"},"output":{"__tag":"manual-tool-confirm","confirm":false}}`),
		},
	}

	perms := permission.New(permission.ModeInteractive, nil, nil, permission.NewStore().For("thread-1"))
	resolveApprovals(context.Background(), msg, activeTools, perms)

	if got := runs.Load(); got != 0 {
		t.Fatalf("tool ran %d times after rejection, want 0", got)
	}
	var part map[string]any
	if err := json.Unmarshal(msg.Parts[0], &part); err != nil {
		t.Fatal(err)
	}
	if part["state"] != "output-error" {
		t.Fatalf("state = %v, want output-error", part["state"])
	}
	if txt, _ := part["errorText"].(string); !strings.Contains(txt, "declined") {
		t.Fatalf("errorText = %q, want it to say the user declined", txt)
	}
}

// "Always allow" has to outlive the request it was given in, or the very
// next call asks again and the option means nothing.
func TestResolveApprovals_AlwaysGrantsSurviveIntoTheNextTurn(t *testing.T) {
	var runs atomic.Int32
	activeTools := []tools.Definition{countingTool("write_file", &runs)}

	store := permission.NewStore()
	perms := permission.New(permission.ModeInteractive, nil, nil, store.For("thread-1"))

	msg := &uiMessage{
		ID:   "assistant-1",
		Role: "assistant",
		Parts: []json.RawMessage{
			json.RawMessage(`{"type":"tool-write_file","toolCallId":"call-1","state":"output-available",` +
				`"input":{"path":"a.txt"},"output":{"__tag":"manual-tool-confirm","confirm":true,"scope":"always"}}`),
		},
	}
	resolveApprovals(context.Background(), msg, activeTools, perms)

	// A fresh engine for the next request, sharing only the store -- exactly
	// how route.go rebuilds it per request.
	next := permission.New(permission.ModeInteractive, nil, nil, store.For("thread-1"))
	d := next.Evaluate(permission.CallFor(activeTools[0], json.RawMessage(`{"path":"b.txt"}`)))
	if !d.Allowed {
		t.Fatalf("next turn: got %+v, want allowed by the standing grant", d)
	}

	// And it is scoped to the thread it was given in.
	other := permission.New(permission.ModeInteractive, nil, nil, store.For("thread-2"))
	if d := other.Evaluate(permission.CallFor(activeTools[0], json.RawMessage(`{"path":"b.txt"}`))); !d.NeedsUser {
		t.Fatalf("other thread: got %+v, want needsUser -- a grant must not leak across conversations", d)
	}
}

// A command-shaped "always" grants the command, not the tool. Approving
// `go test ./...` forever must not hand the agent the shell.
func TestResolveApprovals_AlwaysOnACommandDoesNotGrantTheTool(t *testing.T) {
	var runs atomic.Int32
	shell := tools.Definition{
		Name: "run_shell",
		Risk: tools.RiskExec,
		Execute: func(ctx context.Context, in json.RawMessage) (any, error) {
			runs.Add(1)
			return map[string]any{"ok": true}, nil
		},
	}

	store := permission.NewStore()
	perms := permission.New(permission.ModeInteractive, nil, nil, store.For("thread-1"))

	msg := &uiMessage{
		ID:   "assistant-1",
		Role: "assistant",
		Parts: []json.RawMessage{
			json.RawMessage(`{"type":"tool-run_shell","toolCallId":"call-1","state":"output-available",` +
				`"input":{"command":"go test ./..."},"output":{"__tag":"manual-tool-confirm","confirm":true,"scope":"always"}}`),
		},
	}
	resolveApprovals(context.Background(), msg, []tools.Definition{shell}, perms)

	next := permission.New(permission.ModeInteractive, nil, nil, store.For("thread-1"))
	if d := next.Evaluate(permission.CallFor(shell, json.RawMessage(`{"command":"go test ./..."}`))); !d.Allowed {
		t.Fatalf("same command: got %+v, want allowed", d)
	}
	if d := next.Evaluate(permission.CallFor(shell, json.RawMessage(`{"command":"rm -rf /"}`))); !d.NeedsUser {
		t.Fatalf("different command: got %+v, want needsUser -- approving one command is not approving the shell", d)
	}
}
