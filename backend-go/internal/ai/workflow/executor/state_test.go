package executor

import (
	"testing"

	"betterchatbot/backend/internal/ai/workflow"
)

func TestState_SetGetOutput_RoundTrip(t *testing.T) {
	s := NewState(nil, nil, nil)
	s.SetOutput("n1", map[string]interface{}{"answer": "hi"})
	got := s.GetOutput(workflow.OutputSchemaSourceKey{NodeID: "n1", Path: []string{"answer"}})
	if got != "hi" {
		t.Fatalf("got %v", got)
	}
}

func TestState_GetOutput_EmptyPathReturnsWholeValue(t *testing.T) {
	s := NewState(nil, nil, nil)
	value := map[string]interface{}{"a": float64(1)}
	s.SetOutput("n1", value)
	got := s.GetOutput(workflow.OutputSchemaSourceKey{NodeID: "n1"})
	m, ok := got.(map[string]interface{})
	if !ok || m["a"] != float64(1) {
		t.Fatalf("got %v", got)
	}
}

func TestState_GetOutput_UnknownNodeIsNil(t *testing.T) {
	s := NewState(nil, nil, nil)
	got := s.GetOutput(workflow.OutputSchemaSourceKey{NodeID: "missing", Path: []string{"x"}})
	if got != nil {
		t.Fatalf("expected nil for an unexecuted node, got %v", got)
	}
}

func TestState_GetOutput_NestedPath(t *testing.T) {
	s := NewState(nil, nil, nil)
	s.SetOutput("http1", map[string]interface{}{
		"response": map[string]interface{}{"status": float64(200)},
	})
	got := s.GetOutput(workflow.OutputSchemaSourceKey{NodeID: "http1", Path: []string{"response", "status"}})
	if got != float64(200) {
		t.Fatalf("got %v", got)
	}
}

func TestState_GetOutput_MissingPathSegmentStopsAtFalsyValue(t *testing.T) {
	s := NewState(nil, nil, nil)
	s.SetOutput("n1", map[string]interface{}{"a": nil})
	got := s.GetOutput(workflow.OutputSchemaSourceKey{NodeID: "n1", Path: []string{"a", "b", "c"}})
	if got != nil {
		t.Fatalf("expected nil once a falsy intermediate is hit, got %v", got)
	}
}

func TestState_InputOutput_AreIndependent(t *testing.T) {
	s := NewState(nil, nil, nil)
	s.SetInput("n1", "in-value")
	s.SetOutput("n1", "out-value")
	if s.GetInput("n1") != "in-value" {
		t.Fatal("input overwritten by output")
	}
	if s.GetOutput(workflow.OutputSchemaSourceKey{NodeID: "n1"}) != "out-value" {
		t.Fatal("output overwritten by input")
	}
}

func TestState_Snapshot_IsIndependentOfLaterMutation(t *testing.T) {
	s := NewState(nil, nil, nil)
	s.SetOutput("n1", "first")
	snap := s.Snapshot()
	s.SetOutput("n1", "second")

	outputs := snap["outputs"].(map[string]interface{})
	if outputs["n1"] != "first" {
		t.Fatalf("snapshot mutated after later SetOutput: got %v", outputs["n1"])
	}
}

func TestJsTruthy(t *testing.T) {
	cases := []struct {
		v    interface{}
		want bool
	}{
		{nil, false}, {"", false}, {"x", true}, {float64(0), false}, {float64(1), true},
		{false, false}, {true, true},
		{map[string]interface{}{}, true}, // empty objects are truthy in JS
		{[]interface{}{}, true},
	}
	for _, c := range cases {
		if got := jsTruthy(c.v); got != c.want {
			t.Errorf("jsTruthy(%#v) = %v, want %v", c.v, got, c.want)
		}
	}
}
