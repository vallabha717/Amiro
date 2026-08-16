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

func readTool(name string, out any) tools.Definition {
	return tools.Definition{
		Name: name,
		Risk: tools.RiskRead,
		Execute: func(ctx context.Context, _ json.RawMessage) (any, error) {
			return out, nil
		},
	}
}

func writeTool(name string, ran *atomic.Int32) tools.Definition {
	return tools.Definition{
		Name: name,
		Risk: tools.RiskWrite,
		Execute: func(ctx context.Context, _ json.RawMessage) (any, error) {
			ran.Add(1)
			return "wrote", nil
		},
	}
}

func taskInput(t *testing.T, prompt string) json.RawMessage {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"description": "an investigation", "prompt": prompt})
	return raw
}

// The whole point of a subagent: the parent's context grows by the answer,
// not by the search. If the child's file reads leaked into the parent's
// history, this would be an expensive way to do nothing.
func TestSubagent_ReturnsOnlyItsFinalTextToTheParent(t *testing.T) {
	const secret = "THE ENTIRE CONTENTS OF A VERY LARGE FILE"
	parentTools := []tools.Definition{readTool(tools.NameReadFile, map[string]any{"content": secret})}

	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{{ID: "c1", Name: tools.NameReadFile, Arguments: `{"path":"big.go"}`}}},
		{Text: "auth lives in internal/auth/service.go"},
	}}

	task, ok := subagentTool(engine, bifrostai.ResolvedModel{}, parentTools, permission.New(permission.ModeInteractive, nil, nil, nil))
	if !ok {
		t.Fatal("subagentTool did not build")
	}

	out, err := task.Execute(context.Background(), taskInput(t, "where does auth live?"))
	if err != nil {
		t.Fatalf("task: %v", err)
	}
	result := out.(SubagentOutput)

	if result.Result != "auth lives in internal/auth/service.go" {
		t.Fatalf("Result = %q, want the child's final text", result.Result)
	}
	blob, _ := json.Marshal(result)
	if strings.Contains(string(blob), secret) {
		t.Fatalf("the child's file contents leaked into the parent's tool result:\n%s", blob)
	}
	if result.Steps != 2 {
		t.Fatalf("Steps = %d, want 2 -- the presenter reports this", result.Steps)
	}
}

// A subagent runs unwatched: no cards, no approval prompts, nothing in the
// transcript until it is done. Giving that loop write or exec access would
// undo Phase 3 through the side door.
func TestSubagent_ChildCannotReachConsequentialTools(t *testing.T) {
	var writes atomic.Int32
	parentTools := []tools.Definition{
		readTool(tools.NameReadFile, "ok"),
		writeTool(tools.NameWriteFile, &writes),
		writeTool(tools.NameRunShell, &writes),
		writeTool(tools.NameGit, &writes),
	}

	// The child tries to write on its first step.
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{{ID: "c1", Name: tools.NameWriteFile, Arguments: `{"path":"a.txt"}`}}},
		{Text: "done"},
	}}

	task, _ := subagentTool(engine, bifrostai.ResolvedModel{}, parentTools, permission.New(permission.ModeAuto, nil, nil, nil))
	if _, err := task.Execute(context.Background(), taskInput(t, "write a file")); err != nil {
		t.Fatalf("task: %v", err)
	}

	// Auto mode, so the permission engine would have allowed it. What stops
	// it is that the tool was never offered to the child at all.
	if got := writes.Load(); got != 0 {
		t.Fatalf("a subagent ran %d consequential tools; its subset must be read-only", got)
	}
}

// Recursion is prevented structurally rather than by a depth counter: the
// child's subset is a fixed list of read tools, and `task` is not on it.
func TestSubagent_CannotSpawnASubagent(t *testing.T) {
	if subagentToolNames[tools.NameTask] {
		t.Fatal("task is in the child's tool subset -- subagents could recurse without bound")
	}
	for name := range subagentToolNames {
		def, ok := tools.FindByName([]tools.Definition{
			readTool(tools.NameReadFile, nil), readTool(tools.NameListDir, nil),
			readTool(tools.NameGlob, nil), readTool(tools.NameGrep, nil),
			readTool(tools.NameWebSearch, nil), readTool(tools.NameWebContent, nil),
		}, name)
		if !ok {
			t.Fatalf("%s is in the subagent subset but is not a known read tool", name)
		}
		if def.Risk.Consequential() {
			t.Fatalf("%s is in the subagent subset and is consequential", name)
		}
	}
}

// No read tools this turn means no `task` tool: a subagent with nothing to
// explore with is a slower, more confusing way to ask the model directly.
func TestSubagent_NotOfferedWithoutReadTools(t *testing.T) {
	var writes atomic.Int32
	if _, ok := subagentTool(nil, bifrostai.ResolvedModel{}, []tools.Definition{writeTool(tools.NameWriteFile, &writes)}, nil); ok {
		t.Fatal("task offered with no read tools available to delegate")
	}
}

// A child that spends its budget on tools and never writes a conclusion has
// produced nothing. The parent must not read that as "no findings".
func TestSubagent_SaysSoWhenTheChildNeverConcluded(t *testing.T) {
	parentTools := []tools.Definition{readTool(tools.NameGrep, "some hits")}
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{{ID: "c1", Name: tools.NameGrep, Arguments: `{}`}}},
		{}, // the child stops without ever writing a conclusion
	}}

	task, _ := subagentTool(engine, bifrostai.ResolvedModel{}, parentTools, nil)
	out, err := task.Execute(context.Background(), taskInput(t, "find something"))
	if err != nil {
		t.Fatalf("task: %v", err)
	}
	result := out.(SubagentOutput)
	if result.Result != "" {
		t.Fatalf("Result = %q, want empty", result.Result)
	}
	if !strings.Contains(result.Notice, "no answer") {
		t.Fatalf("Notice = %q, want it to say this is not an empty result", result.Notice)
	}
}

func TestSubagent_RequiresASelfContainedPrompt(t *testing.T) {
	task, _ := subagentTool(nil, bifrostai.ResolvedModel{}, []tools.Definition{readTool(tools.NameReadFile, nil)}, nil)
	raw, _ := json.Marshal(map[string]any{"description": "look at it"})
	if _, err := task.Execute(context.Background(), raw); err == nil {
		t.Fatal("got nil error for an empty prompt -- the child cannot see the conversation")
	}
}

// The child's steps must not appear in the parent's stream. It writes to a
// discard writer for exactly this reason.
func TestSubagent_WritesNothingToTheParentStream(t *testing.T) {
	parentTools := []tools.Definition{readTool(tools.NameReadFile, "contents")}
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{{ID: "c1", Name: tools.NameReadFile, Arguments: `{}`}}},
		{Text: "the answer"},
	}}

	rec := httptest.NewRecorder()
	sw := uimessage.NewWriter(rec)
	_ = sw.Start("parent-message")

	task, _ := subagentTool(engine, bifrostai.ResolvedModel{}, parentTools, nil)
	if _, err := task.Execute(context.Background(), taskInput(t, "go look")); err != nil {
		t.Fatalf("task: %v", err)
	}

	if body := rec.Body.String(); strings.Contains(body, tools.NameReadFile) {
		t.Fatalf("the child's tool frames reached the parent's stream:\n%s", body)
	}
}
