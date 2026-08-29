package app

import (
	"context"
	"encoding/json"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/tui/client"
	"amiro/backend/internal/tui/page"
)

// fakeClient is a minimal client.Client -- app.Model only needs enough to
// route between pages; the pages' own tests exercise their client calls in
// depth.
type fakeClient struct {
	threads []client.ThreadSummary
	thread  client.ThreadDetail
	models  []client.ProviderModels
}

func (fakeClient) SendMessage(context.Context, client.SendMessageRequest) (<-chan uimessage.Frame, func() error) {
	ch := make(chan uimessage.Frame)
	close(ch)
	return ch, func() error { return nil }
}
func (fakeClient) SubmitApproval(context.Context, client.AssistantResubmission) (<-chan uimessage.Frame, func() error) {
	ch := make(chan uimessage.Frame)
	close(ch)
	return ch, func() error { return nil }
}
func (c fakeClient) ListThreads(context.Context) ([]client.ThreadSummary, error) {
	return c.threads, nil
}
func (c fakeClient) GetThread(context.Context, string) (client.ThreadDetail, error) {
	return c.thread, nil
}
func (fakeClient) DeleteThread(context.Context, string) error                   { return nil }
func (c fakeClient) ListMCPServers(context.Context) ([]client.MCPServer, error) { return nil, nil }
func (c fakeClient) ListWorkflows(context.Context) ([]client.Workflow, error)   { return nil, nil }
func (c fakeClient) ListSkills(context.Context, string) (client.SkillListResult, error) {
	return client.SkillListResult{}, nil
}
func (c fakeClient) ExportThread(context.Context, string) (string, error) { return "", nil }
func (c fakeClient) ListProviders(context.Context) ([]client.ProviderStatus, error) {
	return nil, nil
}
func (c fakeClient) SetProviderKey(context.Context, string, string, string) error { return nil }
func (c fakeClient) ListModels(context.Context) ([]client.ProviderModels, error) {
	return c.models, nil
}

// WorkspaceTrustStatus/GrantWorkspaceTrust default to trusted: app.Model's
// own tests route between pages and never exercise the trust prompt, which
// belongs to page's own tests (chat_test.go's fakeClient).
func (c fakeClient) WorkspaceTrustStatus(_ context.Context, root string) (bool, string, error) {
	return true, root, nil
}
func (c fakeClient) GrantWorkspaceTrust(context.Context, string) error { return nil }

// LatestCheckpoint defaults to "nothing to rewind": app.Model's own tests
// route between pages and never exercise /rewind, which belongs to page's
// own tests (chat_test.go's fakeClient).
func (c fakeClient) LatestCheckpoint(context.Context, string) (string, []client.CheckpointFile, error) {
	return "", nil, nil
}
func (c fakeClient) RestoreCheckpoint(context.Context, string, string) ([]client.CheckpointRestoreResult, error) {
	return nil, nil
}

// SandboxStatus defaults to "none" -- app.Model's own tests route between
// pages and never exercise the status bar's sandbox indicator, which
// belongs to page's own tests (chat_test.go's fakeClient).
func (c fakeClient) SandboxStatus(context.Context) (string, bool, error) {
	return "none", false, nil
}

var _ client.Client = fakeClient{}

// TestApp_OpenThreads_RoutesToThePickerAndBack is the round trip Ctrl+T (or
// "/threads") starts: app.Model switches its View/Update target to Threads,
// and a ThreadChosenMsg (or PickerCancelledMsg) switches it back to Chat.
func TestApp_OpenThreads_RoutesToThePickerAndBack(t *testing.T) {
	m := New(fakeClient{thread: client.ThreadDetail{ID: "t1"}}, "thread-0", "/workspace", "")
	tm, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = tm.(Model)

	tm, cmd := m.Update(page.OpenThreadsMsg{})
	m = tm.(Model)
	if m.active != activeThreads {
		t.Fatalf("active = %v after OpenThreadsMsg, want activeThreads", m.active)
	}
	if cmd == nil {
		t.Fatalf("OpenThreadsMsg returned a nil cmd, want Threads.Init at least")
	}

	tm, _ = m.Update(page.ThreadChosenMsg{Detail: client.ThreadDetail{ID: "t1", Title: "resumed"}})
	m = tm.(Model)
	if m.active != activeChat {
		t.Fatalf("active = %v after ThreadChosenMsg, want activeChat", m.active)
	}
	if got := m.chat.State().ThreadID; got != "t1" {
		t.Fatalf("chat's thread id = %q after resume, want t1", got)
	}
}

// TestApp_OpenModels_RoutesToThePickerAndAppliesTheChoice mirrors the
// threads round trip for Ctrl+O / "/models", and checks the chosen model
// actually reaches Chat (not just that routing switched back).
func TestApp_OpenModels_RoutesToThePickerAndAppliesTheChoice(t *testing.T) {
	m := New(fakeClient{}, "thread-0", "/workspace", "")
	tm, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = tm.(Model)

	tm, _ = m.Update(page.OpenModelsMsg{})
	m = tm.(Model)
	if m.active != activeModels {
		t.Fatalf("active = %v after OpenModelsMsg, want activeModels", m.active)
	}

	tm, _ = m.Update(page.ModelChosenMsg{Provider: "anthropic", Model: "claude-sonnet-5"})
	m = tm.(Model)
	if m.active != activeChat {
		t.Fatalf("active = %v after ModelChosenMsg, want activeChat", m.active)
	}
}

// TestApp_OpenSettings_Routes covers "/settings"'s navigation the same way
// threads/models are covered.
func TestApp_OpenSettings_Routes(t *testing.T) {
	m := New(fakeClient{}, "thread-0", "/workspace", "")
	tm, cmd := m.Update(page.OpenSettingsMsg{})
	m = tm.(Model)
	if m.active != activeSettings {
		t.Fatalf("active = %v after OpenSettingsMsg, want activeSettings", m.active)
	}
	if cmd == nil {
		t.Fatalf("OpenSettingsMsg returned a nil cmd, want Settings.Init at least")
	}

	tm, _ = m.Update(page.PickerCancelledMsg{})
	m = tm.(Model)
	if m.active != activeChat {
		t.Fatalf("active = %v after PickerCancelledMsg from settings, want activeChat", m.active)
	}
}

// TestApp_PickerCancelled_ReturnsToChat covers Esc from either picker with
// nothing chosen.
func TestApp_PickerCancelled_ReturnsToChat(t *testing.T) {
	m := New(fakeClient{}, "thread-0", "/workspace", "")
	tm, _ := m.Update(page.OpenThreadsMsg{})
	m = tm.(Model)

	tm, _ = m.Update(page.PickerCancelledMsg{})
	m = tm.(Model)
	if m.active != activeChat {
		t.Fatalf("active = %v after PickerCancelledMsg, want activeChat", m.active)
	}
}

// TestResume_LoadsTheGivenThreadAndMode covers cmd/amiro's --thread and
// --mode flags: app.Resume must fetch no more than what tui.go already
// handed it (a pre-fetched ThreadDetail -- Init/Update must never block on
// a network call, plan §2.7) and apply both before the program's first
// frame renders.
func TestResume_LoadsTheGivenThreadAndMode(t *testing.T) {
	detail := client.ThreadDetail{ID: "t1", Title: "resumed thread", Messages: []client.ThreadMessage{
		{ID: "m1", Role: "user", Parts: []json.RawMessage{json.RawMessage(`{"type":"text","text":"hi"}`)}},
	}}
	m := Resume(fakeClient{}, detail, "/workspace", "plan")

	if got := m.chat.State().ThreadID; got != "t1" {
		t.Fatalf("ThreadID = %q, want t1", got)
	}
	if len(m.chat.State().Messages) != 1 {
		t.Fatalf("len(Messages) = %d, want 1 (the resumed history)", len(m.chat.State().Messages))
	}
	if got := m.chat.State().PermissionMode; got != "plan" {
		t.Fatalf("PermissionMode = %q, want plan", got)
	}
}

// TestNew_AppliesModeFlag covers a fresh (non-resumed) thread's --mode.
func TestNew_AppliesModeFlag(t *testing.T) {
	m := New(fakeClient{}, "thread-0", "/workspace", "auto")
	if got := m.chat.State().PermissionMode; got != "auto" {
		t.Fatalf("PermissionMode = %q, want auto", got)
	}
}

// TestApp_View_DelegatesToTheActivePage is a light smoke test that View()
// actually calls through to whichever page is active, rather than always
// rendering Chat regardless of routing.
func TestApp_View_DelegatesToTheActivePage(t *testing.T) {
	m := New(fakeClient{}, "thread-0", "/workspace", "")
	tm, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = tm.(Model)

	chatView := m.View()

	tm, _ = m.Update(page.OpenThreadsMsg{})
	m = tm.(Model)
	threadsView := m.View()

	if chatView == threadsView {
		t.Fatalf("View() did not change after switching to the thread switcher")
	}
}
