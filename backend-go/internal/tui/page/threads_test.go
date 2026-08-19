package page

import (
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"amiro/backend/internal/tui/client"
)

func TestThreads_LoadListsAndFilters(t *testing.T) {
	fc := &fakeClient{
		threads: []client.ThreadSummary{
			{ID: "t1", Title: "fix the login bug", CreatedAt: time.Now()},
			{ID: "t2", Title: "write release notes", CreatedAt: time.Now()},
		},
		thread: client.ThreadDetail{ID: "t1", Title: "fix the login bug"},
	}
	m := NewThreads(fc)

	m, _ = m.Update(m.load())
	if len(m.filtered) != 2 {
		t.Fatalf("filtered = %d rows, want 2", len(m.filtered))
	}

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("login")})
	if len(m.filtered) != 1 || m.filtered[0].ID != "t1" {
		t.Fatalf("filtered after typing 'login' = %+v, want just t1", m.filtered)
	}

	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if !m.resuming {
		t.Fatalf("resuming = false after Enter, want true")
	}
	loaded, ok := cmd().(threadLoadedMsg)
	if !ok || loaded.detail.ID != "t1" {
		t.Fatalf("cmd() = %+v, want threadLoadedMsg{detail.ID: t1}", loaded)
	}
}

func TestThreads_SelectYieldsThreadChosenMsg(t *testing.T) {
	fc := &fakeClient{
		threads: []client.ThreadSummary{{ID: "t1", Title: "one"}},
		thread:  client.ThreadDetail{ID: "t1", Title: "one"},
	}
	m := NewThreads(fc)
	m, _ = m.Update(m.load())

	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	loaded := cmd().(threadLoadedMsg)
	m, cmd2 := m.Update(loaded)
	chosen, ok := cmd2().(ThreadChosenMsg)
	if !ok || chosen.Detail.ID != "t1" {
		t.Fatalf("cmd2() = %T (%+v), want ThreadChosenMsg{Detail.ID: t1}", cmd2(), chosen)
	}
}

func TestThreads_DeleteCallsClientAndReloads(t *testing.T) {
	fc := &fakeClient{threads: []client.ThreadSummary{{ID: "t1", Title: "one"}}}
	m := NewThreads(fc)
	m, _ = m.Update(m.load())

	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlD})
	if cmd == nil {
		t.Fatalf("ctrl+d returned a nil cmd")
	}
	deleted := cmd().(threadDeletedMsg)
	if deleted.id != "t1" {
		t.Fatalf("deleted id = %q, want t1", deleted.id)
	}
	if fc.deletedThread != "t1" {
		t.Fatalf("client.DeleteThread was not called with t1")
	}
}

func TestThreads_EscYieldsPickerCancelledMsg(t *testing.T) {
	m := NewThreads(&fakeClient{})
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if _, ok := cmd().(PickerCancelledMsg); !ok {
		t.Fatalf("esc yielded %T, want PickerCancelledMsg", cmd())
	}
}
