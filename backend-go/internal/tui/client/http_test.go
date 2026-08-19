package client

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/uimessage"
	aiapi "amiro/backend/internal/api/ai"
	chatapi "amiro/backend/internal/api/chat"
	threadapi "amiro/backend/internal/api/thread"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/config"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/httpserver"
)

// fakeEngine is chatapi.Engine's canned test double -- the same
// substitution internal/httpserver's own route tests use, so this package
// exercises the real router, real auth, real persistence and the real SSE
// wire format without a live model provider. Kept local rather than shared
// across packages because both copies are ~20 lines and a shared test
// helper package for two callers is not worth the indirection.
type fakeEngine struct {
	deltas []string
	usage  *bifrostai.Usage
	// hang, if set, blocks StreamStep until ctx is canceled -- for testing
	// that SendMessage's returned wait() reports an interrupt correctly.
	hang bool
}

func (f fakeEngine) Stream(_ context.Context, _ bifrostai.ResolvedModel, _ string, _ []bifrostai.Message) (<-chan bifrostai.Chunk, error) {
	ch := make(chan bifrostai.Chunk)
	close(ch)
	return ch, nil
}

func (f fakeEngine) StreamStep(ctx context.Context, _ bifrostai.ResolvedModel, _ string, _ []bifrostai.Message, _ []bifrostai.ToolSpec, hooks bifrostai.StepHooks) (*bifrostai.StepResult, error) {
	if f.hang {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	text := ""
	for _, d := range f.deltas {
		hooks.OnTextDelta(d)
		text += d
	}
	return &bifrostai.StepResult{Text: text, Usage: f.usage}, nil
}

// testServer wires a real net/http/httptest.Server over httpserver.New with
// a fake engine -- an HTTPClient talking to it is exercising the exact path
// the desktop app's fetch() does, minus the browser.
func testServer(t *testing.T, engine chatapi.Engine) (baseURL, authToken string) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	authService := auth.NewService(gdb)
	chatRepo := repository.NewChatRepository(gdb)
	exportRepo := repository.NewChatExportRepository(gdb, chatRepo)
	providerRepo := repository.NewProviderRepository(gdb)
	chatHandler := chatapi.NewHandler(chatRepo, exportRepo, engine, nil, nil, nil, nil, nil, nil, providerRepo, nil)

	cfg := config.Config{AuthToken: "test-shared-secret", AllowedOrigin: "tauri://localhost", AppDataDir: t.TempDir()}
	handler := httpserver.New(cfg, httpserver.Handlers{
		Auth:   authService,
		Chat:   chatHandler,
		Thread: threadapi.NewHandler(chatRepo),
	})

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv.URL, cfg.AuthToken
}

// registerAndLogin creates an account against a live testServer and returns
// its session token -- what a real `amiro auth login` would have stored.
func registerAndLogin(t *testing.T, baseURL, authToken string) string {
	t.Helper()
	c := New(Config{BaseURL: baseURL, AuthToken: authToken})
	token, err := c.Register(context.Background(), "Ada", "ada@example.com", "hunter2")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	return token
}

// TestHTTPClient_SendMessage_StreamsTextOverRealHTTP is Phase 1's proof that
// the TUI's client, the real router, real auth and the real SSE encoder
// agree end to end -- not a mock of any of those pieces.
func TestHTTPClient_SendMessage_StreamsTextOverRealHTTP(t *testing.T) {
	baseURL, authToken := testServer(t, fakeEngine{deltas: []string{"Hello, ", "world."}})
	sessionToken := registerAndLogin(t, baseURL, authToken)
	c := New(Config{BaseURL: baseURL, AuthToken: authToken, SessionToken: sessionToken})

	frames, wait := c.SendMessage(context.Background(), SendMessageRequest{
		ThreadID:  "thread-1",
		MessageID: "msg-1",
		Text:      "hi",
	})

	var deltas []string
	sawStart, sawDone := false, false
	for f := range frames {
		switch f.Type {
		case "start":
			sawStart = true
		case "text-delta":
			deltas = append(deltas, f.Delta)
		case "done":
			sawDone = true
		}
	}
	if err := wait(); err != nil {
		t.Fatalf("wait() = %v, want nil", err)
	}
	if !sawStart {
		t.Fatalf("never saw a start frame")
	}
	if !sawDone {
		t.Fatalf("never saw a done frame -- stream ended without [DONE]")
	}
	got := ""
	for _, d := range deltas {
		got += d
	}
	if want := "Hello, world."; got != want {
		t.Fatalf("streamed text = %q, want %q", got, want)
	}
}

// TestHTTPClient_SendMessage_ThreadIsCreatedAndPersisted proves the client
// need never create a thread itself -- chat.RunTurn does it on first use --
// and that what it sent is readable back afterward, the same guarantee the
// manual smoke test's "reopen in the desktop app" step depends on.
func TestHTTPClient_SendMessage_ThreadIsCreatedAndPersisted(t *testing.T) {
	baseURL, authToken := testServer(t, fakeEngine{deltas: []string{"ok"}})
	sessionToken := registerAndLogin(t, baseURL, authToken)
	c := New(Config{BaseURL: baseURL, AuthToken: authToken, SessionToken: sessionToken})

	frames, wait := c.SendMessage(context.Background(), SendMessageRequest{
		ThreadID:  "thread-new",
		MessageID: "msg-1",
		Text:      "does this thread exist yet?",
	})
	for range frames {
	}
	if err := wait(); err != nil {
		t.Fatalf("wait() = %v, want nil", err)
	}

	var thread struct {
		Messages []struct {
			Role string `json:"role"`
		} `json:"messages"`
	}
	status, err := c.do(context.Background(), "GET", "/api/thread/thread-new", nil, &thread)
	if err != nil {
		t.Fatalf("GET /api/thread/thread-new: %v", err)
	}
	if status != 200 {
		t.Fatalf("GET /api/thread/thread-new status = %d, want 200 -- thread was not persisted", status)
	}
	// Both sides of the turn must have been written before wait() returned --
	// the client closes its connection right after the [DONE] frame, and
	// RunTurn's persistence writes happen after it emits [DONE] (runner.go),
	// so a version of this test that raced that ordering would show the
	// thread existing (InsertThread runs before streaming starts) with no
	// messages in it.
	if len(thread.Messages) != 2 {
		t.Fatalf("thread has %d messages, want 2 (user + assistant) -- persistence lost a race with the connection closing", len(thread.Messages))
	}
	if thread.Messages[0].Role != "user" || thread.Messages[1].Role != "assistant" {
		t.Fatalf("thread.Messages roles = %v, want [user assistant]", thread.Messages)
	}
}

// TestHTTPClient_SendMessage_CancelInterruptsCleanly is the Ctrl+C path:
// canceling ctx must close the frames channel and report ctx.Err() from
// wait(), not hang and not report a generic transport error the chat page
// would render as a scary failure instead of "interrupted."
func TestHTTPClient_SendMessage_CancelInterruptsCleanly(t *testing.T) {
	baseURL, authToken := testServer(t, fakeEngine{hang: true})
	sessionToken := registerAndLogin(t, baseURL, authToken)
	c := New(Config{BaseURL: baseURL, AuthToken: authToken, SessionToken: sessionToken})

	ctx, cancel := context.WithCancel(context.Background())
	frames, wait := c.SendMessage(ctx, SendMessageRequest{ThreadID: "thread-1", MessageID: "msg-1", Text: "hang please"})

	// Give the request time to actually reach the (blocked) handler before
	// canceling, so this exercises a mid-stream cancel rather than one that
	// beats the request out the door.
	time.Sleep(50 * time.Millisecond)
	cancel()

	drained := false
	timeout := time.After(5 * time.Second)
	for !drained {
		select {
		case _, ok := <-frames:
			if !ok {
				drained = true
			}
		case <-timeout:
			t.Fatal("frames channel never closed after cancel")
		}
	}

	if err := wait(); err == nil {
		t.Fatalf("wait() = nil, want context.Canceled")
	}
}

// approvalEngine offers one run_shell call not on permission's default
// allowlist (DefaultAllowedCommands has "echo" but not "go test") under the
// default interactive mode, which suspends for approval
// (tool_scheduler.go's suspendForApproval) exactly once -- then, once the
// resubmitted history carries a tool-role message answering it, replies
// with text and stops. This is the real gate the plan's Phase 3 row asks
// for: "approval rail tests extended for a non-browser client" -- the same
// suspend-and-resubmit rail the browser exercises, driven here by
// internal/tui/client instead.
type approvalEngine struct{}

func (approvalEngine) Stream(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message) (<-chan bifrostai.Chunk, error) {
	ch := make(chan bifrostai.Chunk)
	close(ch)
	return ch, nil
}

func (approvalEngine) StreamStep(_ context.Context, _ bifrostai.ResolvedModel, _ string, messages []bifrostai.Message, _ []bifrostai.ToolSpec, hooks bifrostai.StepHooks) (*bifrostai.StepResult, error) {
	for _, m := range messages {
		if m.Role == bifrostai.RoleTool {
			// A real engine reports text as it streams (StepHooks.OnTextDelta);
			// StepResult.Text alone is only logged, never re-emitted as a
			// frame -- runToolLoop's sw.TextStart/-Delta/-End calls all live
			// inside the hooks, not after StreamStep returns.
			if hooks.OnTextDelta != nil {
				hooks.OnTextDelta("Ran the tests.")
			}
			return &bifrostai.StepResult{Text: "Ran the tests."}, nil
		}
	}
	return &bifrostai.StepResult{
		ToolCalls: []bifrostai.ToolCall{{ID: "call-1", Name: "run_shell", Arguments: `{"command":"go test ./..."}`}},
	}, nil
}

// TestHTTPClient_ApprovalRail_SuspendAndResubmit is the Phase 3 backend
// gate. It drives the whole rail through internal/tui/client rather than a
// browser: send a message that triggers a gated tool call, observe the
// data-tool-approval frame, build the answer the same way
// session.State.BuildApprovalResubmission does, resubmit it over
// SubmitApproval, and confirm the turn continues, completes, and persists
// as one assistant message (not two) with the answer folded in rather than
// still pending.
func TestHTTPClient_ApprovalRail_SuspendAndResubmit(t *testing.T) {
	baseURL, authToken := testServer(t, approvalEngine{})
	sessionToken := registerAndLogin(t, baseURL, authToken)
	c := New(Config{BaseURL: baseURL, AuthToken: authToken, SessionToken: sessionToken})

	frames, wait := c.SendMessage(context.Background(), SendMessageRequest{
		ThreadID:      "thread-1",
		MessageID:     "msg-1",
		Text:          "run the test suite",
		WorkspaceRoot: t.TempDir(),
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
	if err := wait(); err != nil {
		t.Fatalf("first turn wait() = %v, want nil (a paused turn still finishes the stream cleanly)", err)
	}
	if approvalData == nil {
		t.Fatalf("never saw a data-tool-approval frame -- the gated call did not suspend")
	}

	var approval struct {
		ToolCallID string `json:"toolCallId"`
	}
	if err := json.Unmarshal(approvalData, &approval); err != nil {
		t.Fatalf("decode approval data: %v", err)
	}

	// The exact resubmission shape session.State.BuildApprovalResubmission
	// builds: the paused message's own id, the earlier tool part answered
	// with the manual-tool-confirm tag, and the approval-request data part
	// echoed back verbatim.
	answer, _ := json.Marshal(map[string]any{"__tag": "manual-tool-confirm", "confirm": true, "scope": "once"})
	toolPart, _ := json.Marshal(map[string]any{
		"type": "tool-run_shell", "toolCallId": approval.ToolCallID,
		"input": map[string]any{"command": "go test ./..."}, "state": "output-available",
		"output": json.RawMessage(answer),
	})
	approvalPart, _ := json.Marshal(map[string]any{
		"type": "data-tool-approval", "id": approval.ToolCallID, "data": json.RawMessage(approvalData),
	})

	resumeFrames, resumeWait := c.SubmitApproval(context.Background(), AssistantResubmission{
		ThreadID:      "thread-1",
		MessageID:     assistantMessageID,
		Parts:         []json.RawMessage{json.RawMessage(toolPart), json.RawMessage(approvalPart)},
		WorkspaceRoot: t.TempDir(),
	})

	var gotFinalText string
	for f := range resumeFrames {
		if f.Type == uimessage.FrameTextDelta {
			gotFinalText += f.Delta
		}
	}
	if err := resumeWait(); err != nil {
		t.Fatalf("resume wait() = %v, want nil", err)
	}
	if gotFinalText != "Ran the tests." {
		t.Fatalf("final text = %q, want %q -- the approved call's continuation never ran", gotFinalText, "Ran the tests.")
	}

	var thread struct {
		Messages []struct {
			ID    string            `json:"id"`
			Role  string            `json:"role"`
			Parts []json.RawMessage `json:"parts"`
		} `json:"messages"`
	}
	if status, err := c.do(context.Background(), "GET", "/api/thread/thread-1", nil, &thread); err != nil || status != 200 {
		t.Fatalf("GET /api/thread/thread-1: status=%d err=%v", status, err)
	}
	if len(thread.Messages) != 2 {
		t.Fatalf("thread has %d messages, want 2 (user + one assistant row, not one per approval)", len(thread.Messages))
	}
	if thread.Messages[1].ID != assistantMessageID {
		t.Fatalf("persisted assistant id = %q, want the continued message's own id %q", thread.Messages[1].ID, assistantMessageID)
	}

	var sawResolvedToolPart bool
	for _, raw := range thread.Messages[1].Parts {
		var p struct {
			Type   string          `json:"type"`
			State  string          `json:"state"`
			Output json.RawMessage `json:"output"`
		}
		if json.Unmarshal(raw, &p) != nil || p.Type != "tool-run_shell" {
			continue
		}
		sawResolvedToolPart = true
		if p.State != "output-available" {
			t.Fatalf("persisted tool part state = %q, want output-available -- the answer was never resolved", p.State)
		}
		var out struct {
			Tag string `json:"__tag"`
		}
		if json.Unmarshal(p.Output, &out) == nil && out.Tag == "manual-tool-confirm" {
			t.Fatalf("persisted tool output is still the confirmation object, not the real run_shell result -- resolveApprovals never ran")
		}
	}
	if !sawResolvedToolPart {
		t.Fatalf("no tool-run_shell part in the persisted assistant message: %+v", thread.Messages[1].Parts)
	}
}

// alwaysAllowEngine is a small state machine keyed on call count rather than
// message content, for TestHTTPClient_ApprovalRail_AlwaysAllowStopsAskingInTheSameThread:
// step 1 offers a gated command, step 2 is the continuation's reply, and
// step 3 offers the *same* command again from an independent later turn --
// which the test's whole point is watching not suspend a second time.
type alwaysAllowEngine struct{ calls int }

func (e *alwaysAllowEngine) Stream(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message) (<-chan bifrostai.Chunk, error) {
	ch := make(chan bifrostai.Chunk)
	close(ch)
	return ch, nil
}

func (e *alwaysAllowEngine) StreamStep(_ context.Context, _ bifrostai.ResolvedModel, _ string, _ []bifrostai.Message, _ []bifrostai.ToolSpec, hooks bifrostai.StepHooks) (*bifrostai.StepResult, error) {
	e.calls++
	reply := func(text string) *bifrostai.StepResult {
		if hooks.OnTextDelta != nil {
			hooks.OnTextDelta(text)
		}
		return &bifrostai.StepResult{Text: text}
	}
	switch e.calls {
	case 1, 3:
		return &bifrostai.StepResult{
			ToolCalls: []bifrostai.ToolCall{{ID: fmt.Sprintf("call-%d", e.calls), Name: "run_shell", Arguments: `{"command":"go test ./..."}`}},
		}, nil
	default:
		return reply(fmt.Sprintf("done (%d)", e.calls)), nil
	}
}

// TestHTTPClient_ApprovalRail_AlwaysAllowStopsAskingInTheSameThread is the
// strongest available substitute for the plan's manual-smoke step ("grant
// 'always allow' in the TUI; confirm the desktop app stops asking in that
// thread") in a sandbox with no live LLM provider and no TTY to drive either
// real client interactively. It cannot click a button in an actual desktop
// window, but it can prove the mechanism that click would rely on: an
// "always" answer submitted through internal/tui/client, exactly the way
// BuildApprovalResubmission builds it, reaches the *same*
// permission.Engine/grants store (h.grants.For(threadID)) a browser request
// against the same thread would consult -- there is no per-surface branch
// anywhere in RunTurn that could make the two disagree. A later, independent
// turn against the same thread asking for the identical command must
// therefore run it without a second data-tool-approval frame.
func TestHTTPClient_ApprovalRail_AlwaysAllowStopsAskingInTheSameThread(t *testing.T) {
	engine := &alwaysAllowEngine{}
	baseURL, authToken := testServer(t, engine)
	sessionToken := registerAndLogin(t, baseURL, authToken)
	c := New(Config{BaseURL: baseURL, AuthToken: authToken, SessionToken: sessionToken})
	workspace := t.TempDir()

	frames, wait := c.SendMessage(context.Background(), SendMessageRequest{
		ThreadID: "thread-1", MessageID: "msg-1", Text: "run the tests", WorkspaceRoot: workspace,
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
		t.Fatalf("first turn: wait()=%v approvalData=%s, want a clean suspend", err, approvalData)
	}

	var approval struct {
		ToolCallID string `json:"toolCallId"`
	}
	_ = json.Unmarshal(approvalData, &approval)
	answer, _ := json.Marshal(map[string]any{"__tag": "manual-tool-confirm", "confirm": true, "scope": "always"})
	toolPart, _ := json.Marshal(map[string]any{
		"type": "tool-run_shell", "toolCallId": approval.ToolCallID,
		"input": map[string]any{"command": "go test ./..."}, "state": "output-available",
		"output": json.RawMessage(answer),
	})
	approvalPart, _ := json.Marshal(map[string]any{
		"type": "data-tool-approval", "id": approval.ToolCallID, "data": json.RawMessage(approvalData),
	})
	resumeFrames, resumeWait := c.SubmitApproval(context.Background(), AssistantResubmission{
		ThreadID: "thread-1", MessageID: assistantMessageID,
		Parts: []json.RawMessage{json.RawMessage(toolPart), json.RawMessage(approvalPart)}, WorkspaceRoot: workspace,
	})
	for range resumeFrames {
	}
	if err := resumeWait(); err != nil {
		t.Fatalf("resume wait() = %v, want nil", err)
	}

	// A second, independent turn -- a new user message, same thread -- asks
	// for the identical command. This is the check that matters: it must run
	// straight through, with no second data-tool-approval frame, because the
	// "always" grant from the resubmission above lives in the thread's own
	// permission.Engine/grants store, not in anything the TUI holds locally.
	secondFrames, secondWait := c.SendMessage(context.Background(), SendMessageRequest{
		ThreadID: "thread-1", MessageID: "msg-2", Text: "run it again", WorkspaceRoot: workspace,
	})
	var sawSecondApproval bool
	var secondReplyText string
	for f := range secondFrames {
		switch f.Type {
		case uimessage.DataFrameType("tool-approval"):
			sawSecondApproval = true
		case uimessage.FrameTextDelta:
			secondReplyText += f.Delta
		}
	}
	if err := secondWait(); err != nil {
		t.Fatalf("second turn wait() = %v, want nil", err)
	}
	if sawSecondApproval {
		t.Fatalf("the same command asked for approval again after an 'always' grant -- the TUI and a browser would disagree about this thread's permissions")
	}
	if secondReplyText == "" {
		t.Fatalf("second turn produced no reply text -- the command may never have actually run")
	}
}

// systemCapturingEngine records the system prompt every StreamStep call
// receives, so a test can assert an agent mention's instructions actually
// reached the model rather than just that the request round-tripped
// without error.
type systemCapturingEngine struct{ systems []string }

func (e *systemCapturingEngine) Stream(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message) (<-chan bifrostai.Chunk, error) {
	ch := make(chan bifrostai.Chunk)
	close(ch)
	return ch, nil
}

func (e *systemCapturingEngine) StreamStep(_ context.Context, _ bifrostai.ResolvedModel, system string, _ []bifrostai.Message, _ []bifrostai.ToolSpec, hooks bifrostai.StepHooks) (*bifrostai.StepResult, error) {
	e.systems = append(e.systems, system)
	if hooks.OnTextDelta != nil {
		hooks.OnTextDelta("ok")
	}
	return &bifrostai.StepResult{Text: "ok"}, nil
}

// testServerWithAgent is testServer plus a real AgentRepository wired into
// the chat handler's `agents` dependency (nil in every other test here).
// It registers one account directly against the auth service (skipping the
// HTTP round trip, same as newRunnerEnv in internal/api/chat does) and
// seeds one private agent it owns, returning a session token already
// logged in as that account and the agent's id.
func testServerWithAgent(t *testing.T, engine chatapi.Engine, systemPrompt string) (baseURL, authToken, sessionToken, agentID string) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	authService := auth.NewService(gdb)
	chatRepo := repository.NewChatRepository(gdb)
	exportRepo := repository.NewChatExportRepository(gdb, chatRepo)
	providerRepo := repository.NewProviderRepository(gdb)
	agentRepo := repository.NewAgentRepository(gdb)
	chatHandler := chatapi.NewHandler(chatRepo, exportRepo, engine, nil, nil, nil, agentRepo, nil, nil, providerRepo, nil)

	cfg := config.Config{AuthToken: "test-shared-secret", AllowedOrigin: "tauri://localhost", AppDataDir: t.TempDir()}
	handler := httpserver.New(cfg, httpserver.Handlers{
		Auth:   authService,
		Chat:   chatHandler,
		Thread: threadapi.NewHandler(chatRepo),
	})

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	user, err := authService.Register(context.Background(), "Ada", "ada@example.com", "hunter2hunter2")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	instructions, _ := json.Marshal(map[string]any{"role": "reviewer", "systemPrompt": systemPrompt})
	agent := &models.Agent{ID: "agent-1", Name: "CodeReviewer", UserID: user.ID, Instructions: instructions, Visibility: "private"}
	if err := agentRepo.Insert(context.Background(), agent); err != nil {
		t.Fatalf("insert agent: %v", err)
	}

	session, err := New(Config{BaseURL: srv.URL, AuthToken: cfg.AuthToken}).Login(context.Background(), "ada@example.com", "hunter2hunter2")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	return srv.URL, cfg.AuthToken, session, agent.ID
}

// TestHTTPClient_Mentions_AgentMentionAppliesItsSystemPrompt is the Phase 4
// backend gate: "mention-resolution tests cover the TUI's request shape."
// A SendMessageRequest carrying Mentions built exactly the way
// component/editor/mention.go's toClientMention does (Type: "agent",
// AgentID set, Name/ServerID/WorkflowID empty) must reach resolveAgent
// (mentions.go) and fold the agent's system prompt into the turn -- the
// same request shape a live TUI session builds when a user accepts an
// agent completion and sends.
func TestHTTPClient_Mentions_AgentMentionAppliesItsSystemPrompt(t *testing.T) {
	const systemPrompt = "You are a meticulous code reviewer who only ever answers in haiku."
	engine := &systemCapturingEngine{}
	baseURL, authToken, sessionToken, agentID := testServerWithAgent(t, engine, systemPrompt)
	c := New(Config{BaseURL: baseURL, AuthToken: authToken, SessionToken: sessionToken})

	frames, wait := c.SendMessage(context.Background(), SendMessageRequest{
		ThreadID:  "thread-1",
		MessageID: "msg-1",
		Text:      "review this",
		Mentions:  []Mention{{Type: "agent", AgentID: agentID}},
	})
	for range frames {
	}
	if err := wait(); err != nil {
		t.Fatalf("wait() = %v, want nil", err)
	}

	if len(engine.systems) == 0 {
		t.Fatalf("engine never received a system prompt")
	}
	if !strings.Contains(engine.systems[0], systemPrompt) {
		t.Fatalf("system prompt = %q, want it to contain the agent's own instructions %q", engine.systems[0], systemPrompt)
	}
}

// TestHTTPClient_Mentions_DefaultToolMentionIsHonoredWithToolChoiceNone
// covers the other mention kind toClientMention builds directly (no id
// lookup, just a name): loadAppDefaultTools' documented override --
// "an explicit mention overrides the blanket toggle" -- even when
// ToolChoice is "none".
func TestHTTPClient_Mentions_DefaultToolMentionIsHonoredWithToolChoiceNone(t *testing.T) {
	baseURL, authToken := testServer(t, &alwaysAllowEngine{})
	sessionToken := registerAndLogin(t, baseURL, authToken)
	c := New(Config{BaseURL: baseURL, AuthToken: authToken, SessionToken: sessionToken})

	frames, wait := c.SendMessage(context.Background(), SendMessageRequest{
		ThreadID:  "thread-1",
		MessageID: "msg-1",
		Text:      "run the tests",
		Mentions:  []Mention{{Type: "defaultTool", Name: "run_shell"}},
	})
	var sawApproval bool
	for f := range frames {
		if f.Type == uimessage.DataFrameType("tool-approval") {
			sawApproval = true
		}
	}
	if err := wait(); err != nil {
		t.Fatalf("wait() = %v, want nil", err)
	}
	if !sawApproval {
		t.Fatalf("never saw run_shell offered -- the defaultTool mention did not reach loadAppDefaultTools")
	}
}

// testServerWithAI is testServer plus a real AI handler wired to the same
// ProviderRepository the chat handler uses -- the one extra piece the
// settings-page tests below need. engine may be nil: GetProviderStatuses
// and SetProviderKey never call it.
func testServerWithAI(t *testing.T) (baseURL, authToken string) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	authService := auth.NewService(gdb)
	chatRepo := repository.NewChatRepository(gdb)
	exportRepo := repository.NewChatExportRepository(gdb, chatRepo)
	providerRepo := repository.NewProviderRepository(gdb)
	chatHandler := chatapi.NewHandler(chatRepo, exportRepo, fakeEngine{}, nil, nil, nil, nil, nil, nil, providerRepo, nil)

	cfg := config.Config{AuthToken: "test-shared-secret", AllowedOrigin: "tauri://localhost", AppDataDir: t.TempDir()}
	handler := httpserver.New(cfg, httpserver.Handlers{
		Auth: authService,
		Chat: chatHandler,
		AI:   aiapi.NewHandler(nil, providerRepo),
	})

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv.URL, cfg.AuthToken
}

// TestHTTPClient_SetProviderKey_IsVisibleToAnyOtherClientOfTheSameServer is
// the Phase 4 desktop gate: "settings written by the TUI appear in the
// desktop app." SetProviderKey and ListProviders both talk to
// GET/POST /api/ai/providers -- the exact DB-backed connection the desktop
// app's own settings screen reads and writes (aiapi's own doc comment on
// ProviderStatusDTO). There is no per-surface branch in that handler that
// could make a key set by one caller invisible to another: this proves it
// by using two independent HTTPClient values -- one standing in for the
// TUI that writes the key, one for "whatever else is talking to this
// server" (the desktop app, in a live deployment) that reads it back.
func TestHTTPClient_SetProviderKey_IsVisibleToAnyOtherClientOfTheSameServer(t *testing.T) {
	baseURL, authToken := testServerWithAI(t)
	sessionToken := registerAndLogin(t, baseURL, authToken)

	tui := New(Config{BaseURL: baseURL, AuthToken: authToken, SessionToken: sessionToken})
	if err := tui.SetProviderKey(context.Background(), "anthropic", "Anthropic", "sk-test-key"); err != nil {
		t.Fatalf("SetProviderKey: %v", err)
	}

	// A second client value, same server, same session -- standing in for
	// "the desktop app, some time later" rather than reusing tui's own
	// connection.
	desktop := New(Config{BaseURL: baseURL, AuthToken: authToken, SessionToken: sessionToken})
	rows, err := desktop.ListProviders(context.Background())
	if err != nil {
		t.Fatalf("ListProviders: %v", err)
	}

	var found bool
	for _, r := range rows {
		if r.Provider == "anthropic" && r.Name == "Anthropic" {
			found = true
			if !r.Configured {
				t.Fatalf("provider row = %+v, want Configured=true", r)
			}
		}
	}
	if !found {
		t.Fatalf("no anthropic row in ListProviders after SetProviderKey: %+v", rows)
	}
}

// TestHTTPClient_SetProviderKey_UpdatesAnExistingConnectionInPlace covers
// updating a key rather than only ever creating one -- calling
// SetProviderKey twice for the same provider/name must not create two
// separate rows the settings page would then have to reconcile.
func TestHTTPClient_SetProviderKey_UpdatesAnExistingConnectionInPlace(t *testing.T) {
	baseURL, authToken := testServerWithAI(t)
	sessionToken := registerAndLogin(t, baseURL, authToken)
	c := New(Config{BaseURL: baseURL, AuthToken: authToken, SessionToken: sessionToken})

	if err := c.SetProviderKey(context.Background(), "anthropic", "Anthropic", "sk-old-key"); err != nil {
		t.Fatalf("first SetProviderKey: %v", err)
	}
	if err := c.SetProviderKey(context.Background(), "anthropic", "Anthropic", "sk-new-key"); err != nil {
		t.Fatalf("second SetProviderKey: %v", err)
	}

	rows, err := c.ListProviders(context.Background())
	if err != nil {
		t.Fatalf("ListProviders: %v", err)
	}
	count := 0
	for _, r := range rows {
		if r.Provider == "anthropic" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("anthropic rows = %d, want 1 (updated in place, not duplicated)", count)
	}
}
