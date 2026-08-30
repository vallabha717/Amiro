package page

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"amiro/backend/internal/tui/client"
)

func TestRuns_LoadListsAndFilters(t *testing.T) {
	fc := &fakeClient{
		backgroundJobs: []client.BackgroundJob{
			{ID: "job-1", ThreadID: "t1", Prompt: "fix the login bug", Status: "running"},
			{ID: "job-2", ThreadID: "t2", Prompt: "write release notes", Status: "suspended"},
		},
		thread: client.ThreadDetail{ID: "t1", Title: "fix the login bug"},
	}
	m := NewRuns(fc)

	m, _ = m.Update(m.load())
	if len(m.filtered) != 2 {
		t.Fatalf("filtered = %d rows, want 2", len(m.filtered))
	}

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("login")})
	if len(m.filtered) != 1 || m.filtered[0].ID != "job-1" {
		t.Fatalf("filtered after typing 'login' = %+v, want just job-1", m.filtered)
	}
}

func TestRuns_FilterMatchesStatusToo(t *testing.T) {
	fc := &fakeClient{
		backgroundJobs: []client.BackgroundJob{
			{ID: "job-1", ThreadID: "t1", Prompt: "fix the login bug", Status: "running"},
			{ID: "job-2", ThreadID: "t2", Prompt: "write release notes", Status: "suspended"},
		},
	}
	m := NewRuns(fc)
	m, _ = m.Update(m.load())

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("suspended")})
	if len(m.filtered) != 1 || m.filtered[0].ID != "job-2" {
		t.Fatalf("filtered after typing 'suspended' = %+v, want just job-2", m.filtered)
	}
}

// TestRuns_SelectResumesByOpeningTheJobsThread is the whole point of
// reusing ThreadChosenMsg: picking a run resolves to opening its thread,
// not a second kind of navigation event or resolution path.
func TestRuns_SelectResumesByOpeningTheJobsThread(t *testing.T) {
	fc := &fakeClient{
		backgroundJobs: []client.BackgroundJob{{ID: "job-1", ThreadID: "t1", Prompt: "one", Status: "suspended"}},
		thread:         client.ThreadDetail{ID: "t1", Title: "one"},
	}
	m := NewRuns(fc)
	m, _ = m.Update(m.load())

	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if !m.resuming {
		t.Fatal("resuming = false after Enter, want true")
	}
	resumed, ok := cmd().(runResumeMsg)
	if !ok || resumed.detail.ID != "t1" {
		t.Fatalf("cmd() = %+v, want runResumeMsg{detail.ID: t1}", resumed)
	}

	_, cmd2 := m.Update(resumed)
	chosen, ok := cmd2().(ThreadChosenMsg)
	if !ok || chosen.Detail.ID != "t1" {
		t.Fatalf("cmd2() = %T (%+v), want ThreadChosenMsg{Detail.ID: t1}", cmd2(), chosen)
	}
}

func TestRuns_EscYieldsPickerCancelledMsg(t *testing.T) {
	m := NewRuns(&fakeClient{})
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if _, ok := cmd().(PickerCancelledMsg); !ok {
		t.Fatalf("cmd() = %T, want PickerCancelledMsg", cmd())
	}
}

func TestRuns_EmptyListRendersEmptyState(t *testing.T) {
	m := NewRuns(&fakeClient{})
	m, _ = m.Update(m.load())
	view := m.View()
	if !strings.Contains(view, "no background runs yet") {
		t.Fatalf("View() = %q, want the empty-state message", view)
	}
}
