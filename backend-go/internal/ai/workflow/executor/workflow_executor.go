package executor

import (
	"context"
	"time"

	"amiro/backend/internal/ai/workflow"
	"amiro/backend/internal/db/models"
)

// Event ports GraphEvent's union (ts-edge's index.d.ts, re-exported via
// shared.workflow.ts's encodeWorkflowEvent) as one flat struct instead of a
// TS discriminated union -- EventType says which fields are meaningful.
// Field names and JSON casing match the TS wire shape byte-for-byte since
// the existing frontend (execute-tab.tsx, shared.workflow.ts's
// decodeWorkflowEvents) decodes this stream unchanged.
type Event struct {
	EventType       string      `json:"eventType"`
	Timestamp       int64       `json:"timestamp"`
	ExecutionID     string      `json:"executionId,omitempty"`
	StartedAt       int64       `json:"startedAt,omitempty"`
	EndedAt         int64       `json:"endedAt,omitempty"`
	Input           interface{} `json:"input,omitempty"`
	Output          interface{} `json:"output,omitempty"`
	IsOk            *bool       `json:"isOk,omitempty"`
	Error           *EventError `json:"error,omitempty"`
	Node            *EventNode  `json:"node,omitempty"`
	NodeExecutionID string      `json:"nodeExecutionId,omitempty"`
	ThreadID        string      `json:"threadId,omitempty"`
}

// EventNode ports GraphNodeWithOutOutput<T> as seen on NODE_START/NODE_END
// events: Name is the node id (ts-edge's GraphNode.name), Input/Output are
// State.Snapshot() calls, not this one node's own return value -- see
// State.Snapshot's doc comment for why.
type EventNode struct {
	Name   string      `json:"name"`
	Input  interface{} `json:"input,omitempty"`
	Output interface{} `json:"output,omitempty"`
}

type EventError struct {
	Name    string `json:"name"`
	Message string `json:"message"`
}

func boolPtr(b bool) *bool { return &b }

func nowMillis() int64 { return time.Now().UnixMilli() }

// Run ports createWorkflowExecutor + app.run (workflow-executor.ts): drives
// nodes from the Input node to completion over State, emitting WORKFLOW_START
// / NODE_START / NODE_END / WORKFLOW_END events on the returned channel,
// closed once the run finishes (isOk true or false) or ctx is cancelled.
//
// Deliberate simplification vs. ts-edge's actual engine: this walks the
// graph with a single-threaded BFS queue rather than ts-edge's own
// (possibly concurrent) node scheduler. The wire-visible contract --
// WORKFLOW_START, one NODE_START/NODE_END pair per executed node, exactly
// one WORKFLOW_END -- is preserved; only the internal concurrency model
// differs, which the frontend's event consumer doesn't depend on.
func Run(ctx context.Context, bf Engine, mgr MCPCaller, nodes []models.WorkflowNode, edges []models.WorkflowEdge, query map[string]interface{}) <-chan Event {
	out := make(chan Event)
	go func() {
		defer close(out)
		runGraph(ctx, bf, mgr, nodes, edges, query, out)
	}()
	return out
}

// maxNodeExecutions bounds a run against a malformed/tampered graph that
// would otherwise loop forever (workflow graphs are meant to be acyclic --
// wouldCreateCycle enforces that client-side at edit time, but this server
// has no equivalent guard, so it defends here instead).
const maxNodeExecutions = 10000

func runGraph(ctx context.Context, bf Engine, mgr MCPCaller, nodes []models.WorkflowNode, edges []models.WorkflowEdge, query map[string]interface{}, out chan<- Event) {
	startedAt := nowMillis()
	executionID := models.NewID()

	send := func(ev Event) bool {
		ev.Timestamp = nowMillis()
		select {
		case out <- ev:
			return true
		case <-ctx.Done():
			return false
		}
	}

	var inputNode *models.WorkflowNode
	for i := range nodes {
		if workflow.NodeKind(nodes[i].Kind) == workflow.NodeKindInput {
			inputNode = &nodes[i]
			break
		}
	}
	if inputNode == nil {
		send(Event{
			EventType: "WORKFLOW_START", StartedAt: startedAt, Input: query, ExecutionID: executionID,
		})
		endWorkflow(send, executionID, startedAt, false, nil, &EventError{Name: "ERROR", Message: "workflow has no Input node"})
		return
	}

	runtimeEdges := newRuntimeEdges(edges)
	AddEdgeBranchLabel(nodes, runtimeEdges)
	needTable := buildNeedTable(runtimeEdges)

	state := NewState(query, nodes, edges)
	nodeByID := make(map[string]*models.WorkflowNode, len(nodes))
	for i := range nodes {
		nodeByID[nodes[i].ID] = &nodes[i]
	}
	staticTargets := func(nodeID string) []string {
		var out []string
		for _, e := range runtimeEdges {
			if e.Source == nodeID {
				out = append(out, e.Target)
			}
		}
		return out
	}

	if !send(Event{EventType: "WORKFLOW_START", StartedAt: startedAt, Input: query, ExecutionID: executionID}) {
		return
	}

	queue := []string{inputNode.ID}
	var lastOutputNodeOutput interface{}
	executions := 0

	for len(queue) > 0 {
		if ctx.Err() != nil {
			endWorkflow(send, executionID, startedAt, false, lastOutputNodeOutput, &EventError{Name: "ERROR", Message: ctx.Err().Error()})
			return
		}

		nodeID := queue[0]
		queue = queue[1:]

		if left, tracked := needTable[nodeID]; tracked {
			left--
			if left > 0 {
				needTable[nodeID] = left
				continue // matches routing early arrivals to ts-edge's SKIP sink node
			}
			delete(needTable, nodeID)
		}

		node := nodeByID[nodeID]
		if node == nil {
			continue
		}

		executions++
		if executions > maxNodeExecutions {
			endWorkflow(send, executionID, startedAt, false, lastOutputNodeOutput, &EventError{Name: "ERROR", Message: "workflow exceeded the maximum node execution count"})
			return
		}

		nodeStartedAt := nowMillis()
		nodeExecutionID := models.NewID()
		if !send(Event{
			EventType: "NODE_START", ExecutionID: executionID, NodeExecutionID: nodeExecutionID,
			ThreadID: executionID, StartedAt: nodeStartedAt, Node: &EventNode{Name: nodeID},
		}) {
			return
		}

		result, next, err := executeNode(NodeContext{Ctx: ctx, Node: *node, State: state, Bifrost: bf, MCP: mgr})
		if err == nil {
			if result.Output != nil {
				state.SetOutput(nodeID, result.Output)
			}
			if result.Input != nil {
				state.SetInput(nodeID, result.Input)
			}
			if workflow.NodeKind(node.Kind) == workflow.NodeKindOutput {
				lastOutputNodeOutput = result.Output
			}
		}

		nodeEndedAt := nowMillis()
		if err != nil {
			send(Event{
				EventType: "NODE_END", ExecutionID: executionID, NodeExecutionID: nodeExecutionID,
				ThreadID: executionID, StartedAt: nodeStartedAt, EndedAt: nodeEndedAt,
				IsOk: boolPtr(false), Error: &EventError{Name: "ERROR", Message: err.Error()},
				Node: &EventNode{Name: nodeID, Input: state.Snapshot()},
			})
			endWorkflow(send, executionID, startedAt, false, lastOutputNodeOutput, &EventError{Name: "ERROR", Message: err.Error()})
			return
		}

		if !send(Event{
			EventType: "NODE_END", ExecutionID: executionID, NodeExecutionID: nodeExecutionID,
			ThreadID: executionID, StartedAt: nodeStartedAt, EndedAt: nodeEndedAt,
			IsOk: boolPtr(true), Node: &EventNode{Name: nodeID, Output: state.Snapshot()},
		}) {
			return
		}

		targets := next
		if workflow.NodeKind(node.Kind) != workflow.NodeKindCondition {
			targets = staticTargets(nodeID)
		}
		queue = append(queue, targets...)
	}

	endWorkflow(send, executionID, startedAt, true, lastOutputNodeOutput, nil)
}

func endWorkflow(send func(Event) bool, executionID string, startedAt int64, isOk bool, output interface{}, evErr *EventError) {
	send(Event{
		EventType: "WORKFLOW_END", ExecutionID: executionID, StartedAt: startedAt, EndedAt: nowMillis(),
		IsOk: boolPtr(isOk), Output: output, Error: evErr,
	})
}
