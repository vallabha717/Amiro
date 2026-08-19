package chat

import (
	"encoding/json"
	"testing"

	"amiro/backend/internal/agent/session"
)

func toolEvent(step int, id, name string, obs *session.Observation) session.Event {
	return session.Event{
		Action: session.Action{
			Kind: session.ActionTool, Step: step, Tool: name, ToolID: id,
			Input: json.RawMessage(`{}`),
		},
		Observation: obs,
	}
}

func types(parts []map[string]any) []string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		out = append(out, p["type"].(string))
	}
	return out
}

// The landmine the plan named by name: "part ordering has already been a live
// bug once."
//
// The log is appended in the order things happen -- tool calls at offer time,
// mid-stream, before the step's text is even known -- while the user was shown
// the text first. A projection that trusted log order would silently reorder
// every tool-using turn in every existing thread.
func TestPartsFromLog_OrdersWithinAStepRegardlessOfLogOrder(t *testing.T) {
	// Deliberately built in the order the loop really records them: the tool
	// calls land before the text of the same step.
	events := []session.Event{
		toolEvent(0, "c1", "read_file", &session.Observation{Status: session.StatusOK, Output: "a"}),
		toolEvent(0, "c2", "grep", &session.Observation{Status: session.StatusOK, Output: "b"}),
		{Action: session.Action{Kind: session.ActionThink, Step: 0, Text: "hmm"},
			Observation: &session.Observation{Status: session.StatusOK}},
		{Action: session.Action{Kind: session.ActionMessage, Step: 0, Text: "reading"},
			Observation: &session.Observation{Status: session.StatusOK}},
		{Action: session.Action{Kind: session.ActionMessage, Step: 1, Text: "done"},
			Observation: &session.Observation{Status: session.StatusOK}},
	}

	got := types(partsFromLog(events))
	want := []string{"reasoning", "text", "tool-read_file", "tool-grep", "text"}
	if len(got) != len(want) {
		t.Fatalf("parts = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("parts = %v, want %v -- reasoning and text precede the step's tool calls", got, want)
		}
	}
}

// Two calls in one step share a step and a rank. Their order is the model's
// call order, and a history whose tool results shuffle between runs of the
// same deterministic turn degrades the model's own reasoning.
func TestPartsFromLog_KeepsCallOrderWithinAStep(t *testing.T) {
	events := []session.Event{
		toolEvent(0, "c1", "read_file", &session.Observation{Status: session.StatusOK}),
		toolEvent(0, "c2", "read_file", &session.Observation{Status: session.StatusOK}),
		toolEvent(0, "c3", "read_file", &session.Observation{Status: session.StatusOK}),
	}
	parts := partsFromLog(events)
	for i, want := range []string{"c1", "c2", "c3"} {
		if got := parts[i]["toolCallId"]; got != want {
			t.Errorf("part %d is %v, want %s", i, got, want)
		}
	}
}

func TestPartsFromLog_MapsEachOutcomeToItsState(t *testing.T) {
	cases := []struct {
		name string
		obs  *session.Observation
		want string
	}{
		{"success", &session.Observation{Status: session.StatusOK, Output: "x"}, "output-available"},
		{"tool refused", &session.Observation{Status: session.StatusRejected, Error: "edit_file: no match"}, "output-error"},
		{"tool broke", &session.Observation{Status: session.StatusError, Error: "fork/exec"}, "output-error"},
		{"permission denied", &session.Observation{Status: session.StatusDenied, Error: "plan mode"}, "output-error"},
		// Suspended is checked before status, and this is why: a client tool
		// is StatusOK *and* unfinished. Reading the status first would render
		// a call the turn is still waiting on as one that produced a result.
		{"handed to the client", &session.Observation{Status: session.StatusOK, Suspended: true}, "input-available"},
		{"awaiting approval", &session.Observation{Status: session.StatusDenied, Suspended: true}, "input-available"},
		// A turn cut off mid-call: something was asked, nothing answered it.
		{"never observed", nil, "input-available"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			parts := partsFromLog([]session.Event{toolEvent(0, "c1", "read_file", c.obs)})
			if got := parts[0]["state"]; got != c.want {
				t.Errorf("state = %v, want %v", got, c.want)
			}
		})
	}
}

// The approval part is a second part about the same call, and it must land
// after the tool parts of its step: a reloaded thread finds the pending call
// and re-renders its card from it.
func TestPartsFromLog_EmitsTheApprovalRequestAfterItsStepsToolParts(t *testing.T) {
	events := []session.Event{
		toolEvent(0, "c1", "read_file", &session.Observation{Status: session.StatusOK, Output: "x"}),
		toolEvent(0, "c2", "run_shell", &session.Observation{
			Status: session.StatusDenied, Suspended: true,
			Approval: map[string]any{"toolName": "run_shell", "command": "rm -rf /"},
		}),
	}
	parts := partsFromLog(events)
	got := types(parts)
	want := []string{"tool-read_file", "tool-run_shell", "data-" + approvalDataPart}
	for i := range want {
		if i >= len(got) || got[i] != want[i] {
			t.Fatalf("parts = %v, want %v", got, want)
		}
	}
	if parts[2]["id"] != "c2" {
		t.Errorf("the approval part is not keyed to its call: %v", parts[2]["id"])
	}
}

// A compaction marker has to survive a reload: a silent context drop is
// exactly the kind of thing a user has to see to trust the transcript.
func TestPartsFromLog_KeepsTheCompactionMarkerFirstInItsStep(t *testing.T) {
	events := []session.Event{
		{Action: session.Action{Kind: session.ActionMessage, Step: 3, Text: "after"},
			Observation: &session.Observation{Status: session.StatusOK}},
		{Action: session.Action{Kind: session.ActionCompact, Step: 3,
			Data: map[string]any{"replaced": 12, "tokensBefore": 90000, "tokensAfter": 30000}},
			Observation: &session.Observation{Status: session.StatusOK}},
	}
	parts := partsFromLog(events)
	if parts[0]["type"] != "data-"+compactionDataPart {
		t.Fatalf("the compaction marker is not first in its step: %v", types(parts))
	}
	data := parts[0]["data"].(map[string]any)
	if data["replaced"] != 12 {
		t.Errorf("the marker lost its payload: %v", data)
	}
}

// An empty turn projects to an empty array, not to null. `null` and `[]`
// deserialize differently on the frontend, and a message whose parts are null
// renders as a broken message rather than an empty one.
func TestPartsFromLog_ProjectsAnEmptyLogToAnEmptyArray(t *testing.T) {
	encoded, err := json.Marshal(partsFromLog(nil))
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != "[]" {
		t.Errorf("empty log projected to %s, want []", encoded)
	}
}
