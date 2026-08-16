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
// # What this is not, yet
//
// The plan's end state is that the EventLog becomes the source of truth and
// the Bifrost message array becomes a projection of it. This is not that.
// The message array is still built directly and still what gets persisted;
// the log is a parallel structured record of the same turn.
//
// Two records of one turn is a real cost and worth stating plainly rather
// than dressing up: they can drift.
// TestToolLoop_EventLogAgreesWithThePersistedParts is what keeps them
// honest, and it exists because a test is the only thing that can. The
// alternative -- doing the inversion now -- means rewriting persistence
// (route.go, models.ChatMessage) and re-deriving the parts array from the
// log, in a tree where part ordering has already been a live bug once.
// That is the right change and the wrong time; the log has to exist and be
// trusted before anything can be built on top of it.
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

	// Text is set for ActionMessage and ActionThink. Truncated: the log is
	// for measuring a run, not for replaying its prose, and the transcript
	// already holds the full text.
	Text string `json:"text,omitempty"`

	At time.Time `json:"at"`
}

// Observation is what came back.
type Observation struct {
	Status ObservationStatus `json:"status"`

	// Summary is a short human-readable result. Deliberately not the tool's
	// full output: a log that carries every file read is as large as the
	// context it was meant to describe.
	Summary string `json:"summary,omitempty"`
	Error   string `json:"error,omitempty"`

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
