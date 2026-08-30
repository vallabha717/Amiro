package page

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"amiro/backend/internal/tui/keys"
)

// TestChat_FirstResize_ChecksWorkspaceTrust is phase-00's TUI half of exit
// criterion 4: the trust check runs once the page has a real terminal size
// to render into, before the first message.
//
// This fires from the first WindowSizeMsg, not Init: an in-memory HTTP
// round trip (as fast as this check is) can complete before Bubble Tea's
// renderer has painted anything, which loses the resulting dialog on
// screen even though the model updates correctly -- observed directly
// against a real PTY. The first WindowSizeMsg is reliably past that point.
func TestChat_FirstResize_ChecksWorkspaceTrust(t *testing.T) {
	fc := &fakeClient{workspaceUntrusted: true}
	m := NewChat(fc, "thread-1", "/home/user/project")

	_, cmd := m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	if cmd == nil {
		t.Fatal("the first WindowSizeMsg returned a nil cmd, want one that checks workspace trust")
	}
	msg, ok := cmd().(workspaceTrustMsg)
	if !ok {
		t.Fatalf("cmd() = %T, want workspaceTrustMsg", cmd())
	}
	if msg.trusted {
		t.Fatal("workspaceTrustMsg.trusted = true, want false for an untrusted workspace")
	}
}

// TestChat_SecondResize_DoesNotRecheckWorkspaceTrust guards the "once at
// startup" claim: a later resize (a real terminal being dragged wider)
// must not fire a second check.
func TestChat_SecondResize_DoesNotRecheckWorkspaceTrust(t *testing.T) {
	fc := &fakeClient{workspaceUntrusted: true}
	m := NewChat(fc, "thread-1", "/home/user/project")

	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	_, cmd := m.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	if cmd != nil {
		t.Fatal("a second resize returned a non-nil cmd, want the trust check to fire only once")
	}
}

// TestChat_UntrustedWorkspace_ShowsPromptAndBlocksSend covers the prompt
// actually appearing and owning the keyboard: an untrusted workspace shows
// the dialog in View, and Enter (the send key) does nothing while it's up
// -- the same "dialog owns every keypress" contract the tool-approval
// dialog already has.
func TestChat_UntrustedWorkspace_ShowsPromptAndBlocksSend(t *testing.T) {
	fc := &fakeClient{workspaceUntrusted: true}
	m := NewChat(fc, "thread-1", "/home/user/project")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	m, _ = m.Update(workspaceTrustMsg{trusted: false, resolvedRoot: "/home/user/project"})

	if m.trustPromptRoot != "/home/user/project" {
		t.Fatalf("trustPromptRoot = %q, want the resolved root", m.trustPromptRoot)
	}
	if !strings.Contains(m.View(), "trust") {
		t.Fatalf("View() = %q, want it to mention the trust prompt", m.View())
	}

	m.input.SetValue("hello")
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if fc.lastSend != nil {
		t.Fatal("Enter sent a message while the trust prompt was open")
	}
}

// TestChat_TrustPrompt_GrantSendsTheGrantAndClosesThePrompt is the 'y'
// path: it calls GrantWorkspaceTrust with the workspace root (not the
// resolved display value) and, once the response lands, closes the prompt.
func TestChat_TrustPrompt_GrantSendsTheGrantAndClosesThePrompt(t *testing.T) {
	fc := &fakeClient{workspaceUntrusted: true}
	m := NewChat(fc, "thread-1", "/home/user/project")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	m, _ = m.Update(workspaceTrustMsg{trusted: false, resolvedRoot: "/home/user/project"})

	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(string(keys.DefaultApprovalKeyMap.ApproveOnce.Keys()[0]))})
	if cmd == nil {
		t.Fatal("granting trust returned a nil cmd, want one that calls GrantWorkspaceTrust")
	}
	m, _ = m.Update(cmd())

	if fc.grantedWorkspaceTrust != "/home/user/project" {
		t.Fatalf("GrantWorkspaceTrust called with %q, want the workspace root", fc.grantedWorkspaceTrust)
	}
	if m.trustPromptRoot != "" {
		t.Fatalf("trustPromptRoot = %q after a successful grant, want empty", m.trustPromptRoot)
	}
}

// TestChat_TrustPrompt_DeclineClosesWithoutGranting is the 'n' path: the
// prompt closes immediately (no async round trip needed for "not now") and
// nothing is granted.
func TestChat_TrustPrompt_DeclineClosesWithoutGranting(t *testing.T) {
	fc := &fakeClient{workspaceUntrusted: true}
	m := NewChat(fc, "thread-1", "/home/user/project")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	m, _ = m.Update(workspaceTrustMsg{trusted: false, resolvedRoot: "/home/user/project"})

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(string(keys.DefaultApprovalKeyMap.Deny.Keys()[0]))})

	if m.trustPromptRoot != "" {
		t.Fatal("declining left trustPromptRoot set")
	}
	if fc.grantedWorkspaceTrust != "" {
		t.Fatal("declining must not call GrantWorkspaceTrust")
	}
}

// TestChat_TrustedWorkspace_NeverShowsThePrompt is the converse of all the
// above -- the default fakeClient (trusted) must never surface a prompt,
// which is what every pre-existing golden test already relies on.
func TestChat_TrustedWorkspace_NeverShowsThePrompt(t *testing.T) {
	fc := &fakeClient{}
	m := NewChat(fc, "thread-1", "/home/user/project")

	m, cmd := m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	if cmd == nil {
		t.Fatal("the first WindowSizeMsg returned a nil cmd, want one that checks workspace trust")
	}
	m, _ = m.Update(cmd())

	if m.trustPromptRoot != "" {
		t.Fatalf("trustPromptRoot = %q for a trusted workspace, want empty", m.trustPromptRoot)
	}
}
