package page

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"amiro/backend/internal/tui/client"
	"amiro/backend/internal/tui/component/editor"
)

func chatWithMentionables(fc *fakeClient) Chat {
	m := NewChat(fc, "thread-1", "/home/user/project")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})
	m, _ = m.Update(m.loadMentionables().(mentionablesLoadedMsg))
	return m
}

// TestChat_Init_LoadsMentionables is the Phase 4 TUI gate's mention-
// completion coverage, part 1: Init fetches MCP servers/workflows and
// merges them with the static default-tool list, so the very first "@" a
// user types already completes against real candidates.
func TestChat_Init_LoadsMentionables(t *testing.T) {
	fc := &fakeClient{
		mcp:       []client.MCPServer{{ID: "server-1", Name: "github", Tools: []string{"create_issue"}}},
		workflows: []client.Workflow{{ID: "wf-1", Name: "DeployPipeline"}},
	}
	m := NewChat(fc, "thread-1", "/home/user/project")

	cmd := m.Init()
	if cmd == nil {
		t.Fatalf("Init() returned a nil cmd, want one that loads mentionables")
	}
	msg := findMentionablesLoadedMsg(t, cmd())
	m, _ = m.Update(msg)

	var sawMCPTool, sawMCPServer, sawWorkflow, sawDefaultTool bool
	for _, c := range m.mentionCandidates {
		switch {
		case c.Kind == editor.MentionMCPTool && c.Name == "github/create_issue":
			sawMCPTool = true
		case c.Kind == editor.MentionMCPServer && c.ServerID == "server-1":
			sawMCPServer = true
		case c.Kind == editor.MentionWorkflow && c.WorkflowID == "wf-1":
			sawWorkflow = true
		case c.Kind == editor.MentionDefaultTool && c.Name == "read_file":
			sawDefaultTool = true
		}
	}
	if !sawMCPTool || !sawMCPServer || !sawWorkflow || !sawDefaultTool {
		t.Fatalf("mentionCandidates missing a category: mcpTool=%v mcpServer=%v workflow=%v defaultTool=%v",
			sawMCPTool, sawMCPServer, sawWorkflow, sawDefaultTool)
	}
}

// findMentionablesLoadedMsg unwraps Init()'s tea.Batch to find the message
// loadMentionables produces -- Init also returns textarea.Blink's cmd
// batched alongside it.
func findMentionablesLoadedMsg(t *testing.T, msg tea.Msg) mentionablesLoadedMsg {
	t.Helper()
	if m, ok := msg.(mentionablesLoadedMsg); ok {
		return m
	}
	batch, ok := msg.(tea.BatchMsg)
	if !ok {
		t.Fatalf("Init()'s cmd produced %T, want mentionablesLoadedMsg or a tea.BatchMsg containing one", msg)
	}
	for _, cmd := range batch {
		if cmd == nil {
			continue
		}
		if m, ok := cmd().(mentionablesLoadedMsg); ok {
			return m
		}
	}
	t.Fatalf("no mentionablesLoadedMsg found in Init()'s batch")
	return mentionablesLoadedMsg{}
}

// TestChat_TabAcceptsMentionSuggestion is the Phase 4 TUI gate's mention-
// completion coverage, part 2: typing "@" and pressing Tab fills in the
// top match and records it for the next SendMessage.
func TestChat_TabAcceptsMentionSuggestion(t *testing.T) {
	fc := &fakeClient{workflows: []client.Workflow{{ID: "wf-1", Name: "CodeReviewer"}}}
	m := chatWithMentionables(fc)

	m.input.SetValue("ask @Code")
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyTab})

	if got := m.input.Value(); got != "ask @CodeReviewer " {
		t.Fatalf("composer value = %q, want %q", got, "ask @CodeReviewer ")
	}
	if len(m.pendingMentions) != 1 || m.pendingMentions[0].WorkflowID != "wf-1" {
		t.Fatalf("pendingMentions = %+v, want one entry for wf-1", m.pendingMentions)
	}
}

// TestChat_Send_AttachesAndClearsPendingMentions proves the accepted
// mention actually reaches SendMessageRequest.Mentions, and that sending
// resets the pending list so it isn't accidentally re-attached to the next,
// unrelated message.
func TestChat_Send_AttachesAndClearsPendingMentions(t *testing.T) {
	fc := &fakeClient{workflows: []client.Workflow{{ID: "wf-1", Name: "CodeReviewer"}}}
	m := chatWithMentionables(fc)

	m.input.SetValue("ask @Code")
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m, _ = m.send()

	if fc.lastSend == nil {
		t.Fatalf("SendMessage was not called")
	}
	if len(fc.lastSend.Mentions) != 1 || fc.lastSend.Mentions[0].Type != "workflow" || fc.lastSend.Mentions[0].WorkflowID != "wf-1" {
		t.Fatalf("lastSend.Mentions = %+v, want one workflow mention for wf-1", fc.lastSend.Mentions)
	}
	if len(m.pendingMentions) != 0 {
		t.Fatalf("pendingMentions = %+v after send, want cleared", m.pendingMentions)
	}
}

// TestChat_SlashCompact_SendsCompactNow is the backend/TUI seam for
// "/compact": it must go through the normal send path but with
// CompactNow set, not a separate mechanism.
func TestChat_SlashCompact_SendsCompactNow(t *testing.T) {
	m := chatAt(100, 24)
	m.input.SetValue("/compact")
	m, cmd := m.send()

	if cmd == nil {
		t.Fatalf("/compact returned a nil cmd, want tea.Batch(waitForFrame, tickCmd)")
	}
	fc := m.c.(*fakeClient)
	if fc.lastSend == nil || !fc.lastSend.CompactNow {
		t.Fatalf("lastSend = %+v, want CompactNow=true", fc.lastSend)
	}
}

// TestChat_SlashExport_CallsExportThreadAndShowsANotice covers "/export":
// it must call ExportThread for the open thread and surface the result as
// a notice, distinct in tone from an error.
func TestChat_SlashExport_CallsExportThreadAndShowsANotice(t *testing.T) {
	fc := &fakeClient{exportID: "export-123"}
	m := NewChat(fc, "thread-1", "/home/user/project")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 24})

	m.input.SetValue("/export")
	m, cmd := m.send()
	if cmd == nil {
		t.Fatalf("/export returned a nil cmd")
	}
	m, _ = m.Update(cmd())

	if fc.exportedThread != "thread-1" {
		t.Fatalf("ExportThread called with thread %q, want thread-1", fc.exportedThread)
	}
	if m.notice == "" || m.state.Err != nil {
		t.Fatalf("notice = %q, state.Err = %v, want a non-error notice mentioning the export", m.notice, m.state.Err)
	}
}

// TestChat_SlashSettings_OpensSettingsPage covers "/settings" navigation.
func TestChat_SlashSettings_OpensSettingsPage(t *testing.T) {
	m := chatAt(100, 24)
	m.input.SetValue("/settings")
	_, cmd := m.send()
	if _, ok := cmd().(OpenSettingsMsg); !ok {
		t.Fatalf("/settings yielded %T, want OpenSettingsMsg", cmd())
	}
}
