package client

import (
	"context"
	"encoding/json"
	"testing"

	"amiro/backend/internal/ai/uimessage"
)

// This file is the Phase 5 backend gate: "Layer 5 multi-client e2e (one
// embedded server, two independent HTTPClients on one thread, same event
// stream, intact persisted thread)" -- crush's multiclient_test.go pattern
// (docs/tui-implementation-plan.md Part 5), adapted to this tree's own test
// server. It also stands in for the "desktop unaffected while a TUI is
// attached" gate: nothing here distinguishes which client is "the TUI" and
// which is "the desktop app" -- two HTTPClient values against the same
// server, same session, same thread, is exactly what that scenario reduces
// to at the wire level, and there is no code path in this tree that could
// tell the two apart.
//
// Every test here builds two *independent* HTTPClient values (never reusing
// one connection for both roles, unlike most other tests in this package) --
// the same shape TestHTTPClient_SetProviderKey_IsVisibleToAnyOtherClientOfTheSameServer
// established in Phase 4 for exactly this reason: reusing one client would
// leave open the possibility that some field on *HTTPClient itself is
// silently carrying state that ought to live on the server.

// TestMultiClient_BothClientsSeeTheSamePersistedThread is the core "same
// event stream, intact persisted thread" property: client A sends a
// message, client B (a second, independent connection, same signed-in
// user) reads it back, sends a second message on the same thread, and
// client A reads the full, correctly-ordered history back -- proving
// neither connection needed to have sent a message itself to see the
// other's.
func TestMultiClient_BothClientsSeeTheSamePersistedThread(t *testing.T) {
	baseURL, authToken := testServer(t, fakeEngine{deltas: []string{"reply one"}})
	sessionToken := registerAndLogin(t, baseURL, authToken)

	clientA := New(Config{BaseURL: baseURL, AuthToken: authToken, SessionToken: sessionToken})
	clientB := New(Config{BaseURL: baseURL, AuthToken: authToken, SessionToken: sessionToken})

	frames, wait := clientA.SendMessage(context.Background(), SendMessageRequest{
		ThreadID: "shared-thread", MessageID: "msg-a1", Text: "hello from A",
	})
	for range frames {
	}
	if err := wait(); err != nil {
		t.Fatalf("clientA SendMessage wait() = %v, want nil", err)
	}

	detail, err := clientB.GetThread(context.Background(), "shared-thread")
	if err != nil {
		t.Fatalf("clientB GetThread: %v", err)
	}
	if len(detail.Messages) != 2 {
		t.Fatalf("clientB sees %d messages after A's turn, want 2 (user + assistant)", len(detail.Messages))
	}

	// Now the second connection writes to the same thread.
	frames2, wait2 := clientB.SendMessage(context.Background(), SendMessageRequest{
		ThreadID: "shared-thread", MessageID: "msg-b1", Text: "hello from B",
	})
	for range frames2 {
	}
	if err := wait2(); err != nil {
		t.Fatalf("clientB SendMessage wait() = %v, want nil", err)
	}

	final, err := clientA.GetThread(context.Background(), "shared-thread")
	if err != nil {
		t.Fatalf("clientA GetThread: %v", err)
	}
	if len(final.Messages) != 4 {
		t.Fatalf("clientA sees %d messages after both turns, want 4 -- a connection's own writes should not be invisible to, or duplicated for, the other", len(final.Messages))
	}
	wantRoles := []string{"user", "assistant", "user", "assistant"}
	for i, m := range final.Messages {
		if m.Role != wantRoles[i] {
			t.Fatalf("final.Messages[%d].Role = %q, want %q (order across both connections must match send order)", i, m.Role, wantRoles[i])
		}
	}
	if final.Messages[0].ID != "msg-a1" || final.Messages[2].ID != "msg-b1" {
		t.Fatalf("user message ids = [%q, %q], want [msg-a1, msg-b1] in send order", final.Messages[0].ID, final.Messages[2].ID)
	}
}

// TestMultiClient_ApprovalSuspendedByOneClientIsResolvableByAnother is the
// strongest test in this file for "no per-connection state anywhere should
// let them disagree": client A's turn suspends for approval (the same rail
// Phase 3 built), and client B -- a connection that never sent the original
// message and has no local memory of it beyond what GetThread told it --
// resubmits the answer and the turn completes. If the suspend/answer rail
// held anything in memory keyed to the connection that opened the stream
// (rather than the thread, in the database), this would hang or 404 instead
// of completing.
func TestMultiClient_ApprovalSuspendedByOneClientIsResolvableByAnother(t *testing.T) {
	baseURL, authToken := testServer(t, approvalEngine{})
	sessionToken := registerAndLogin(t, baseURL, authToken)
	workspace := t.TempDir()

	clientA := New(Config{BaseURL: baseURL, AuthToken: authToken, SessionToken: sessionToken})
	clientB := New(Config{BaseURL: baseURL, AuthToken: authToken, SessionToken: sessionToken})

	frames, wait := clientA.SendMessage(context.Background(), SendMessageRequest{
		ThreadID: "shared-thread", MessageID: "msg-1", Text: "run the tests", WorkspaceRoot: workspace,
	})
	var approvalData json.RawMessage
	var assistantMessageID string
	for f := range frames {
		switch f.Type {
		case uimessage.FrameStart:
			assistantMessageID = f.MessageID
		case uimessage.DataFrameType("tool-approval"):
			approvalData = f.Data
		}
	}
	if err := wait(); err != nil || approvalData == nil {
		t.Fatalf("clientA's turn: wait()=%v approvalData=%s, want a clean suspend", err, approvalData)
	}

	// clientB never saw the SendMessage call above -- everything it needs
	// (the tool call id, the approval payload) it learns only from the
	// thread it can already read, the same way a desktop window that had
	// this thread open would.
	detail, err := clientB.GetThread(context.Background(), "shared-thread")
	if err != nil {
		t.Fatalf("clientB GetThread: %v", err)
	}
	if len(detail.Messages) != 2 || detail.Messages[1].ID != assistantMessageID {
		t.Fatalf("clientB's view of the paused thread = %+v, want the paused assistant message visible by its real id", detail.Messages)
	}

	var approval struct {
		ToolCallID string `json:"toolCallId"`
	}
	if err := json.Unmarshal(approvalData, &approval); err != nil {
		t.Fatalf("decode approval data: %v", err)
	}
	answer, _ := json.Marshal(map[string]any{"__tag": "manual-tool-confirm", "confirm": true, "scope": "once"})
	toolPart, _ := json.Marshal(map[string]any{
		"type": "tool-run_shell", "toolCallId": approval.ToolCallID,
		"input": map[string]any{"command": "go test ./..."}, "state": "output-available",
		"output": json.RawMessage(answer),
	})
	approvalPart, _ := json.Marshal(map[string]any{
		"type": "data-tool-approval", "id": approval.ToolCallID, "data": json.RawMessage(approvalData),
	})

	resumeFrames, resumeWait := clientB.SubmitApproval(context.Background(), AssistantResubmission{
		ThreadID: "shared-thread", MessageID: assistantMessageID,
		Parts: []json.RawMessage{json.RawMessage(toolPart), json.RawMessage(approvalPart)}, WorkspaceRoot: workspace,
	})
	var gotFinalText string
	for f := range resumeFrames {
		if f.Type == uimessage.FrameTextDelta {
			gotFinalText += f.Delta
		}
	}
	if err := resumeWait(); err != nil {
		t.Fatalf("clientB's resume wait() = %v, want nil -- a connection that did not open the original stream must still be able to resolve its approval", err)
	}
	if gotFinalText != "Ran the tests." {
		t.Fatalf("final text = %q, want %q", gotFinalText, "Ran the tests.")
	}

	// clientA, which opened the original request, reads the same resolved
	// state clientB just wrote -- the two connections end up agreeing, not
	// each holding a different idea of what happened to this thread.
	final, err := clientA.GetThread(context.Background(), "shared-thread")
	if err != nil {
		t.Fatalf("clientA GetThread: %v", err)
	}
	if len(final.Messages) != 2 {
		t.Fatalf("clientA sees %d messages, want 2 (one assistant row, resolved by the other connection, not a second one)", len(final.Messages))
	}
}
