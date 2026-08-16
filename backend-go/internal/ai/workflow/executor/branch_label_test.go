package executor

import (
	"encoding/json"
	"testing"

	"amiro/backend/internal/ai/workflow"
	"amiro/backend/internal/db/models"
)

func edge(id, source, target, sourceHandle string) models.WorkflowEdge {
	cfg := map[string]interface{}{}
	if sourceHandle != "" {
		cfg["sourceHandle"] = sourceHandle
	}
	b, _ := json.Marshal(cfg)
	return models.WorkflowEdge{ID: id, Source: source, Target: target, UIConfig: b}
}

func node(id string, kind workflow.NodeKind) models.WorkflowNode {
	return models.WorkflowNode{ID: id, Kind: string(kind)}
}

func labelOf(t *testing.T, edges []*runtimeEdge, id string) string {
	t.Helper()
	for _, e := range edges {
		if e.ID == id {
			return e.cfg.Label
		}
	}
	t.Fatalf("edge %q not found", id)
	return ""
}

// TestAddEdgeBranchLabel_ConditionBranchesShareOneLabel verifies that a
// condition node's if/else arms converging on the same target do NOT
// require sync -- only one of the two arms ever actually runs in a given
// execution, so buildNeedTable must not wait for two arrivals there.
func TestAddEdgeBranchLabel_ConditionBranchesShareOneLabel(t *testing.T) {
	nodes := []models.WorkflowNode{
		node("in", workflow.NodeKindInput),
		node("cond", workflow.NodeKindCondition),
		node("a", workflow.NodeKindTemplate),
		node("b", workflow.NodeKindTemplate),
		node("out", workflow.NodeKindOutput),
	}
	edges := newRuntimeEdges([]models.WorkflowEdge{
		edge("e1", "in", "cond", ""),
		edge("e2", "cond", "a", "if"),
		edge("e3", "cond", "b", "else"),
		edge("e4", "a", "out", ""),
		edge("e5", "b", "out", ""),
	})

	AddEdgeBranchLabel(nodes, edges)

	if labelOf(t, edges, "e4") != labelOf(t, edges, "e5") {
		t.Fatalf("expected both condition arms to share a branch label, got %q and %q",
			labelOf(t, edges, "e4"), labelOf(t, edges, "e5"))
	}

	need := buildNeedTable(edges)
	if _, tracked := need["out"]; tracked {
		t.Fatalf("expected the Output node to need no sync (only one branch ever runs), got needTable=%v", need)
	}
}

// TestAddEdgeBranchLabel_GenuineFanInNeedsSync verifies that two distinct
// static branches (not two arms of the same condition) converging on a
// shared node DO get distinct labels, so buildNeedTable makes that node
// wait for both arrivals.
func TestAddEdgeBranchLabel_GenuineFanInNeedsSync(t *testing.T) {
	nodes := []models.WorkflowNode{
		node("in", workflow.NodeKindInput),
		node("p1", workflow.NodeKindTemplate),
		node("p2", workflow.NodeKindTemplate),
		node("out", workflow.NodeKindOutput),
	}
	edges := newRuntimeEdges([]models.WorkflowEdge{
		edge("e1", "in", "p1", ""),
		edge("e2", "in", "p2", ""),
		edge("e3", "p1", "out", ""),
		edge("e4", "p2", "out", ""),
	})

	AddEdgeBranchLabel(nodes, edges)

	if labelOf(t, edges, "e3") == labelOf(t, edges, "e4") {
		t.Fatalf("expected two independent fan-out branches to get distinct labels, both were %q", labelOf(t, edges, "e3"))
	}

	need := buildNeedTable(edges)
	if need["out"] != 2 {
		t.Fatalf("expected the Output node to need 2 arrivals, got needTable=%v", need)
	}
}

func TestAddEdgeBranchLabel_NoInputNodeIsNoop(t *testing.T) {
	nodes := []models.WorkflowNode{node("a", workflow.NodeKindTemplate)}
	edges := newRuntimeEdges(nil)
	AddEdgeBranchLabel(nodes, edges) // must not panic
}
