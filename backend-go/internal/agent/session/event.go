// Package session records what an agent turn actually did, as a sequence
// of actions and the observations they produced.
//
// # Why this exists now and did not before
//
// Phase 1 of docs/agentic-loop-implementation-plan.md called for this and
// deliberately held it back: at the time it would have had exactly one
// consumer and no replay feature, and the plan said to revisit when a
// second consumer appeared. Three have:
//
//   - The subagent (internal/api/chat/subagent.go) runs a whole loop whose
//     history is discarded on purpose, and can currently report only a step
//     count about what happened inside it.
//   - Auto-compaction reasons about a turn from the Bifrost message array,
//     which is a transport format -- it knows a tool returned a string, not
//     that an edit failed its anchor check.
//   - The evaluation harness (Part 4 of the plan) has to report *failed
//     edit rate* and *mean steps to completion*, and the plan calls the
//     first "the sharpest signal on whether the ACI is working". Neither is
//     derivable from a message array or from the persisted parts, because
//     both record that a tool returned, not whether it did its job.
//
// # This is now the source of truth (inverted 2026-08-17)
//
// It did not start that way. For a day this was a *parallel* record: the
// persisted parts array was accumulated separately inside the tool loop, and
// TestToolLoop_EventLogAgreesWithThePersistedParts was the only thing
// stopping two accounts of one turn from drifting apart. A test can catch
// drift after the fact; it cannot prevent it.
//
// The parts array is now a pure projection of this log
// (internal/api/chat/parts.go, partsFromLog). Two consequences follow, and
// they are the whole reason for the change:
//
//   - The two records cannot disagree, because there is one record. The
//     agreement test still exists but it can no longer fail for the reason it
//     was written -- it now asserts a property of a projection rather than a
//     coincidence between two accumulators.
//   - A run can be reconstructed from its log, which is what replay needs and
//     what a record that is *allowed* to disagree with the transcript can
//     never support.
//
// # What that cost, and why it is not a regression
//
// Two fields here used to be deliberately lossy, and the reasoning was
// sound while this was a measurement record: Action.Text was clipped to 400
// characters and Observation carried a 200-character summary rather than the
// tool's output, on the grounds that "the transcript already holds the full
// text" and a log carrying every file read is as large as the context it
// describes.
//
// Both invert with the log. The transcript is now built *from* this, so
// truncating here truncates the transcript. The memory argument does not
// survive either: the parts array held those same bytes before, for the same
// duration, in the same request. The bytes moved; they were not added.
package session

import (
	"encoding/json"
	"sync"
	"time"
)

// ActionKind names what the agent tried to do.
type ActionKind string

const (
	ActionMessage ActionKind = "message" // the agent produced text for the user
	ActionThink   ActionKind = "think"   // reasoning tokens
	ActionTool    ActionKind = "tool"    // a tool call
	ActionCompact ActionKind = "compact" // the loop shrank its own history
)

// ObservationStatus is how an action turned out.
//
// Four values, not two, because "the tool ran and told the agent it could
// not do the thing" is the interesting case and a boolean loses it. An
// edit_file whose anchor did not match returns an error to the model
// without anything having gone wrong operationally -- that is
// StatusRejected, and counting it as StatusError would put ordinary ACI
// friction in the same bucket as a crashed process.
type ObservationStatus string

const (
	StatusOK       ObservationStatus = "ok"
	StatusRejected ObservationStatus = "rejected" // the tool ran and refused: bad anchor, no match, invalid input
	StatusDenied   ObservationStatus = "denied"   // the permission engine or the user said no
	StatusError    ObservationStatus = "error"    // the tool itself failed
)

// Action is one thing the agent did.
type Action struct {
	Kind ActionKind `json:"kind"`
	Step int        `json:"step"`

	// Tool is set for ActionTool.
	Tool     string          `json:"tool,omitempty"`
	ToolID   string          `json:"tool_id,omitempty"`
	Input    json.RawMessage `json:"input,omitempty"`
	Risk     string          `json:"risk,omitempty"`
	Parallel bool            `json:"parallel,omitempty"`

	// Text is set for ActionMessage and ActionThink, and carries the step's
	// full text.
	//
	// It used to be clipped, on the reasoning that the log measured a run
	// while the transcript held the prose. The transcript is now projected
	// from here, so a clip here is a clip in the saved conversation.
	Text string `json:"text,omitempty"`

	// Data carries a structured payload for kinds that have one. Today only
	// ActionCompact does: what was replaced, and the token estimate either
	// side of it.
	//
	// A loose map rather than a typed struct because this is the shape the
	// compaction marker is *already* published in, to the stream and to the
	// persisted part. Introducing a typed mirror of it here would put a
	// second definition of one payload in the tree, which is the class of
	// problem this whole inversion exists to remove.
	Data map[string]any `json:"data,omitempty"`

	At time.Time `json:"at"`
}

// Observation is what came back.
type Observation struct {
	Status ObservationStatus `json:"status"`

	// Summary is a short human-readable line about the result, for anyone
	// reading the log itself. Distinct from Output rather than a lossy copy
	// of it: Output is the data the tool returned, Summary is the sentence a
	// person scanning a 40-step run wants instead of that data.
	Summary string `json:"summary,omitempty"`
	Error   string `json:"error,omitempty"`

	// Output is what the tool returned, exactly as it returned it.
	//
	// This is the field that made the log able to carry the transcript. It
	// used to be absent on the grounds that a log holding every file read is
	// as large as the context it describes -- true, and irrelevant once the
	// persisted parts are projected from here, because those parts held these
	// same bytes anyway.
	Output any `json:"output,omitempty"`

	// Suspended marks a call this turn could not resolve on its own: a
	// client-executed tool handed to the browser, or one the permission
	// engine wants a human to approve.
	//
	// Not a Status value, because it is orthogonal to one. A suspended call
	// has both an outcome so far (StatusOK for a client tool, StatusDenied
	// for one awaiting approval) *and* the property that nothing further
	// happened in this turn. Folding the two into one enum would force a
	// choice between reporting why the call stopped and reporting that it
	// stopped.
	Suspended bool `json:"suspended,omitempty"`

	// Approval is the request put to the user, when Suspended because the
	// permission engine asked for a human. Nil otherwise.
	Approval map[string]any `json:"approval,omitempty"`

	DurationMS int64     `json:"duration_ms"`
	At         time.Time `json:"at"`
}

// Event pairs an action with its observation. Observation is nil while the
// action is in flight, which is also how a turn that was cut off mid-tool
// is distinguishable afterwards from one that completed.
type Event struct {
	Action      Action       `json:"action"`
	Observation *Observation `json:"observation,omitempty"`
}

// Log is one turn's events, in the order the agent took them.
//
// Order is call order, not completion order -- the same rule the tool
// scheduler already applies when merging parallel results back into
// history. A log ordered by completion would make two runs of the same
// deterministic turn produce different logs, which destroys its value for
// exactly the comparison the eval harness exists to make.
type Log struct {
	mu     sync.Mutex
	events []Event
	index  map[string]int // tool call id -> position, for attaching observations
}

func NewLog() *Log { return &Log{index: map[string]int{}} }

// Start records an action and returns a handle to close it with.
func (l *Log) Start(a Action) int {
	if l == nil {
		return -1
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if a.At.IsZero() {
		a.At = time.Now()
	}
	l.events = append(l.events, Event{Action: a})
	at := len(l.events) - 1
	if a.ToolID != "" {
		l.index[a.ToolID] = at
	}
	return at
}

// Observe attaches an observation to a previously started action.
func (l *Log) Observe(at int, o Observation) {
	if l == nil || at < 0 {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if at >= len(l.events) {
		return
	}
	if o.At.IsZero() {
		o.At = time.Now()
	}
	if o.DurationMS == 0 {
		o.DurationMS = o.At.Sub(l.events[at].Action.At).Milliseconds()
	}
	l.events[at].Observation = &o
}

// ObserveTool attaches by tool call id, for callers that do not hold the
// handle -- the scheduler dispatches a call in one place and resolves it in
// another.
func (l *Log) ObserveTool(toolID string, o Observation) {
	if l == nil {
		return
	}
	l.mu.Lock()
	at, ok := l.index[toolID]
	l.mu.Unlock()
	if ok {
		l.Observe(at, o)
	}
}

// Record logs a completed action in one call.
func (l *Log) Record(a Action, o Observation) {
	l.Observe(l.Start(a), o)
}

// Events returns a copy of the log.
func (l *Log) Events() []Event {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]Event(nil), l.events...)
}

// Stats is the aggregate the eval harness reports on.
type Stats struct {
	Steps      int `json:"steps"`
	ToolCalls  int `json:"tool_calls"`
	Errors     int `json:"errors"`
	Rejections int `json:"rejections"`
	Denials    int `json:"denials"`

	// FailedEdits counts edit/write calls the tool itself refused -- a bad
	// anchor, a non-unique match, a failed syntax check. The plan calls
	// this the sharpest available signal on whether the agent-computer
	// interface is working: it rises when the edit format is hard for the
	// model to produce correctly, and it is invisible in resolve rate until
	// the run has already been wasted.
	FailedEdits int `json:"failed_edits"`

	// Compactions counts how often the turn had to shrink its own history.
	Compactions int `json:"compactions"`

	ByTool map[string]int `json:"by_tool,omitempty"`

	DurationMS int64 `json:"duration_ms"`
}

// editingTools are the ones FailedEdits is about. A name list rather than a
// risk check because RiskWrite includes `git commit` and `write_file`,
// whose failures say nothing about whether the *edit format* is working.
var editingTools = map[string]bool{
	"edit_file":  true,
	"multi_edit": true,
}

// Summarize aggregates the log.
func (l *Log) Summarize() Stats {
	events := l.Events()
	s := Stats{ByTool: map[string]int{}}

	var first, last time.Time
	for _, e := range events {
		if first.IsZero() || e.Action.At.Before(first) {
			first = e.Action.At
		}
		if e.Action.Step+1 > s.Steps {
			s.Steps = e.Action.Step + 1
		}
		end := e.Action.At
		if e.Observation != nil && e.Observation.At.After(end) {
			end = e.Observation.At
		}
		if end.After(last) {
			last = end
		}

		switch e.Action.Kind {
		case ActionCompact:
			s.Compactions++
			continue
		case ActionTool:
			s.ToolCalls++
			s.ByTool[e.Action.Tool]++
		default:
			continue
		}

		if e.Observation == nil {
			continue
		}
		switch e.Observation.Status {
		case StatusError:
			s.Errors++
		case StatusDenied:
			s.Denials++
		case StatusRejected:
			s.Rejections++
			if editingTools[e.Action.Tool] {
				s.FailedEdits++
			}
		}
	}
	if !first.IsZero() {
		s.DurationMS = last.Sub(first).Milliseconds()
	}
	return s
}
