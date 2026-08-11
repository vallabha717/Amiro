package executor

import (
	"sync"

	"betterchatbot/backend/internal/ai/workflow"
	"betterchatbot/backend/internal/db/models"
)

// State ports WorkflowRuntimeState (graph-store.ts:8). Unlike the TS store,
// SetOutput/SetInput are always full-value replacements at the node-id key
// -- the only caller of setOutput in this codebase (workflow-executor.ts's
// own node.execute wrapper) always passes an empty path, so the general
// setByPath deep-merge behavior graph-store.ts implements is never actually
// exercised and isn't ported.
type State struct {
	mu      sync.Mutex
	Query   map[string]interface{}
	Inputs  map[string]interface{}
	Outputs map[string]interface{}
	Nodes   []models.WorkflowNode
	Edges   []models.WorkflowEdge
}

func NewState(query map[string]interface{}, nodes []models.WorkflowNode, edges []models.WorkflowEdge) *State {
	if query == nil {
		query = map[string]interface{}{}
	}
	return &State{
		Query:   query,
		Inputs:  map[string]interface{}{},
		Outputs: map[string]interface{}{},
		Nodes:   nodes,
		Edges:   edges,
	}
}

func (s *State) SetInput(nodeID string, v interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Inputs[nodeID] = v
}

func (s *State) GetInput(nodeID string) interface{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Inputs[nodeID]
}

func (s *State) SetOutput(nodeID string, v interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Outputs[nodeID] = v
}

// GetOutput ports getOutput (graph-store.ts:55). The TS version falls back
// to a schema-derived default value when the direct path lookup is
// undefined; that fallback is not ported here (documented simplification --
// output schema "default" values are rarely authored in practice, and the
// direct lookup already covers the common "reference an unexecuted
// conditional branch's node" case by returning nil, same as TS's `??`
// producing undefined when both the lookup and the default are absent).
func (s *State) GetOutput(key workflow.OutputSchemaSourceKey) interface{} {
	s.mu.Lock()
	val, ok := s.Outputs[key.NodeID]
	s.mu.Unlock()
	if !ok {
		return nil
	}
	return getByPath(val, key.Path)
}

// getByPath ports objectFlow(...).getByPath (lib/utils.ts:272): walks
// path segments, stopping as soon as a JS-falsy value is reached (matching
// `result = result?.[p]; return !result` inside the original's
// Array.prototype.find).
func getByPath(v interface{}, path []string) interface{} {
	result := v
	for _, p := range path {
		result = indexValue(result, p)
		if !jsTruthy(result) {
			return result
		}
	}
	return result
}

func indexValue(v interface{}, key string) interface{} {
	m, ok := v.(map[string]interface{})
	if !ok {
		return nil
	}
	return m[key]
}

// jsTruthy mirrors JS truthiness for the JSON-decoded value shapes actually
// held in Outputs (string, float64, bool, nil, map, slice) -- objects and
// arrays are always truthy in JS regardless of emptiness.
func jsTruthy(v interface{}) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	default:
		return true
	}
}

// Snapshot ports the "node.input"/"node.output" shape execute-tab.tsx reads
// off NODE_END events (source.outputs?.[nodeId] / source.inputs?.[nodeId]):
// ts-edge is a *state* graph, so each node's recorded input/output is the
// whole shared WorkflowRuntimeState before/after that node ran, not a
// per-node typed value. Copies both maps so a later mutation can't be
// observed by an event already handed off for JSON encoding.
func (s *State) Snapshot() map[string]interface{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return map[string]interface{}{
		"query":   s.Query,
		"inputs":  copyMap(s.Inputs),
		"outputs": copyMap(s.Outputs),
	}
}

func copyMap(m map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
