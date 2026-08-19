package chat

import (
	"sort"

	"amiro/backend/internal/agent/session"
)

// partsFromLog projects one turn's event log into the UI message parts array
// that gets persisted on models.ChatMessage.
//
// This is Phase 1 item 1 of docs/agentic-loop-implementation-plan.md, the
// inversion that phase deferred. Before it, the loop accumulated `parts` and
// the log side by side from the same events, and the only thing keeping the
// two accounts of one turn in agreement was a test. Now there is one account
// and this reads it.
//
// # Ordering is the whole difficulty
//
// The log is appended in the order things *happen*, which is not the order
// the parts array wants, and the difference is not cosmetic:
//
//   - Tool calls are recorded at offer time -- mid-stream, as each call's
//     arguments finish arriving -- so they land in the log *before* the step's
//     text, which is only known once StreamStep returns.
//   - The client, meanwhile, was shown the text first: closeText() runs before
//     the first tool frame is written.
//
// Persisting in log order would therefore reorder every tool-using turn
// relative to what the user watched happen. That exact bug has already
// shipped in this tree once, from the mirror-image mistake (tool parts were
// appended mid-stream and landed before the text), and the fix then was to
// drain tools after the step. Re-deriving from the log reintroduces the
// hazard, so the ordering is made explicit here rather than left to depend on
// where in the loop each append happens.
//
// Within a step, parts are ordered by what kind of thing they are:
//
//	compaction → reasoning → text → tool calls (in the model's call order)
//	           → approval requests
//
// and steps run in ascending order. This is the order the stream wrote, and
// TestToolLoop_PersistedPartsGolden holds it byte-for-byte.
func partsFromLog(events []session.Event) []map[string]any {
	type ranked struct {
		part  map[string]any
		step  int
		rank  int
		order int // position in the log, to break ties inside one rank
	}

	ordered := make([]ranked, 0, len(events)+4)

	for i, e := range events {
		step := e.Action.Step
		add := func(rank int, part map[string]any) {
			if part != nil {
				ordered = append(ordered, ranked{part: part, step: step, rank: rank, order: i})
			}
		}

		switch e.Action.Kind {
		case session.ActionCompact:
			if e.Action.Data != nil {
				add(rankCompaction, map[string]any{
					"type": "data-" + compactionDataPart,
					"data": e.Action.Data,
				})
			}
		case session.ActionThink:
			if e.Action.Text != "" {
				add(rankReasoning, map[string]any{"type": "reasoning", "text": e.Action.Text})
			}
		case session.ActionMessage:
			if e.Action.Text != "" {
				add(rankText, map[string]any{"type": "text", "text": e.Action.Text})
			}
		case session.ActionTool:
			add(rankTool, toolCallPart(e))
			// The approval request is a second part describing the same call,
			// and it is persisted after the tool parts of its step so a
			// reloaded thread finds the pending call and can re-render its
			// card. "input-available" alone cannot tell "waiting for the
			// browser to run this" from "waiting for a human to say yes".
			if e.Observation != nil && e.Observation.Approval != nil {
				add(rankApproval, map[string]any{
					"type": "data-" + approvalDataPart,
					"id":   e.Action.ToolID,
					"data": e.Observation.Approval,
				})
			}
		}
	}

	// SliceStable, and the explicit `order` tiebreak, because two tool calls
	// in one step share a step and a rank: their relative order is the
	// model's call order and must not depend on the sort's internals.
	sort.SliceStable(ordered, func(a, b int) bool {
		if ordered[a].step != ordered[b].step {
			return ordered[a].step < ordered[b].step
		}
		if ordered[a].rank != ordered[b].rank {
			return ordered[a].rank < ordered[b].rank
		}
		return ordered[a].order < ordered[b].order
	})

	parts := make([]map[string]any, 0, len(ordered))
	for _, r := range ordered {
		parts = append(parts, r.part)
	}
	return parts
}

// Within-step ordering. Named rather than inlined as integers because the
// ordering *is* the contract this file exists to hold.
const (
	rankCompaction = iota
	rankReasoning
	rankText
	rankTool
	rankApproval
)

// toolCallPart renders one tool call as the frontend's tool part.
//
// The three states map exactly onto what the observation says happened, and
// the order of the checks is load-bearing:
//
//   - Suspended first, because a suspended call has a status too (OK for a
//     client tool, Denied for one awaiting approval) and that status must not
//     be allowed to render it as finished. A call the turn is still waiting on
//     is "input-available" whatever its reason for waiting.
//   - Then an error of any kind -- a refusal, a denial, a fault. All three
//     reach the model as an error string, which is right: its next move is the
//     same. They are separate *statuses* so the eval harness can tell scaffold
//     friction from a broken tool, not separate parts.
//   - Otherwise the call produced output.
//
// A tool with no observation at all is a turn that was cut off mid-call. It
// renders as input-available for the same reason a suspended one does:
// something was asked and nothing answered it.
func toolCallPart(e session.Event) map[string]any {
	part := map[string]any{
		"type":       "tool-" + e.Action.Tool,
		"toolCallId": e.Action.ToolID,
		"input":      e.Action.Input,
	}

	if e.Observation == nil || e.Observation.Suspended {
		part["state"] = "input-available"
		return part
	}

	if e.Observation.Status != session.StatusOK {
		part["state"] = "output-error"
		part["errorText"] = e.Observation.Error
		return part
	}

	part["state"] = "output-available"
	part["output"] = e.Observation.Output
	return part
}
