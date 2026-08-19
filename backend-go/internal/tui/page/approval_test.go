package page

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/exp/golden"

	"amiro/backend/internal/ai/uimessage"
)

// approvalFrame builds the exact frame tool_scheduler.go's
// suspendForApproval emits, the same fixture session's approval_test.go
// uses -- this page-level test drives it through the real Update/View path
// rather than session.Reduce directly.
func approvalFrame(toolCallID, toolName, risk, reason, command string, compound bool) uimessage.Frame {
	data := map[string]any{"toolCallId": toolCallID, "toolName": toolName, "risk": risk, "reason": reason}
	if command != "" {
		data["command"] = command
		data["compound"] = compound
	}
	raw, _ := json.Marshal(data)
	return uimessage.Frame{Type: uimessage.DataFrameType("tool-approval"), ID: toolCallID, Data: raw}
}

var suspendedTurnFrames = []uimessage.Frame{
	{Type: uimessage.FrameStart, MessageID: "asst-1"},
	{Type: uimessage.FrameStartStep},
	{Type: uimessage.FrameTextStart, ID: "t1"},
	{Type: uimessage.FrameTextDelta, ID: "t1", Delta: "I'll run the test suite."},
	{Type: uimessage.FrameTextEnd, ID: "t1"},
	{Type: uimessage.FrameToolInputStart, ToolCallID: "call-1", ToolName: "run_shell"},
	{Type: uimessage.FrameToolInputAvailable, ToolCallID: "call-1", ToolName: "run_shell", Input: []byte(`{"command":"go test ./..."}`)},
	approvalFrame("call-1", "run_shell", "exec", "run_shell needs approval", "go test ./...", false),
	{Type: uimessage.FrameFinishStep},
	{Type: uimessage.FrameFinish, MessageMetadata: []byte(`{"usage":{"PromptTokens":50,"CompletionTokens":10,"TotalTokens":60},"durationMs":800}`)},
	{Type: uimessage.FrameDone},
}

// TestChat_Golden_ApprovalDialog is the Phase 3 TUI gate's "approval dialog
// golden": a data-tool-approval frame renders the dialog inline in the
// transcript, with the composer's hint switched to y/a/n, at both widths.
func TestChat_Golden_ApprovalDialog(t *testing.T) {
	for _, width := range []int{80, 120} {
		t.Run(fmt.Sprintf("width_%d", width), func(t *testing.T) {
			m, clock := newGoldenChat(width, 30)
			m.input.SetValue("run the test suite")
			m, _ = m.send()
			clock.advance(2 * time.Second)

			for _, f := range suspendedTurnFrames {
				m, _ = m.Update(frameMsg(f))
			}
			m, _ = m.Update(streamEndMsg{})

			golden.RequireEqual(t, []byte(m.View()))
		})
	}
}

func newSuspendedChat(t *testing.T) (Chat, *fakeClient) {
	t.Helper()
	fc := &fakeClient{}
	m := NewChat(fc, "thread-golden-0001", "/home/user/project")
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m.input.SetValue("run the test suite")
	m, _ = m.send()
	for _, f := range suspendedTurnFrames {
		m, _ = m.Update(frameMsg(f))
	}
	m, _ = m.Update(streamEndMsg{})
	if m.state.PendingApproval == nil {
		t.Fatalf("PendingApproval = nil after the suspended-turn fixture, want a request")
	}
	return m, fc
}

// TestChat_ApprovalDialog_BlocksComposerInput proves the dialog really
// intercepts the keyboard: normal keys (typed text, Enter-to-send) must not
// reach the textarea while the turn is suspended -- the plan's "render it
// as though it were blocking" (§2.4) would otherwise be cosmetic only.
func TestChat_ApprovalDialog_BlocksComposerInput(t *testing.T) {
	m, _ := newSuspendedChat(t)

	before := m.input.Value()
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hello")})
	if got := m.input.Value(); got != before {
		t.Fatalf("composer value = %q after typing while a dialog is open, want unchanged %q", got, before)
	}

	// Enter must not send a chat message either -- SendMessage should not be
	// called *again* while PendingApproval is set (newSuspendedChat's own
	// setup already called it once, to start the turn that then suspended).
	fc := m.c.(*fakeClient)
	beforeSend := fc.lastSend
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if fc.lastSend != beforeSend {
		t.Fatalf("SendMessage was called again while an approval dialog was open")
	}
}

// TestChat_ApprovalDialog_ApproveOnce_ResubmitsWithTheAnswer is the
// resubmission half of the rail: pressing 'y' must call SubmitApproval with
// the exact wire parts session.BuildApprovalResubmission built --
// specifically, the answered part's output carrying the `__tag` the backend
// requires (approvals.go's parseApprovalAnswer), not the desktop app's old
// `__$ref__` mistake this phase also fixed.
func TestChat_ApprovalDialog_ApproveOnce_ResubmitsWithTheAnswer(t *testing.T) {
	m, fc := newSuspendedChat(t)

	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
	if cmd == nil {
		t.Fatalf("answering 'y' returned a nil cmd, want tea.Batch(waitForFrame, tickCmd)")
	}
	if m.state.PendingApproval != nil {
		t.Fatalf("PendingApproval still set after answering")
	}
	if fc.lastApproval == nil {
		t.Fatalf("SubmitApproval was not called")
	}
	if fc.lastApproval.MessageID != "asst-1" {
		t.Fatalf("MessageID = %q, want asst-1 (the paused message's own id)", fc.lastApproval.MessageID)
	}

	var found bool
	for _, raw := range fc.lastApproval.Parts {
		var p struct {
			Type   string          `json:"type"`
			Output json.RawMessage `json:"output"`
		}
		if json.Unmarshal(raw, &p) != nil || p.Type != "tool-run_shell" {
			continue
		}
		var answer struct {
			Tag     string `json:"__tag"`
			Confirm bool   `json:"confirm"`
			Scope   string `json:"scope"`
		}
		if json.Unmarshal(p.Output, &answer) == nil && answer.Tag == "manual-tool-confirm" {
			found = true
			if !answer.Confirm || answer.Scope != "once" {
				t.Fatalf("answer = %+v, want confirm=true scope=once", answer)
			}
		}
	}
	if !found {
		t.Fatalf("no resubmitted part carried a manual-tool-confirm answer: %v", fc.lastApproval.Parts)
	}
}

// TestChat_ApprovalDialog_AlwaysAllow covers the 'a' key's scope, and
// TestChat_ApprovalDialog_Deny covers 'n' -- the three answers Appendix B's
// keymap names, each landing at the right (confirm, scope) pair.
func TestChat_ApprovalDialog_AlwaysAllow(t *testing.T) {
	m, fc := newSuspendedChat(t)
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a")})
	assertAnswer(t, fc, true, "always")
	_ = m
}

func TestChat_ApprovalDialog_Deny(t *testing.T) {
	m, fc := newSuspendedChat(t)
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("n")})
	assertAnswer(t, fc, false, "")
	_ = m
}

func assertAnswer(t *testing.T, fc *fakeClient, wantConfirm bool, wantScope string) {
	t.Helper()
	if fc.lastApproval == nil {
		t.Fatalf("SubmitApproval was not called")
	}
	for _, raw := range fc.lastApproval.Parts {
		var p struct {
			Type   string          `json:"type"`
			Output json.RawMessage `json:"output"`
		}
		if json.Unmarshal(raw, &p) != nil || p.Type != "tool-run_shell" {
			continue
		}
		var answer struct {
			Confirm bool   `json:"confirm"`
			Scope   string `json:"scope"`
		}
		if json.Unmarshal(p.Output, &answer) == nil {
			if answer.Confirm != wantConfirm || answer.Scope != wantScope {
				t.Fatalf("answer = %+v, want confirm=%v scope=%q", answer, wantConfirm, wantScope)
			}
			return
		}
	}
	t.Fatalf("no tool-run_shell part found in resubmitted parts: %v", fc.lastApproval.Parts)
}

// TestChat_SlashMode_SwitchesLivePermissionModeAndStatusBar is the Phase 3
// TUI gate's "mode-switch test": "/mode plan" changes what every future
// request carries (component/status's Info.Mode field, wired to
// session.State.PermissionMode) without a server round trip.
func TestChat_SlashMode_SwitchesLivePermissionModeAndStatusBar(t *testing.T) {
	m := chatAt(100, 24)

	if got := m.modeLabel(); got != "interactive" {
		t.Fatalf("modeLabel() before any /mode = %q, want interactive (the server's own default)", got)
	}

	m.input.SetValue("/mode plan")
	m, _ = m.send()

	if got := m.state.PermissionMode; got != "plan" {
		t.Fatalf("PermissionMode = %q after /mode plan, want plan", got)
	}
	if got := m.modeLabel(); got != "plan" {
		t.Fatalf("modeLabel() = %q, want plan", got)
	}
	if !strings.Contains(m.statusBar(), "plan") {
		t.Fatalf("status bar %q does not mention the new mode", m.statusBar())
	}

	fc := m.c.(*fakeClient)
	m.input.SetValue("hello")
	m, _ = m.send()
	if fc.lastSend == nil || fc.lastSend.PermissionMode != "plan" {
		t.Fatalf("SendMessage's PermissionMode = %+v, want plan carried on the next real turn too", fc.lastSend)
	}
}

// TestChat_SlashMode_RejectsAnUnknownMode guards the parse: a typo must not
// silently become an unrecognized-but-accepted mode string sent to the
// server, which permission.ParseMode would just read as interactive anyway
// -- better to say so in the TUI than degrade silently.
func TestChat_SlashMode_RejectsAnUnknownMode(t *testing.T) {
	m := chatAt(100, 24)
	m.input.SetValue("/mode yolo")
	m, _ = m.send()

	if m.state.PermissionMode != "" {
		t.Fatalf("PermissionMode = %q after an invalid /mode, want unchanged (empty)", m.state.PermissionMode)
	}
	if m.state.Err == nil {
		t.Fatalf("state.Err = nil after an invalid /mode, want an error explaining the valid choices")
	}
}

// TestChat_SlashThreadsAndModels_OpenTheRightPage is the composer's palette
// half of the Phase 3 gate: typing the command and pressing enter must
// signal the same navigation the direct keybindings do, so app.Model can
// route to the picker.
func TestChat_SlashThreadsAndModels_OpenTheRightPage(t *testing.T) {
	m := chatAt(100, 24)
	m.input.SetValue("/threads")
	_, cmd := m.send()
	if cmd == nil {
		t.Fatalf("/threads returned a nil cmd, want one yielding OpenThreadsMsg")
	}
	if _, ok := cmd().(OpenThreadsMsg); !ok {
		t.Fatalf("/threads' cmd yielded %T, want OpenThreadsMsg", cmd())
	}

	m2 := chatAt(100, 24)
	m2.input.SetValue("/models")
	_, cmd2 := m2.send()
	if _, ok := cmd2().(OpenModelsMsg); !ok {
		t.Fatalf("/models' cmd yielded %T, want OpenModelsMsg", cmd2())
	}
}

// TestChat_CtrlT_CtrlO_OpenTheSamePages is Appendix B's direct shortcuts --
// the same destinations as the slash commands, reached without typing.
func TestChat_CtrlT_CtrlO_OpenTheSamePages(t *testing.T) {
	m := chatAt(100, 24)
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlT})
	if _, ok := cmd().(OpenThreadsMsg); !ok {
		t.Fatalf("ctrl+t yielded %T, want OpenThreadsMsg", cmd())
	}

	_, cmd = m.Update(tea.KeyMsg{Type: tea.KeyCtrlO})
	if _, ok := cmd().(OpenModelsMsg); !ok {
		t.Fatalf("ctrl+o yielded %T, want OpenModelsMsg", cmd())
	}
}

func chatAt(width, height int) Chat {
	m := NewChat(&fakeClient{}, "thread-1", "/home/user/project")
	m, _ = m.Update(tea.WindowSizeMsg{Width: width, Height: height})
	return m
}
