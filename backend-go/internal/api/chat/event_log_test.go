package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"

	"amiro/backend/internal/agent/permission"
	"amiro/backend/internal/agent/session"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/uimessage"
)

func loopWith(t *testing.T, engine Engine, defs []tools.Definition, perms *permission.Engine) toolLoopResult {
	t.Helper()
	sw := uimessage.NewWriter(httptest.NewRecorder())
	_ = sw.Start("m1")
	res, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "sys",
		[]bifrostai.Message{{Role: bifrostai.RoleUser, Text: "go"}}, defs, perms, nil)
	if err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}
	return res
}

func okTool(name string) tools.Definition {
	return tools.Definition{Name: name, Risk: tools.RiskRead,
		Execute: func(context.Context, json.RawMessage) (any, error) { return "fine", nil }}
}

// The claim the inversion actually makes: the persisted parts array *is* the
// projection of the event log, not a second account that happens to agree.
//
// This replaces what the agreement test below could ever prove. While the two
// were accumulated side by side, the strongest available assertion was "these
// two structures currently say the same thing about this one scenario" --
// which passes right up until someone appends to one and not the other on a
// path no test covers. Comparing the persisted bytes against the projection
// of the log fails for *any* turn where the two could differ, because there
// is no longer a second accumulator that could drift.
func TestToolLoop_PersistedPartsAreTheProjectionOfTheLog(t *testing.T) {
	defs := []tools.Definition{
		okTool(tools.NameReadFile),
		{Name: tools.NameEditFile, Risk: tools.RiskWrite,
			Execute: func(context.Context, json.RawMessage) (any, error) {
				return nil, fmt.Errorf("edit_file: the search anchor matched 3 times")
			}},
	}
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{Reasoning: "thinking", Text: "reading", ToolCalls: []bifrostai.ToolCall{
			{ID: "c1", Name: tools.NameReadFile, Arguments: `{"path":"a.go"}`},
			{ID: "c2", Name: tools.NameEditFile, Arguments: `{"path":"a.go"}`},
		}},
		{Text: "done"},
	}}

	res := loopWith(t, engine, defs, testPerms())

	want, err := json.Marshal(partsFromLog(res.Log.Events()))
	if err != nil {
		t.Fatalf("project: %v", err)
	}
	if string(res.Parts) != string(want) {
		t.Errorf("the persisted parts are not the projection of the log.\npersisted: %s\nprojected: %s",
			res.Parts, want)
	}
}

// The original drift guard, kept because it states the property in the terms
// a reader will look for. It can no longer fail for the reason it was written
// -- there is one record now -- but it is cheap and it documents the
// invariant that made the inversion worth doing.
func TestToolLoop_EventLogAgreesWithThePersistedParts(t *testing.T) {
	defs := []tools.Definition{okTool(tools.NameReadFile), okTool(tools.NameGrep)}
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{Text: "looking now", ToolCalls: []bifrostai.ToolCall{
			{ID: "c1", Name: tools.NameReadFile, Arguments: `{"path":"a.go"}`},
			{ID: "c2", Name: tools.NameGrep, Arguments: `{"pattern":"x"}`},
		}},
		{Text: "done"},
	}}

	res := loopWith(t, engine, defs, testPerms())

	var parts []map[string]any
	if err := json.Unmarshal(res.Parts, &parts); err != nil {
		t.Fatalf("parts: %v", err)
	}

	// Every tool part in the transcript has an event, keyed by call id.
	partIDs := map[string]bool{}
	for _, p := range parts {
		if id, ok := p["toolCallId"].(string); ok {
			partIDs[id] = true
		}
	}
	logIDs := map[string]bool{}
	for _, e := range res.Log.Events() {
		if e.Action.Kind == session.ActionTool {
			logIDs[e.Action.ToolID] = true
		}
	}
	if len(partIDs) == 0 {
		t.Fatal("no tool parts were persisted at all")
	}
	for id := range partIDs {
		if !logIDs[id] {
			t.Errorf("tool call %q is in the persisted parts but not in the event log", id)
		}
	}
	for id := range logIDs {
		if !partIDs[id] {
			t.Errorf("tool call %q is in the event log but not in the persisted parts", id)
		}
	}

	// And the text the user sees is an event too.
	sawText := false
	for _, e := range res.Log.Events() {
		if e.Action.Kind == session.ActionMessage {
			sawText = true
		}
	}
	if !sawText {
		t.Error("the assistant's text produced no event")
	}
}

func TestToolLoop_LogRecordsCallOrderEvenWhenExecutionOverlaps(t *testing.T) {
	// Two parallel reads: whichever finishes first, the log is call-ordered.
	slow := tools.Definition{Name: tools.NameReadFile, Risk: tools.RiskRead,
		Execute: func(ctx context.Context, _ json.RawMessage) (any, error) {
			return "slow", nil
		}}
	fast := okTool(tools.NameGlob)

	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{
			{ID: "c1", Name: tools.NameReadFile, Arguments: `{}`},
			{ID: "c2", Name: tools.NameGlob, Arguments: `{}`},
		}},
		{Text: "ok"},
	}}

	res := loopWith(t, engine, []tools.Definition{slow, fast}, testPerms())

	var order []string
	for _, e := range res.Log.Events() {
		if e.Action.Kind == session.ActionTool {
			order = append(order, e.Action.ToolID)
		}
	}
	if len(order) != 2 || order[0] != "c1" || order[1] != "c2" {
		t.Fatalf("event order = %v, want [c1 c2] -- the model's call order, not completion order", order)
	}
}

// The distinction the failed-edit metric depends on. A tool that ran and
// refused is scaffold friction; a tool that broke is a fault.
func TestToolLoop_SeparatesAToolsRefusalFromAToolBreaking(t *testing.T) {
	refuser := tools.Definition{Name: tools.NameEditFile, Risk: tools.RiskWrite,
		Execute: func(context.Context, json.RawMessage) (any, error) {
			return nil, fmt.Errorf("edit_file: the search anchor matched 3 times; make it unique")
		}}
	breaker := tools.Definition{Name: tools.NameRunShell, Risk: tools.RiskExec,
		Execute: func(context.Context, json.RawMessage) (any, error) {
			return nil, fmt.Errorf("fork/exec: cannot allocate memory")
		}}

	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{
			{ID: "c1", Name: tools.NameEditFile, Arguments: `{}`},
			{ID: "c2", Name: tools.NameRunShell, Arguments: `{}`},
		}},
		{Text: "gave up"},
	}}

	res := loopWith(t, engine, []tools.Definition{refuser, breaker}, testPerms())
	stats := res.Log.Summarize()

	if stats.FailedEdits != 1 {
		t.Errorf("FailedEdits = %d, want 1 -- a rejected edit anchor is the ACI signal", stats.FailedEdits)
	}
	if stats.Errors != 1 {
		t.Errorf("Errors = %d, want 1 -- the exec failure is a fault, not scaffold friction", stats.Errors)
	}
	if stats.Rejections != 1 {
		t.Errorf("Rejections = %d, want 1", stats.Rejections)
	}
}

// A denial is its own category: neither the tool refusing nor the tool
// breaking, and lumping it in with either would misreport both.
func TestToolLoop_RecordsAPermissionDenialAsADenial(t *testing.T) {
	write := tools.Definition{Name: tools.NameWriteFile, Risk: tools.RiskWrite,
		Execute: func(context.Context, json.RawMessage) (any, error) { return "wrote", nil }}

	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{{ID: "c1", Name: tools.NameWriteFile, Arguments: `{"path":"a"}`}}},
		{Text: "cannot"},
	}}

	res := loopWith(t, engine, []tools.Definition{write},
		permission.New(permission.ModePlan, nil, nil, nil))

	stats := res.Log.Summarize()
	if stats.Denials != 1 {
		t.Fatalf("Denials = %d, want 1", stats.Denials)
	}
	if stats.Errors != 0 || stats.FailedEdits != 0 {
		t.Fatalf("a plan-mode refusal was counted as an error or a failed edit: %+v", stats)
	}
}

func TestToolLoop_RecordsAnUnknownToolAsAnError(t *testing.T) {
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{{ID: "c1", Name: "invented_tool", Arguments: `{}`}}},
		{Text: "oh"},
	}}
	res := loopWith(t, engine, []tools.Definition{okTool(tools.NameReadFile)}, testPerms())
	if got := res.Log.Summarize().Errors; got != 1 {
		t.Fatalf("Errors = %d, want 1 for a tool that does not exist", got)
	}
}

func TestClassifyToolError(t *testing.T) {
	cases := []struct {
		tool string
		err  error
		want session.ObservationStatus
	}{
		{"edit_file", fmt.Errorf("edit_file: anchor not found"), session.StatusRejected},
		{"read_file", fmt.Errorf("workspace: %q resolves outside the root", "x"), session.StatusRejected},
		{"run_shell", fmt.Errorf("fork/exec: no such file"), session.StatusError},
		{"grep", context.DeadlineExceeded, session.StatusError},
		{"grep", context.Canceled, session.StatusError},
		{"glob", fmt.Errorf("something with no colon"), session.StatusError},
	}
	for _, c := range cases {
		if got := classifyToolError(c.tool, c.err); got != c.want {
			t.Errorf("classifyToolError(%q, %v) = %q, want %q", c.tool, c.err, got, c.want)
		}
	}
}
