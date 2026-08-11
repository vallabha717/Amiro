package executor

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"betterchatbot/backend/internal/ai/workflow"
	"betterchatbot/backend/internal/db/models"
)

func collectEvents(t *testing.T, ch <-chan Event) []Event {
	t.Helper()
	var events []Event
	timeout := time.After(5 * time.Second)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				return events
			}
			events = append(events, ev)
		case <-timeout:
			t.Fatal("timed out waiting for workflow events")
		}
	}
}

func eventTypes(events []Event) []string {
	out := make([]string, len(events))
	for i, e := range events {
		out[i] = e.EventType
	}
	return out
}

// TestRun_LinearWorkflow_InputTemplateOutput exercises the full engine on a
// simple non-branching graph and checks the exact wire event sequence the
// frontend's execute-tab.tsx depends on: one WORKFLOW_START, one
// NODE_START/NODE_END pair per node, one WORKFLOW_END.
func TestRun_LinearWorkflow_InputTemplateOutput(t *testing.T) {
	inputSchema := json.RawMessage(`{"type":"object","properties":{"name":{"type":"string"}}}`)
	nodes := []models.WorkflowNode{
		nodeWithConfig(t, "in", workflow.NodeKindInput, workflow.InputNodeConfig{OutputSchema: inputSchema}),
		nodeWithConfig(t, "tpl", workflow.NodeKindTemplate, map[string]interface{}{
			"template": map[string]interface{}{
				"type": "tiptap",
				"tiptap": map[string]interface{}{
					"type": "doc",
					"content": []interface{}{
						map[string]interface{}{"type": "paragraph", "content": []interface{}{
							map[string]interface{}{"type": "text", "text": "static text"},
						}},
					},
				},
			},
		}),
		nodeWithConfig(t, "out", workflow.NodeKindOutput, workflow.OutputNodeConfig{
			OutputData: []workflow.OutputDataItem{
				{Key: "result", Source: &workflow.OutputSchemaSourceKey{NodeID: "tpl", Path: []string{"template"}}},
			},
		}),
	}
	edges := []models.WorkflowEdge{
		edge("e1", "in", "tpl", ""),
		edge("e2", "tpl", "out", ""),
	}

	events := collectEvents(t, Run(context.Background(), nil, nil, nodes, edges, map[string]interface{}{"name": "world"}))

	types := eventTypes(events)
	want := []string{"WORKFLOW_START", "NODE_START", "NODE_END", "NODE_START", "NODE_END", "NODE_START", "NODE_END", "WORKFLOW_END"}
	if len(types) != len(want) {
		t.Fatalf("event sequence = %v, want %v", types, want)
	}
	for i := range want {
		if types[i] != want[i] {
			t.Fatalf("event sequence = %v, want %v", types, want)
		}
	}

	last := events[len(events)-1]
	if last.IsOk == nil || !*last.IsOk {
		t.Fatalf("expected WORKFLOW_END isOk=true, got %+v", last)
	}
	out := last.Output.(map[string]interface{})
	if out["result"] != "static text" {
		t.Fatalf("expected the Output node's collected value, got %v", last.Output)
	}
}

// TestRun_ConditionBranch_OnlyChosenPathExecutes verifies that only the
// taken branch's nodes produce NODE_START/NODE_END events -- the untaken
// branch must never run.
func TestRun_ConditionBranch_OnlyChosenPathExecutes(t *testing.T) {
	nodes := []models.WorkflowNode{
		nodeWithConfig(t, "in", workflow.NodeKindInput, workflow.InputNodeConfig{OutputSchema: workflow.DefaultObjectJSONSchema}),
		nodeWithConfig(t, "cond", workflow.NodeKindCondition, workflow.ConditionNodeConfig{
			Branches: workflow.ConditionBranches{
				If: workflow.ConditionBranch{
					ID: "if", Type: "if", LogicalOperator: "AND",
					Conditions: []workflow.ConditionRule{
						{Source: workflow.OutputSchemaSourceKey{NodeID: "in", Path: []string{"flag"}}, Operator: "equals", Value: "yes"},
					},
				},
				Else: workflow.ConditionBranch{ID: "else", Type: "else"},
			},
		}),
		nodeWithConfig(t, "taken", workflow.NodeKindTemplate, map[string]interface{}{
			"template": map[string]interface{}{"type": "tiptap", "tiptap": map[string]interface{}{"type": "doc", "content": []interface{}{}}},
		}),
		nodeWithConfig(t, "untaken", workflow.NodeKindTemplate, map[string]interface{}{
			"template": map[string]interface{}{"type": "tiptap", "tiptap": map[string]interface{}{"type": "doc", "content": []interface{}{}}},
		}),
		nodeWithConfig(t, "out", workflow.NodeKindOutput, workflow.OutputNodeConfig{}),
	}
	edges := []models.WorkflowEdge{
		edge("e1", "in", "cond", ""),
		edge("e2", "cond", "taken", "if"),
		edge("e3", "cond", "untaken", "else"),
		edge("e4", "taken", "out", ""),
		edge("e5", "untaken", "out", ""),
	}

	events := collectEvents(t, Run(context.Background(), nil, nil, nodes, edges, map[string]interface{}{"flag": "yes"}))

	ranNodes := map[string]bool{}
	for _, ev := range events {
		if ev.EventType == "NODE_START" {
			ranNodes[ev.Node.Name] = true
		}
	}
	if !ranNodes["taken"] {
		t.Fatal("expected the taken branch's node to run")
	}
	if ranNodes["untaken"] {
		t.Fatal("expected the untaken branch's node to never run")
	}

	last := events[len(events)-1]
	if last.EventType != "WORKFLOW_END" || last.IsOk == nil || !*last.IsOk {
		t.Fatalf("expected a successful WORKFLOW_END, got %+v", last)
	}
}

// TestRun_FanIn_WaitsForBothBranches verifies buildNeedTable's convergence
// wait: a node reachable from two genuinely independent static branches
// only executes once, after both branches arrive.
func TestRun_FanIn_WaitsForBothBranches(t *testing.T) {
	nodes := []models.WorkflowNode{
		nodeWithConfig(t, "in", workflow.NodeKindInput, workflow.InputNodeConfig{OutputSchema: workflow.DefaultObjectJSONSchema}),
		nodeWithConfig(t, "p1", workflow.NodeKindTemplate, map[string]interface{}{
			"template": map[string]interface{}{"type": "tiptap", "tiptap": map[string]interface{}{"type": "doc", "content": []interface{}{}}},
		}),
		nodeWithConfig(t, "p2", workflow.NodeKindTemplate, map[string]interface{}{
			"template": map[string]interface{}{"type": "tiptap", "tiptap": map[string]interface{}{"type": "doc", "content": []interface{}{}}},
		}),
		nodeWithConfig(t, "out", workflow.NodeKindOutput, workflow.OutputNodeConfig{}),
	}
	edges := []models.WorkflowEdge{
		edge("e1", "in", "p1", ""),
		edge("e2", "in", "p2", ""),
		edge("e3", "p1", "out", ""),
		edge("e4", "p2", "out", ""),
	}

	events := collectEvents(t, Run(context.Background(), nil, nil, nodes, edges, nil))

	outStarts := 0
	for _, ev := range events {
		if ev.EventType == "NODE_START" && ev.Node.Name == "out" {
			outStarts++
		}
	}
	if outStarts != 1 {
		t.Fatalf("expected the Output node to run exactly once after both branches arrive, ran %d times", outStarts)
	}
	last := events[len(events)-1]
	if last.EventType != "WORKFLOW_END" || last.IsOk == nil || !*last.IsOk {
		t.Fatalf("expected a successful WORKFLOW_END, got %+v", last)
	}
}

// TestRun_NodeFailure_AbortsWithFailedWorkflowEnd verifies a node error
// stops the run immediately and the failure surfaces on WORKFLOW_END.
func TestRun_NodeFailure_AbortsWithFailedWorkflowEnd(t *testing.T) {
	nodes := []models.WorkflowNode{
		nodeWithConfig(t, "in", workflow.NodeKindInput, workflow.InputNodeConfig{OutputSchema: workflow.DefaultObjectJSONSchema}),
		nodeWithConfig(t, "http1", workflow.NodeKindHttp, workflow.HttpNodeConfig{Method: "GET"}), // no URL -> fails
		nodeWithConfig(t, "out", workflow.NodeKindOutput, workflow.OutputNodeConfig{}),
	}
	edges := []models.WorkflowEdge{
		edge("e1", "in", "http1", ""),
		edge("e2", "http1", "out", ""),
	}

	events := collectEvents(t, Run(context.Background(), nil, nil, nodes, edges, nil))

	ranOutput := false
	for _, ev := range events {
		if ev.EventType == "NODE_START" && ev.Node.Name == "out" {
			ranOutput = true
		}
	}
	if ranOutput {
		t.Fatal("expected the run to abort before the Output node, which comes after the failing node")
	}

	last := events[len(events)-1]
	if last.EventType != "WORKFLOW_END" || last.IsOk == nil || *last.IsOk {
		t.Fatalf("expected a failed WORKFLOW_END, got %+v", last)
	}
	if last.Error == nil || last.Error.Message == "" {
		t.Fatal("expected an error message on the failed WORKFLOW_END")
	}
}

func TestRun_NoInputNode_FailsCleanly(t *testing.T) {
	nodes := []models.WorkflowNode{nodeWithConfig(t, "out", workflow.NodeKindOutput, workflow.OutputNodeConfig{})}
	events := collectEvents(t, Run(context.Background(), nil, nil, nodes, nil, nil))
	last := events[len(events)-1]
	if last.EventType != "WORKFLOW_END" || last.IsOk == nil || *last.IsOk {
		t.Fatalf("expected a failed WORKFLOW_END for a workflow with no Input node, got %+v", last)
	}
}
