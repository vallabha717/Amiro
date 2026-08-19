package todo

import (
	"strings"
	"testing"

	"amiro/backend/internal/tui/session"
)

func TestRender_EmptyIsEmpty(t *testing.T) {
	if got := Render(80, nil); got != "" {
		t.Fatalf("Render(nil) = %q, want empty string", got)
	}
}

func TestRender_CountsDoneAgainstTotal(t *testing.T) {
	items := []session.TodoItem{
		{Content: "a", Status: session.TodoDone},
		{Content: "b", Status: session.TodoDone},
		{Content: "c", Status: session.TodoPending},
	}
	got := Render(80, items)
	if !strings.Contains(got, "2/3 done") {
		t.Fatalf("Render = %q, want a 2/3 done count", got)
	}
}

func TestRender_NamesTheInProgressItem(t *testing.T) {
	items := []session.TodoItem{
		{Content: "fix the parser bug", Status: session.TodoInProgress},
		{Content: "write a test", Status: session.TodoPending},
	}
	got := Render(80, items)
	if !strings.Contains(got, "fix the parser bug") {
		t.Fatalf("Render = %q, want the in-progress item named", got)
	}
	if strings.Contains(got, "write a test") {
		t.Fatalf("Render = %q, want only the in-progress item named, not pending ones", got)
	}
}

// TestRender_NoInProgressItemShowsOnlyCounts covers the state right after
// a plan is written but before the model has started the first item --
// nothing to name, so the line should be the counts alone rather than
// naming a pending item as if it were current.
func TestRender_NoInProgressItemShowsOnlyCounts(t *testing.T) {
	items := []session.TodoItem{{Content: "a", Status: session.TodoPending}}
	got := Render(80, items)
	if strings.Contains(got, "a") {
		t.Fatalf("Render = %q, want no item named when nothing is in progress", got)
	}
	if !strings.Contains(got, "0/1 done") {
		t.Fatalf("Render = %q, want the counts", got)
	}
}

func TestRender_AllDoneUsesTheDoneGlyph(t *testing.T) {
	items := []session.TodoItem{
		{Content: "a", Status: session.TodoDone},
		{Content: "b", Status: session.TodoDone},
	}
	got := Render(80, items)
	if !strings.Contains(got, "[x]") {
		t.Fatalf("Render = %q, want the all-done glyph [x]", got)
	}
}

func TestRender_NeverPanicsOnNarrowWidth(t *testing.T) {
	items := []session.TodoItem{{Content: "a very long item name that will not fit", Status: session.TodoInProgress}}
	for _, w := range []int{-1, 0, 1, 2, 5, 10} {
		_ = Render(w, items)
	}
}
