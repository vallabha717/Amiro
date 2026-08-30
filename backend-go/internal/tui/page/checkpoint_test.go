package page

import (
	"errors"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"amiro/backend/internal/tui/client"
	"amiro/backend/internal/tui/keys"
)

// errBoom is a canned transport failure -- fakeClient's error fields exist
// so a test can force one without a real network.
var errBoom = errors.New("boom")

func readyChat(fc *fakeClient) Chat {
	m := NewChat(fc, "thread-1", "/home/user/project")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	// Drain the trust check so it doesn't shadow the rewind dialog.
	return m
}

// TestChat_SlashRewind_NothingToRewindShowsNotice is exit criterion 3: a
// clear "nothing to rewind" state rather than a confusing empty
// confirmation dialog.
func TestChat_SlashRewind_NothingToRewindShowsNotice(t *testing.T) {
	fc := &fakeClient{}
	m := readyChat(fc)

	m.input.SetValue("/rewind")
	m, cmd := m.send()
	if cmd == nil {
		t.Fatal("/rewind returned a nil cmd, want one that checks for a rewind candidate")
	}
	m, _ = m.Update(cmd())

	if m.rewindTurnID != "" {
		t.Fatalf("rewindTurnID = %q, want empty when there is nothing to rewind", m.rewindTurnID)
	}
	if m.notice != "nothing to rewind" {
		t.Fatalf("notice = %q, want %q", m.notice, "nothing to rewind")
	}
}

// TestChat_SlashRewind_ShowsConfirmationAndBlocksSend mirrors
// TestChat_UntrustedWorkspace_ShowsPromptAndBlocksSend: the confirmation
// appears in View and owns the keyboard.
func TestChat_SlashRewind_ShowsConfirmationAndBlocksSend(t *testing.T) {
	fc := &fakeClient{
		latestCheckpointTurn: "turn-1",
		latestCheckpointFiles: []client.CheckpointFile{
			{Path: "a.go", ExistedBefore: true},
			{Path: "new-file.go", ExistedBefore: false},
		},
	}
	m := readyChat(fc)

	m.input.SetValue("/rewind")
	m, cmd := m.send()
	m, _ = m.Update(cmd())

	if m.rewindTurnID != "turn-1" {
		t.Fatalf("rewindTurnID = %q, want turn-1", m.rewindTurnID)
	}
	view := m.View()
	if !strings.Contains(view, "rewind") {
		t.Fatalf("View() = %q, want it to mention the rewind confirmation", view)
	}
	if !strings.Contains(view, "a.go") || !strings.Contains(view, "new-file.go") {
		t.Fatalf("View() = %q, want it to list the checkpointed files", view)
	}

	m.input.SetValue("hello")
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if fc.lastSend != nil {
		t.Fatal("Enter sent a message while the rewind confirmation was open")
	}
}

// TestChat_RewindConfirm_YesRestoresAndClosesTheDialog is the 'y' path.
func TestChat_RewindConfirm_YesRestoresAndClosesTheDialog(t *testing.T) {
	fc := &fakeClient{
		latestCheckpointTurn:    "turn-1",
		latestCheckpointFiles:   []client.CheckpointFile{{Path: "a.go", ExistedBefore: true}},
		restoreCheckpointResult: []client.CheckpointRestoreResult{{Path: "a.go", ExistedBefore: true, Restored: true}},
	}
	m := readyChat(fc)
	m.input.SetValue("/rewind")
	m, cmd := m.send()
	m, _ = m.Update(cmd())

	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(string(keys.DefaultApprovalKeyMap.ApproveOnce.Keys()[0]))})
	if cmd == nil {
		t.Fatal("confirming rewind returned a nil cmd, want one that calls RestoreCheckpoint")
	}
	m, _ = m.Update(cmd())

	if fc.restoredCheckpoint == nil {
		t.Fatal("RestoreCheckpoint was never called")
	}
	if fc.restoredCheckpoint.ThreadID != "thread-1" || fc.restoredCheckpoint.TurnID != "turn-1" {
		t.Fatalf("RestoreCheckpoint called with %+v, want thread-1/turn-1", fc.restoredCheckpoint)
	}
	if m.rewindTurnID != "" {
		t.Fatalf("rewindTurnID = %q after a successful restore, want empty", m.rewindTurnID)
	}
	if m.notice != "rewound 1 file(s)" {
		t.Fatalf("notice = %q, want a result summary", m.notice)
	}
}

// TestChat_RewindConfirm_NoCancelsWithoutRestoring is the 'n' path.
func TestChat_RewindConfirm_NoCancelsWithoutRestoring(t *testing.T) {
	fc := &fakeClient{
		latestCheckpointTurn:  "turn-1",
		latestCheckpointFiles: []client.CheckpointFile{{Path: "a.go", ExistedBefore: true}},
	}
	m := readyChat(fc)
	m.input.SetValue("/rewind")
	m, cmd := m.send()
	m, _ = m.Update(cmd())

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(string(keys.DefaultApprovalKeyMap.Deny.Keys()[0]))})

	if m.rewindTurnID != "" {
		t.Fatal("declining left rewindTurnID set")
	}
	if fc.restoredCheckpoint != nil {
		t.Fatal("declining must not call RestoreCheckpoint")
	}
}

// TestChat_EscEsc_TriggersRewindCheck is the Esc-Esc shortcut
// (docs/coding-agent-parity/02-checkpoints-and-rewind.md): two presses
// within the window fire the same check /rewind does; a single press does
// nothing.
func TestChat_EscEsc_TriggersRewindCheck(t *testing.T) {
	fc := &fakeClient{latestCheckpointTurn: "turn-1", latestCheckpointFiles: []client.CheckpointFile{{Path: "a.go"}}}
	m := readyChat(fc)

	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if cmd != nil {
		t.Fatal("a single Esc returned a non-nil cmd, want the window to just start")
	}

	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if cmd == nil {
		t.Fatal("a second Esc within the window returned a nil cmd, want it to check for a rewind candidate")
	}
	m, _ = m.Update(cmd())
	if m.rewindTurnID != "turn-1" {
		t.Fatalf("rewindTurnID = %q after Esc-Esc, want turn-1", m.rewindTurnID)
	}
}

// TestChat_EscEsc_TooSlowDoesNotTrigger guards the window itself: two
// presses further apart than escEscWindow must not be treated as the
// shortcut.
func TestChat_EscEsc_TooSlowDoesNotTrigger(t *testing.T) {
	fc := &fakeClient{latestCheckpointTurn: "turn-1", latestCheckpointFiles: []client.CheckpointFile{{Path: "a.go"}}}
	m := readyChat(fc)
	clock := newFakeClock()
	m.now = clock.now

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	clock.advance(escEscWindow + time.Second)
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if cmd != nil {
		t.Fatal("Esc, then Esc after the window elapsed, returned a non-nil cmd -- window not enforced")
	}
}

// TestChat_RewindCandidateError_SetsErrRatherThanNotice proves an actual
// transport failure surfaces as state.Err, distinct from the "nothing to
// rewind" notice.
func TestChat_RewindCandidateError_SetsErrRatherThanNotice(t *testing.T) {
	fc := &fakeClient{latestCheckpointErr: errBoom}
	m := readyChat(fc)

	m.input.SetValue("/rewind")
	m, cmd := m.send()
	m, _ = m.Update(cmd())

	if m.state.Err == nil {
		t.Fatal("state.Err is nil, want the LatestCheckpoint error surfaced")
	}
	if m.notice == "nothing to rewind" {
		t.Fatal("an error was reported as \"nothing to rewind\"")
	}
}
