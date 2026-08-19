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

// shellTool is a command-shaped tool, so the "always" tests can tell a
// grant on the command apart from a grant on the tool.
func shellTool(name string, runs *atomic.Int32) tools.Definition {
	return tools.Definition{
		Name: name,
		Risk: tools.RiskExec,
		CommandLine: func(input json.RawMessage) string {
			var in struct {
				Command string `json:"command"`
			}
			_ = json.Unmarshal(input, &in)
			return in.Command
		},
		Execute: func(context.Context, json.RawMessage) (any, error) {
			runs.Add(1)
			return "ran", nil
		},
	}
}

// loopWithApprover runs one gated call under ap and reports what happened.
func loopWithApprover(
	t *testing.T,
	ap Approver,
	defs []tools.Definition,
	perms *permission.Engine,
	calls []bifrostai.ToolCall,
) toolLoopResult {
	t.Helper()

	steps := []bifrostai.StepResult{{ToolCalls: calls}, {Text: "done"}}
	engine := &fakeStreamEngine{steps: steps}
	sw := uimessage.NewWriter(httptest.NewRecorder())

	ctx := WithApprover(context.Background(), ap)
	res, err := runToolLoop(ctx, engine, sw, bifrostai.ResolvedModel{}, "sys",
		[]bifrostai.Message{{Role: bifrostai.RoleUser, Text: "go"}}, defs, perms)
	if err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}
	return res
}

// TestApprover_AnswersInsteadOfSuspending is the whole point of the
// interface: a turn with nobody to ask can still finish.
//
// Without an Approver the same call suspends and waits for a client that,
// in a headless run, does not exist -- which is a turn that never ends.
func TestApprover_AnswersInsteadOfSuspending(t *testing.T) {
	cases := []struct {
		name       string
		answer     ApprovalAnswer
		wantRuns   int32
		wantInText string
	}{
		{"approved once", ApproveOnce(), 1, "done"},
		{"approved always", ApproveAlways(), 1, "done"},
		{"denied", DenyApproval(), 0, "done"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var runs atomic.Int32
			var asked int32

			ap := ApproverFunc(func(_ context.Context, req ApprovalRequest) (ApprovalAnswer, error) {
				atomic.AddInt32(&asked, 1)
				if req.ToolName != tools.NameRunShell {
					t.Errorf("asked about %q", req.ToolName)
				}
				if req.Command != "ls -la" {
					t.Errorf("Command = %q, want the command line the tool would run", req.Command)
				}
				if req.Risk == "" || req.Reason == "" {
					t.Errorf("request is missing the facts a reviewer decides on: %+v", req)
				}
				return tc.answer, nil
			})

			res := loopWithApprover(t, ap,
				[]tools.Definition{shellTool(tools.NameRunShell, &runs)},
				permission.New(permission.ModeInteractive, nil, nil, nil),
				[]bifrostai.ToolCall{{ID: "c1", Name: tools.NameRunShell, Arguments: `{"command":"ls -la"}`}},
			)

			if asked != 1 {
				t.Fatalf("approver asked %d times, want 1", asked)
			}
			if got := runs.Load(); got != tc.wantRuns {
				t.Errorf("tool ran %d times, want %d", got, tc.wantRuns)
			}
			// Either way the loop continues -- a denial is an answer, not a
			// dead end, and the model gets to say something about it.
			if !strings.Contains(res.Text, tc.wantInText) {
				t.Errorf("loop did not continue past the decision: %q", res.Text)
			}
		})
	}
}

// TestApprover_DenialTellsTheModelTheSameThingTheBrowserDoes pins the shared
// wording. Two surfaces that phrase a refusal differently are two different
// prompts, and the model's behavior after a refusal is exactly what the
// sentence is tuned for.
func TestApprover_DenialTellsTheModelTheSameThingTheBrowserDoes(t *testing.T) {
	var runs atomic.Int32
	res := loopWithApprover(t,
		ApproverFunc(func(context.Context, ApprovalRequest) (ApprovalAnswer, error) {
			return DenyApproval(), nil
		}),
		[]tools.Definition{shellTool(tools.NameRunShell, &runs)},
		permission.New(permission.ModeInteractive, nil, nil, nil),
		[]bifrostai.ToolCall{{ID: "c1", Name: tools.NameRunShell, Arguments: `{"command":"rm -rf /"}`}},
	)

	want := declinedToolMessage(tools.NameRunShell)
	if !strings.Contains(string(res.Parts), want[:40]) {
		t.Errorf("the refusal the model saw is not the shared one.\nwant to contain: %s\ngot parts: %s", want, res.Parts)
	}
}

// TestApprover_AlwaysGrantsTheCommandNotTheTool covers the rule the browser
// path already follows: approving `git commit` forever must not approve
// `git push`, and approving one shell command must never approve the shell.
func TestApprover_AlwaysGrantsTheCommandNotTheTool(t *testing.T) {
	var runs atomic.Int32
	var asked int32

	store := permission.NewStore()
	perms := permission.New(permission.ModeInteractive, nil, nil, store.For("thread-1"))

	ap := ApproverFunc(func(context.Context, ApprovalRequest) (ApprovalAnswer, error) {
		atomic.AddInt32(&asked, 1)
		return ApproveAlways(), nil
	})

	loopWithApprover(t, ap,
		[]tools.Definition{shellTool(tools.NameRunShell, &runs)},
		perms,
		[]bifrostai.ToolCall{{ID: "c1", Name: tools.NameRunShell, Arguments: `{"command":"git status"}`}},
	)
	if asked != 1 {
		t.Fatalf("asked %d times on the first call, want 1", asked)
	}

	// The same command again: granted, so nothing is asked.
	loopWithApprover(t, ap,
		[]tools.Definition{shellTool(tools.NameRunShell, &runs)},
		permission.New(permission.ModeInteractive, nil, nil, store.For("thread-1")),
		[]bifrostai.ToolCall{{ID: "c2", Name: tools.NameRunShell, Arguments: `{"command":"git status"}`}},
	)
	if asked != 1 {
		t.Errorf("asked again for an already-granted command (%d asks total)", asked)
	}

	// A different command through the same tool: still asked.
	loopWithApprover(t, ap,
		[]tools.Definition{shellTool(tools.NameRunShell, &runs)},
		permission.New(permission.ModeInteractive, nil, nil, store.For("thread-1")),
		[]bifrostai.ToolCall{{ID: "c3", Name: tools.NameRunShell, Arguments: `{"command":"git push --force"}`}},
	)
	if asked != 2 {
		t.Errorf("a grant on one command leaked to another: asks = %d, want 2", asked)
	}
}

// TestApprover_FailureIsNotAYes. An approver that errors -- a closed
// terminal, a broken pipe -- must not be read as consent.
func TestApprover_FailureIsNotAYes(t *testing.T) {
	var runs atomic.Int32
	res := loopWithApprover(t,
		ApproverFunc(func(context.Context, ApprovalRequest) (ApprovalAnswer, error) {
			return ApproveOnce(), context.Canceled
		}),
		[]tools.Definition{shellTool(tools.NameRunShell, &runs)},
		permission.New(permission.ModeInteractive, nil, nil, nil),
		[]bifrostai.ToolCall{{ID: "c1", Name: tools.NameRunShell, Arguments: `{"command":"ls"}`}},
	)

	if got := runs.Load(); got != 0 {
		t.Fatalf("tool ran %d times after the approver failed, want 0", got)
	}
	if !strings.Contains(string(res.Parts), "approval could not be obtained") {
		t.Errorf("the failure was not distinguished from a human declining: %s", res.Parts)
	}
}

// TestNoApprover_StillSuspends is the compatibility guarantee: every
// existing caller passes no approver and must behave exactly as before.
func TestNoApprover_StillSuspends(t *testing.T) {
	var runs atomic.Int32
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{{ID: "c1", Name: tools.NameRunShell, Arguments: `{"command":"ls"}`}}},
		{Text: "should never be reached"},
	}}
	sw := uimessage.NewWriter(httptest.NewRecorder())

	res, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "sys",
		[]bifrostai.Message{{Role: bifrostai.RoleUser, Text: "go"}},
		[]tools.Definition{shellTool(tools.NameRunShell, &runs)},
		permission.New(permission.ModeInteractive, nil, nil, nil))
	if err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}

	if got := runs.Load(); got != 0 {
		t.Errorf("tool ran %d times with no approver, want 0", got)
	}
	if !strings.Contains(string(res.Parts), "data-tool-approval") {
		t.Error("no approval part -- the client rail is what a nil approver must still use")
	}
	if strings.Contains(res.Text, "should never be reached") {
		t.Error("the loop continued past a suspend")
	}
}

// TestAutoApprove covers the canned approver headless runs use.
func TestAutoApprove(t *testing.T) {
	var runs atomic.Int32
	loopWithApprover(t, AutoApprove,
		[]tools.Definition{shellTool(tools.NameRunShell, &runs)},
		permission.New(permission.ModeInteractive, nil, nil, nil),
		[]bifrostai.ToolCall{{ID: "c1", Name: tools.NameRunShell, Arguments: `{"command":"ls"}`}},
	)
	if got := runs.Load(); got != 1 {
		t.Errorf("tool ran %d times under AutoApprove, want 1", got)
	}
}
