package session

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

func toolAction(step int, name, id string) Action {
	return Action{Kind: ActionTool, Step: step, Tool: name, ToolID: id, Input: json.RawMessage(`{}`)}
}

func TestLog_RecordsInCallOrderNotCompletionOrder(t *testing.T) {
	l := NewLog()

	// Three calls started in order, observed in reverse -- what parallel
	// execution actually does.
	a := l.Start(toolAction(0, "read_file", "c1"))
	b := l.Start(toolAction(0, "grep", "c2"))
	c := l.Start(toolAction(0, "glob", "c3"))
	l.Observe(c, Observation{Status: StatusOK})
	l.Observe(b, Observation{Status: StatusOK})
	l.Observe(a, Observation{Status: StatusOK})

	got := l.Events()
	want := []string{"read_file", "grep", "glob"}
	for i, name := range want {
		if got[i].Action.Tool != name {
			t.Fatalf("event %d is %q, want %q -- the log must be in call order, or two runs of one deterministic turn produce different logs",
				i, got[i].Action.Tool, name)
		}
	}
}

func TestLog_AttachesObservationsByToolCallID(t *testing.T) {
	l := NewLog()
	l.Start(toolAction(0, "write_file", "call-7"))
	l.Start(toolAction(0, "read_file", "call-8"))

	l.ObserveTool("call-7", Observation{Status: StatusRejected, Error: "no such anchor"})

	for _, e := range l.Events() {
		if e.Action.ToolID == "call-7" {
			if e.Observation == nil || e.Observation.Status != StatusRejected {
				t.Fatalf("call-7 observation = %+v", e.Observation)
			}
		}
		if e.Action.ToolID == "call-8" && e.Observation != nil {
			t.Fatal("observing call-7 also closed call-8")
		}
	}
}

// An action with no observation is a turn that was cut off mid-tool, and
// that has to stay distinguishable afterwards.
func TestLog_LeavesUnfinishedActionsWithoutAnObservation(t *testing.T) {
	l := NewLog()
	l.Start(toolAction(0, "run_shell", "c1"))
	events := l.Events()
	if events[0].Observation != nil {
		t.Fatal("an unfinished action came back with an observation")
	}
}

// The distinction the whole Stats type exists for: an edit that missed its
// anchor is ACI friction, an exec that blew up is a fault, and averaging
// them together hides both.
func TestSummarize_CountsFailedEditsSeparatelyFromErrors(t *testing.T) {
	l := NewLog()
	l.Record(toolAction(0, "edit_file", "c1"), Observation{Status: StatusRejected, Error: "anchor not unique"})
	l.Record(toolAction(0, "multi_edit", "c2"), Observation{Status: StatusRejected, Error: "no match"})
	l.Record(toolAction(1, "run_shell", "c3"), Observation{Status: StatusError, Error: "exec failed"})
	l.Record(toolAction(1, "write_file", "c4"), Observation{Status: StatusDenied, Error: "plan mode is read-only"})
	l.Record(toolAction(1, "read_file", "c5"), Observation{Status: StatusOK})

	s := l.Summarize()
	if s.FailedEdits != 2 {
		t.Errorf("FailedEdits = %d, want 2", s.FailedEdits)
	}
	if s.Errors != 1 {
		t.Errorf("Errors = %d, want 1 -- a rejected edit is not an error", s.Errors)
	}
	if s.Denials != 1 {
		t.Errorf("Denials = %d, want 1", s.Denials)
	}
	if s.ToolCalls != 5 {
		t.Errorf("ToolCalls = %d, want 5", s.ToolCalls)
	}
	if s.Steps != 2 {
		t.Errorf("Steps = %d, want 2", s.Steps)
	}
}

// A rejected write_file is not a failed *edit*: its failure says nothing
// about whether the edit format is working, which is what the metric is
// for.
func TestSummarize_OnlyEditToolsCountTowardFailedEdits(t *testing.T) {
	l := NewLog()
	l.Record(toolAction(0, "write_file", "c1"), Observation{Status: StatusRejected})
	l.Record(toolAction(0, "git", "c2"), Observation{Status: StatusRejected})
	if s := l.Summarize(); s.FailedEdits != 0 {
		t.Fatalf("FailedEdits = %d, want 0 -- neither of these is an edit", s.FailedEdits)
	}
}

func TestSummarize_CountsCompactionsWithoutCountingThemAsToolCalls(t *testing.T) {
	l := NewLog()
	l.Record(Action{Kind: ActionCompact, Step: 3}, Observation{Status: StatusOK})
	l.Record(toolAction(3, "read_file", "c1"), Observation{Status: StatusOK})

	s := l.Summarize()
	if s.Compactions != 1 {
		t.Errorf("Compactions = %d, want 1", s.Compactions)
	}
	if s.ToolCalls != 1 {
		t.Errorf("ToolCalls = %d, want 1 -- a compaction is not a tool call", s.ToolCalls)
	}
}

func TestSummarize_BreaksDownByTool(t *testing.T) {
	l := NewLog()
	l.Record(toolAction(0, "read_file", "c1"), Observation{Status: StatusOK})
	l.Record(toolAction(0, "read_file", "c2"), Observation{Status: StatusOK})
	l.Record(toolAction(1, "grep", "c3"), Observation{Status: StatusOK})

	s := l.Summarize()
	if s.ByTool["read_file"] != 2 || s.ByTool["grep"] != 1 {
		t.Fatalf("ByTool = %v", s.ByTool)
	}
}

func TestObserve_DerivesDurationFromTheActionsStart(t *testing.T) {
	l := NewLog()
	at := l.Start(Action{Kind: ActionTool, Tool: "grep", At: time.Now().Add(-250 * time.Millisecond)})
	l.Observe(at, Observation{Status: StatusOK})

	got := l.Events()[0].Observation.DurationMS
	if got < 200 || got > 2000 {
		t.Fatalf("DurationMS = %d, want roughly 250", got)
	}
}

// The scheduler writes to this from every parallel tool goroutine.
func TestLog_IsSafeUnderConcurrentWriters(t *testing.T) {
	l := NewLog()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			id := string(rune('a'+n%26)) + string(rune('a'+n/26))
			l.Record(toolAction(0, "read_file", id), Observation{Status: StatusOK})
		}(i)
	}
	wg.Wait()
	if got := len(l.Events()); got != 50 {
		t.Fatalf("%d events, want 50", got)
	}
}

// Nil is the "no log wanted" case and every method has to tolerate it, or
// every existing call site grows a nil check.
func TestNilLog_IsInert(t *testing.T) {
	var l *Log
	if at := l.Start(Action{}); at != -1 {
		t.Fatalf("nil.Start = %d", at)
	}
	l.Observe(0, Observation{})
	l.ObserveTool("x", Observation{})
	l.Record(Action{}, Observation{})
	if got := l.Events(); got != nil {
		t.Fatalf("nil.Events = %v", got)
	}
	if s := l.Summarize(); s.ToolCalls != 0 {
		t.Fatalf("nil.Summarize = %+v", s)
	}
}
