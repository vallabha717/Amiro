// Package approvals_test proves Phase 7's "Approval across clients"
// cross-surface journey, quoted verbatim from the Section 1 table of
// docs/testing/phases/phase-07-cross-surface.md:
//
//	| Approval across clients | A turn started in the TUI and approved in the browser (and the reverse) behaves per design |
//
// and contributes to Exit Criterion 1, quoted verbatim: "`amirotest run
// --surface cross` passes, and every cross-surface journey above has a
// test."
//
// WHAT "PER DESIGN" IS, AND WHY THAT IS THE INTERESTING QUESTION.
// The row is only meaningful once you know how an approval is keyed, and
// the answer is the thing this suite exists to assert. Amiro has no
// /approve endpoint and no held-open connection waiting on a channel:
// internal/api/chat/tool_scheduler.go's suspendForApproval leaves the tool
// call in "input-available", emits a data-tool-approval part, ends the turn,
// and persists all of it; the answer arrives later as an ORDINARY POST
// /api/chat whose message is the assistant message being continued, with
// `{"__tag":"manual-tool-confirm","confirm":true}` sitting where that tool
// call's output goes (internal/api/chat/approvals.go's parseApprovalAnswer
// and resolveApprovals). That file's own doc comment says why: a second rail
// "would need session state, would not survive a refresh".
//
// So the approval is keyed by THREAD AND TOOL CALL, in the database -- not
// by the session or connection that started the turn. The consequence, which
// is exactly what the row is asking about, is that any authenticated client
// holding the thread owner's session can answer a pending approval, and the
// answered tool really runs server-side. That is asserted here in both
// directions, plus the security boundary that makes it safe: a DIFFERENT
// user's client cannot answer it.
//
// WHO PLAYS WHOM.
// TestCrossSurface_TurnStartedInTheTUIIsApprovedByAnotherClient uses the
// real `amiro` binary under a real PTY for the "started in the TUI" half --
// a real approval dialog on a real terminal -- and a second
// apiclient.Client for "approved in the browser". The other two tests use
// two apiclient.Clients, because the property they isolate (which identity
// may answer, and whether the answer is connection-scoped) is an HTTP-layer
// property with no rendering in it. `cross` is a Go-test surface, so there
// is no DOM; the substitution is faithful because the dashboard's approval
// card sends precisely the resubmission built below.
//
// A CONSEQUENCE OF THE DESIGN, NOT ASSERTED HERE.
// Because there is no push, a TUI whose dialog was answered elsewhere is not
// told: it keeps rendering its card until the thread is reloaded, and a user
// who then presses "y" would resubmit a second answer. That is stated so it
// is not mistaken for something these tests cover; pinning it with an
// assertion would freeze a limitation as intended behaviour.
package approvals_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/assert"
	"amiro/tests/harness/fakeprovider"
	"amiro/tests/harness/pty"
)

// approvalAnswer mirrors internal/api/chat's approvalAnswer -- transcribed,
// not imported, per the apiclient package's own rule. The `__tag` spelling
// is load-bearing: internal/tui/session/resubmit.go records that a frontend
// copy of this shape once used a different key and silently never answered
// a single approval.
type approvalAnswer struct {
	Tag     string `json:"__tag"`
	Confirm bool   `json:"confirm"`
	Scope   string `json:"scope,omitempty"`
}

const approvalTag = "manual-tool-confirm"

// pendingApproval finds a suspended tool call in a thread the way any client
// reloading that thread would: by reading the persisted parts, not by having
// watched the stream that produced them.
type pendingApproval struct {
	MessageID  string
	ToolCallID string
	ToolName   string
	Parts      []json.RawMessage
}

func findPendingApproval(detail apiclient.ThreadDetail) (pendingApproval, bool) {
	for i := len(detail.Messages) - 1; i >= 0; i-- {
		m := detail.Messages[i]
		if m.Role != "assistant" {
			continue
		}
		var parts []json.RawMessage
		if err := json.Unmarshal(m.Parts, &parts); err != nil {
			continue
		}
		var sawApprovalRequest bool
		for _, raw := range parts {
			var p struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &p) == nil && p.Type == "data-tool-approval" {
				sawApprovalRequest = true
			}
		}
		if !sawApprovalRequest {
			continue
		}
		for _, raw := range parts {
			var p struct {
				Type       string `json:"type"`
				ToolCallID string `json:"toolCallId"`
				State      string `json:"state"`
			}
			if err := json.Unmarshal(raw, &p); err != nil {
				continue
			}
			if len(p.Type) > 5 && p.Type[:5] == "tool-" && p.State == "input-available" {
				return pendingApproval{
					MessageID:  m.ID,
					ToolCallID: p.ToolCallID,
					ToolName:   p.Type[5:],
					Parts:      parts,
				}, true
			}
		}
	}
	return pendingApproval{}, false
}

// answer builds the continuation message: the same assistant message, with
// the suspended call's output replaced by the confirm/deny tag. This is
// byte-equivalent to what internal/tui/session's BuildApprovalResubmission
// and the desktop app's ManualToolConfirmTag both send.
func (p pendingApproval) answer(t *testing.T, confirm bool) apiclient.ChatMessage {
	t.Helper()
	tag, err := json.Marshal(approvalAnswer{Tag: approvalTag, Confirm: confirm})
	if err != nil {
		t.Fatal(err)
	}

	out := make([]json.RawMessage, 0, len(p.Parts))
	replaced := false
	for _, raw := range p.Parts {
		var probe struct {
			Type       string          `json:"type"`
			ToolCallID string          `json:"toolCallId"`
			Input      json.RawMessage `json:"input"`
			State      string          `json:"state"`
		}
		if err := json.Unmarshal(raw, &probe); err != nil || probe.ToolCallID != p.ToolCallID || probe.State != "input-available" {
			out = append(out, raw)
			continue
		}
		input := probe.Input
		if len(input) == 0 {
			input = json.RawMessage("{}")
		}
		answered, err := json.Marshal(map[string]any{
			"type":       probe.Type,
			"toolCallId": probe.ToolCallID,
			"input":      input,
			"state":      "output-available",
			"output":     json.RawMessage(tag),
		})
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, answered)
		replaced = true
	}
	if !replaced {
		t.Fatalf("no suspended tool part with id %s was found to answer", p.ToolCallID)
	}
	// Role "assistant" is what makes RunTurn treat this as a continuation of
	// the same message rather than a new turn (runner.go: `continuing :=
	// req.Message.Role == "assistant"`).
	return apiclient.ChatMessage{ID: p.MessageID, Role: "assistant", Parts: out}
}

func twoClients(t *testing.T, h *harness.Harness) (*apiclient.Client, *apiclient.Client) {
	t.Helper()
	id := h.Identity("admin")
	return h.Client().As("tui", id.Token), h.Client().As("browser", id.Token)
}

// TestCrossSurface_TurnStartedInOneClientIsApprovedByAnother covers both
// directions of the row with the surfaces swapped between subtests, since
// the two clients are symmetric by construction.
func TestCrossSurface_TurnStartedInOneClientIsApprovedByAnother(t *testing.T) {
	cases := []struct {
		name      string
		starter   string
		approver  string
		probe     string
		file      string
		content   string
		reply     string
		threadID  string
		messageID string
	}{
		{
			name: "started in the tui, approved in the browser", starter: "tui", approver: "browser",
			probe: "cross approval started in the terminal", file: "approved_by_browser.txt",
			content: "written after the browser approved\n", reply: "Terminal-started write done.",
			threadID: "cross-approval-tui-to-browser", messageID: "cross-approval-msg-tui",
		},
		{
			name: "started in the browser, approved in the tui", starter: "browser", approver: "tui",
			probe: "cross approval started in the browser", file: "approved_by_tui.txt",
			content: "written after the terminal approved\n", reply: "Browser-started write done.",
			threadID: "cross-approval-browser-to-tui", messageID: "cross-approval-msg-browser",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
				s.OnPrompt(fakeprovider.Contains(tc.probe)).
					ToolCall("write_file", map[string]any{"path": tc.file, "content": tc.content}).
					ThenStreamText(tc.reply)
			}))
			be := h.Backend()
			tui, browser := twoClients(t, h)
			clients := map[string]*apiclient.Client{"tui": tui, "browser": browser}
			starter, approver := clients[tc.starter], clients[tc.approver]

			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()

			if _, err := starter.ChatTurn(ctx, apiclient.ChatRequest{
				ID:             tc.threadID,
				Message:        apiclient.TextMessage(tc.messageID, tc.probe),
				PermissionMode: "interactive",
				WorkspaceRoot:  be.WorkspaceRoot,
			}); err != nil {
				t.Fatalf("the %s-side turn failed instead of suspending for approval: %v", tc.starter, err)
			}

			target := filepath.Join(be.WorkspaceRoot, tc.file)
			if _, err := os.Stat(target); !os.IsNotExist(err) {
				t.Fatalf("%s exists before anyone approved anything; interactive mode did not gate the write "+
					"(stat error: %v)", target, err)
			}

			// The approver has never seen the starter's stream. It finds the
			// pending call the only way a separate client can: by reading the
			// thread back out of the shared database.
			detail, err := approver.GetThread(ctx, tc.threadID)
			if err != nil {
				t.Fatalf("%s-side GET /api/thread/%s: %v", tc.approver, tc.threadID, err)
			}
			pending, ok := findPendingApproval(detail)
			if !ok {
				t.Fatalf("the %s-side client found no pending approval in thread %s; a suspended turn must be "+
					"discoverable from the persisted thread, not only from the originating stream\nmessages: %s",
					tc.approver, tc.threadID, detail.Messages)
			}
			if pending.ToolName != "write_file" {
				t.Fatalf("pending approval is for %q, expected write_file", pending.ToolName)
			}

			if _, err := approver.ChatTurn(ctx, apiclient.ChatRequest{
				ID:             tc.threadID,
				Message:        pending.answer(t, true),
				PermissionMode: "interactive",
				WorkspaceRoot:  be.WorkspaceRoot,
			}); err != nil {
				t.Fatalf("the %s-side client could not answer an approval raised by the %s-side client: %v",
					tc.approver, tc.starter, err)
			}

			// The file is the proof: the approved call actually ran
			// server-side, on the back of an answer given by a different
			// client than the one that asked.
			assert.Eventually(t, "the approved tool call to have run", 15*time.Second, func() error {
				data, err := os.ReadFile(target)
				if err != nil {
					return fmt.Errorf("reading %s: %w", target, err)
				}
				if string(data) != tc.content {
					return fmt.Errorf("%s = %q, want %q", target, data, tc.content)
				}
				return nil
			})
		})
	}
}

// TestCrossSurface_ApprovalRaisedForOneUserCannotBeAnsweredByAnother is the
// security half of "behaves per design". Approval being keyed by thread
// rather than by connection is only safe if thread ownership is still
// enforced on the continuation.
func TestCrossSurface_ApprovalRaisedForOneUserCannotBeAnsweredByAnother(t *testing.T) {
	const probe = "cross approval ownership probe"
	const file = "must_not_be_written_by_a_stranger.txt"

	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains(probe)).
			ToolCall("write_file", map[string]any{"path": file, "content": "should never exist\n"}).
			ThenStreamText("Ownership probe done.")
	}))
	be := h.Backend()

	owner := h.As("user")
	stranger := h.As("other")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	threadID := "cross-approval-ownership"
	if _, err := owner.ChatTurn(ctx, apiclient.ChatRequest{
		ID:             threadID,
		Message:        apiclient.TextMessage("cross-approval-ownership-msg", probe),
		PermissionMode: "interactive",
		WorkspaceRoot:  be.WorkspaceRoot,
	}); err != nil {
		t.Fatalf("the owner's turn failed instead of suspending for approval: %v", err)
	}

	detail, err := owner.GetThread(ctx, threadID)
	if err != nil {
		t.Fatalf("owner-side GET /api/thread/%s: %v", threadID, err)
	}
	pending, ok := findPendingApproval(detail)
	if !ok {
		t.Fatalf("no pending approval in thread %s; nothing to attempt against\nmessages: %s", threadID, detail.Messages)
	}

	// Same thread id, same tool call id, a valid session -- just the wrong
	// user. The only thing that can refuse this is an ownership check on the
	// continuation itself.
	_, err = stranger.ChatTurn(ctx, apiclient.ChatRequest{
		ID:             threadID,
		Message:        pending.answer(t, true),
		PermissionMode: "interactive",
		WorkspaceRoot:  be.WorkspaceRoot,
	})
	if err == nil {
		t.Fatalf("a different user answered an approval on someone else's thread and was allowed to; " +
			"approval keyed by thread id is only safe if thread ownership is checked on the continuation")
	}
	if status := apiclient.StatusOf(err); status != 403 && status != 404 {
		t.Errorf("the stranger's attempt was rejected with status %d; expected 403 or 404 (err: %v)", status, err)
	}

	target := filepath.Join(be.WorkspaceRoot, file)
	assert.Never(t, "a stranger's approval to have run the owner's gated tool call", 2*time.Second, func() error {
		if _, err := os.Stat(target); err == nil {
			return nil
		}
		return fmt.Errorf("not written")
	})
}

// TestCrossSurface_TurnStartedInTheTUIIsApprovedByAnotherClient is the row
// read literally: the turn is started by the real `amiro` binary on a real
// terminal, the approval dialog really renders there, and the answer is
// given by a different client entirely.
func TestCrossSurface_TurnStartedInTheTUIIsApprovedByAnotherClient(t *testing.T) {
	const probe = "cross approval from a real terminal"
	const file = "approved_from_another_client.txt"
	const content = "written after another client approved the terminal's call\n"

	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains(probe)).
			ToolCall("write_file", map[string]any{"path": file, "content": content}).
			ThenStreamText("Terminal call approved elsewhere.")
	}))
	be := h.Backend()
	browser := h.As("admin")

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
		harness.PTYArgs("--mode", "interactive"),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("the TUI did not render its prompt: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.SendLine(probe); err != nil {
		t.Fatalf("sending the probe into the TUI: %v", err)
	}
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return b.Contains("[y] approve once") && b.Contains("[n] deny")
	}, 25*time.Second); err != nil {
		t.Fatalf("the TUI's approval dialog never appeared, so there is nothing for another client to approve: "+
			"%v\nframe:\n%s", err, sess.Frame())
	}

	target := filepath.Join(be.WorkspaceRoot, file)
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("%s exists while the TUI is still asking; the gate did not hold (stat error: %v)", target, err)
	}

	// Nothing is typed into the terminal from here on. The answer comes from
	// the other surface. The TUI mints its own thread id at launch, so the
	// thread has to be discovered rather than chosen.
	var pending pendingApproval
	var threadID string
	assert.Eventually(t, "the other client to find the TUI's suspended call in the shared thread", 20*time.Second, func() error {
		threads, err := browser.ListThreads(ctx)
		if err != nil {
			return fmt.Errorf("GET /api/thread: %w", err)
		}
		for _, th := range threads {
			detail, err := browser.GetThread(ctx, th.ID)
			if err != nil {
				return fmt.Errorf("GET /api/thread/%s: %w", th.ID, err)
			}
			if p, ok := findPendingApproval(detail); ok {
				pending, threadID = p, th.ID
				return nil
			}
		}
		return fmt.Errorf("no thread of this user carries a pending approval yet (saw %d thread(s))", len(threads))
	})

	if _, err := browser.ChatTurn(ctx, apiclient.ChatRequest{
		ID:             threadID,
		Message:        pending.answer(t, true),
		PermissionMode: "interactive",
		WorkspaceRoot:  be.WorkspaceRoot,
	}); err != nil {
		t.Fatalf("the second client could not approve the call the TUI raised: %v", err)
	}

	assert.Eventually(t, "the tool call the TUI asked about to have run", 20*time.Second, func() error {
		data, err := os.ReadFile(target)
		if err != nil {
			return fmt.Errorf("reading %s: %w", target, err)
		}
		if string(data) != content {
			return fmt.Errorf("%s = %q, want %q", target, data, content)
		}
		return nil
	})
}
