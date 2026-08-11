package executor

import (
	"encoding/json"
	"strconv"

	"betterchatbot/backend/internal/ai/workflow"
	"betterchatbot/backend/internal/db/models"
)

// edgeUIConfig is the subset of WorkflowEdge.UIConfig this package reads/
// writes: sourceHandle (which branch handle a condition node's edge left
// from) and label (the synchronization branch id AddEdgeBranchLabel
// assigns). Unknown keys are preserved via Extra so re-marshaling doesn't
// drop fields the frontend also stores there (targetHandle, etc.).
type edgeUIConfig struct {
	SourceHandle string                 `json:"sourceHandle,omitempty"`
	TargetHandle string                 `json:"targetHandle,omitempty"`
	Label        string                 `json:"label,omitempty"`
	Extra        map[string]interface{} `json:"-"`
}

func decodeEdgeUIConfig(raw json.RawMessage) edgeUIConfig {
	var cfg edgeUIConfig
	_ = json.Unmarshal(raw, &cfg)
	return cfg
}

// runtimeEdge pairs a WorkflowEdge with its decoded, mutable UI config so
// AddEdgeBranchLabel can annotate labels in memory without persisting them
// -- the TS version mutates the same DBEdge objects a fresh
// selectStructureById call just returned, never writing them back either.
type runtimeEdge struct {
	models.WorkflowEdge
	cfg edgeUIConfig
}

func newRuntimeEdges(edges []models.WorkflowEdge) []*runtimeEdge {
	out := make([]*runtimeEdge, len(edges))
	for i, e := range edges {
		out[i] = &runtimeEdge{WorkflowEdge: e, cfg: decodeEdgeUIConfig(json.RawMessage(e.UIConfig))}
	}
	return out
}

// AddEdgeBranchLabel ports addEdgeBranchLabel (executor/add-edge-branch-label.ts):
// walks the graph from the Input node, assigning every edge a "branch id"
// (B0, B0.0, B0.1, ...) so buildNeedTable can later tell how many distinct
// branches converge on a shared target node.
func AddEdgeBranchLabel(nodes []models.WorkflowNode, edges []*runtimeEdge) {
	var start *models.WorkflowNode
	for i := range nodes {
		if workflow.NodeKind(nodes[i].Kind) == workflow.NodeKindInput {
			start = &nodes[i]
			break
		}
	}
	if start == nil {
		return
	}

	outs := func(id string) []*runtimeEdge {
		var result []*runtimeEdge
		for _, e := range edges {
			if e.Source == id {
				result = append(result, e)
			}
		}
		return result
	}
	nodeByID := func(id string) *models.WorkflowNode {
		for i := range nodes {
			if nodes[i].ID == id {
				return &nodes[i]
			}
		}
		return nil
	}

	type queued struct {
		id, bid string
	}
	queue := []queued{{id: start.ID, bid: "B0"}}

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		node := nodeByID(cur.id)
		if node == nil {
			continue
		}
		nexts := outs(cur.id)

		if workflow.NodeKind(node.Kind) == workflow.NodeKindCondition {
			byHandle := map[string][]*runtimeEdge{}
			for _, e := range nexts {
				h := e.cfg.SourceHandle
				if h == "" {
					h = "right"
				}
				byHandle[h] = append(byHandle[h], e)
			}
			for _, group := range byHandle {
				if len(group) == 1 {
					e := group[0]
					if e.cfg.Label == "" {
						e.cfg.Label = cur.bid
						queue = append(queue, queued{id: e.Target, bid: cur.bid})
					}
				} else {
					for i, e := range group {
						newBid := cur.bid + "." + strconv.Itoa(i)
						if e.cfg.Label == "" {
							e.cfg.Label = newBid
							queue = append(queue, queued{id: e.Target, bid: newBid})
						}
					}
				}
			}
		} else {
			for i, e := range nexts {
				newBid := cur.bid
				if len(nexts) > 1 {
					newBid = cur.bid + "." + strconv.Itoa(i)
				}
				if e.cfg.Label == "" {
					e.cfg.Label = newBid
					queue = append(queue, queued{id: e.Target, bid: newBid})
				}
			}
		}
	}
}

// buildNeedTable ports buildNeedTable (workflow-executor.ts:231): only
// nodes with more than one distinct incoming branch label need
// synchronization (waiting for every branch to arrive before executing
// once).
func buildNeedTable(edges []*runtimeEdge) map[string]int {
	byTarget := map[string]map[string]bool{}
	for _, e := range edges {
		set, ok := byTarget[e.Target]
		if !ok {
			set = map[string]bool{}
			byTarget[e.Target] = set
		}
		set[e.cfg.Label] = true
	}
	need := map[string]int{}
	for target, set := range byTarget {
		if len(set) > 1 {
			need[target] = len(set)
		}
	}
	return need
}
