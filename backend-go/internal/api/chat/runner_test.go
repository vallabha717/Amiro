package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gorm.io/gorm"

	"amiro/backend/internal/agent/workspace"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/skills"
)

// runnerEnv is a Handler with a real database and a canned engine -- the
// smallest thing RunTurn can actually run against.
//
// Real SQLite rather than a fake repository because persistence is half of
// what RunTurn does, and a fake that accepts every write would let the
// interesting failures through: a thread whose foreign key does not resolve,
// a continued turn that writes two rows where it should write one.
type runnerEnv struct {
	h    *Handler
	user *models.User
	db   *gorm.DB
}

func newRunnerEnv(t *testing.T, engine Engine) runnerEnv {
	t.Helper()

	gdb, err := db.Open(db.DialectSQLite, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	user, err := auth.NewService(gdb).Register(context.Background(), "Test", "test@example.com", "hunter2hunter2")
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	chatRepo := repository.NewChatRepository(gdb)
	h := NewHandler(chatRepo, nil, engine, nil, nil, nil, nil, nil, nil, nil)
	return runnerEnv{h: h, user: user, db: gdb}
}

// messagesOf reads a thread's persisted messages back in order.
func (e runnerEnv) messagesOf(t *testing.T, threadID string) []models.ChatMessage {
	t.Helper()
	details, err := e.h.chats.SelectThreadDetails(context.Background(), threadID)
	if err != nil {
		t.Fatalf("select thread: %v", err)
	}
	if details == nil {
		return nil
	}
	return details.Messages
}

// textEngine answers with one fixed reply and no tool calls.
type textEngine struct{ reply string }

func (t textEngine) Stream(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message) (<-chan bifrostai.Chunk, error) {
	ch := make(chan bifrostai.Chunk)
	close(ch)
	return ch, nil
}

func (t textEngine) StreamStep(_ context.Context, _ bifrostai.ResolvedModel, _ string, _ []bifrostai.Message, _ []bifrostai.ToolSpec, hooks bifrostai.StepHooks) (*bifrostai.StepResult, error) {
	for _, word := range strings.SplitAfter(t.reply, " ") {
		hooks.OnTextDelta(word)
	}
	return &bifrostai.StepResult{
		Text:  t.reply,
		Usage: &bifrostai.Usage{PromptTokens: 11, CompletionTokens: 7, TotalTokens: 18},
	}, nil
}

// TestRunTurn_PersistsBothSidesAndReportsTheTurn is the extraction gate.
//
// RunTurn is ~200 lines lifted out of an HTTP handler, and the risk of that
// move is not that it fails to compile -- it is that some step quietly stops
// happening. The three things the handler was responsible for are asserted
// here directly, without a router in the way: the user's message is saved,
// the assistant's reply is saved under a fresh id, and the caller is told
// what happened.
func TestRunTurn_PersistsBothSidesAndReportsTheTurn(t *testing.T) {
	env := newRunnerEnv(t, textEngine{reply: "the answer is 42"})

	turn := NewTextTurn(env.user, "thread-1", "what is the answer?")
	result, err := env.h.RunTurn(context.Background(), turn, uimessage.NewWriter(httptest.NewRecorder()))
	if err != nil {
		t.Fatalf("RunTurn: %v", err)
	}

	if result.Text != "the answer is 42" {
		t.Errorf("result.Text = %q", result.Text)
	}
	if result.ResponseID == "" || result.ResponseID == turn.Message.ID {
		t.Errorf("ResponseID = %q, want a fresh id distinct from the user message", result.ResponseID)
	}
	if result.Usage == nil || result.Usage.TotalTokens != 18 {
		t.Errorf("Usage = %+v, want the engine's totals", result.Usage)
	}
	if result.Steps != 1 {
		t.Errorf("Steps = %d, want 1", result.Steps)
	}
	if result.Log == nil {
		t.Error("Log is nil -- the persisted parts are projected from it, so a turn without one saved nothing")
	}

	msgs := env.messagesOf(t, "thread-1")
	if len(msgs) != 2 {
		t.Fatalf("persisted %d messages, want 2 (the question and the answer)", len(msgs))
	}
	if msgs[0].Role != "user" || msgs[1].Role != "assistant" {
		t.Fatalf("roles = %q, %q; want user, assistant", msgs[0].Role, msgs[1].Role)
	}
	if msgs[1].ID != result.ResponseID {
		t.Errorf("assistant row id = %q, TurnResult said %q", msgs[1].ID, result.ResponseID)
	}
	if !strings.Contains(string(msgs[1].Parts), "the answer is 42") {
		t.Errorf("assistant parts do not carry the reply: %s", msgs[1].Parts)
	}
}

// TestRunTurn_ContinuingWritesOneRowNotTwo covers the approval-resume path
// through the new entry point.
//
// This is the behavior the comment in RunTurn calls out as a fixed bug: a
// turn that stopped for approval resumes as a continuation of the assistant
// message it paused in. Minting a fresh id there wrote one assistant row per
// approval, each a superset of the last, so a turn that asked ten times read
// back as ten answers.
func TestRunTurn_ContinuingWritesOneRowNotTwo(t *testing.T) {
	env := newRunnerEnv(t, textEngine{reply: "continued"})

	first := NewTextTurn(env.user, "thread-1", "start")
	if _, err := env.h.RunTurn(context.Background(), first, uimessage.NewWriter(httptest.NewRecorder())); err != nil {
		t.Fatalf("first turn: %v", err)
	}
	before := env.messagesOf(t, "thread-1")
	assistantID := before[len(before)-1].ID

	// The client resubmits the assistant message, which is what an approval
	// answer looks like on the wire.
	resume := TurnRequest{
		User:     env.user,
		ThreadID: "thread-1",
		Message: uiMessage{
			ID:    assistantID,
			Role:  "assistant",
			Parts: []json.RawMessage{json.RawMessage(`{"type":"text","text":"continued"}`)},
		},
	}
	result, err := env.h.RunTurn(context.Background(), resume, uimessage.NewWriter(httptest.NewRecorder()))
	if err != nil {
		t.Fatalf("resume turn: %v", err)
	}
	if result.ResponseID != assistantID {
		t.Errorf("ResponseID = %q, want the continued message's own id %q", result.ResponseID, assistantID)
	}

	after := env.messagesOf(t, "thread-1")
	if len(after) != len(before) {
		t.Fatalf("resuming added %d rows, want 0 -- a resumed turn is one message, however many times it stopped",
			len(after)-len(before))
	}
}

// TestRunTurn_RefusesWorkItMayNotDo covers the two failures a caller has to
// be able to tell apart, and the promise that neither writes to the stream.
func TestRunTurn_RefusesWorkItMayNotDo(t *testing.T) {
	env := newRunnerEnv(t, textEngine{reply: "unreachable"})

	// Seed a thread owned by somebody else.
	other, err := auth.NewService(env.db).Register(context.Background(), "Other", "other@example.com", "hunter2hunter2")
	if err != nil {
		t.Fatalf("register other: %v", err)
	}
	if err := env.h.chats.InsertThread(context.Background(), &models.ChatThread{ID: "theirs", UserID: other.ID}); err != nil {
		t.Fatalf("insert thread: %v", err)
	}

	cases := []struct {
		name string
		turn TurnRequest
		want error
	}{
		{"another user's thread", NewTextTurn(env.user, "theirs", "hello"), ErrForbidden},
		{"no thread id", NewTextTurn(env.user, "", "hello"), ErrInvalidTurn},
		{"no message id", TurnRequest{User: env.user, ThreadID: "t"}, ErrInvalidTurn},
		{"no user", TurnRequest{ThreadID: "t", Message: uiMessage{ID: "m"}}, ErrForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			_, err := env.h.RunTurn(context.Background(), tc.turn, uimessage.NewWriter(rec))
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			if body := rec.Body.String(); body != "" {
				t.Errorf("wrote %q to the stream before failing -- a caller can no longer choose its own "+
					"failure representation once frames have been sent", body)
			}
		})
	}
}

// TestRunTurn_StreamFramesGolden is the protocol contract: the exact frame
// sequence one turn puts on the wire.
//
// It is the shared truth every surface depends on. The desktop app renders
// these frames today and the terminal client will render the same ones, so a
// change here is a change to both at once -- which is precisely why it should
// have to be made on purpose rather than noticed later in one client and not
// the other.
//
// Decoded through this package's own Scanner rather than string-matched, so
// the test also exercises the reader half of the protocol against the writer
// half.
//
// Regenerate deliberately:
//
//	UPDATE_GOLDEN=1 go test ./internal/api/chat -run TestRunTurn_StreamFrames
func TestRunTurn_StreamFramesGolden(t *testing.T) {
	env := newRunnerEnv(t, textEngine{reply: "hello there"})

	rec := httptest.NewRecorder()
	if _, err := env.h.RunTurn(
		context.Background(),
		NewTextTurn(env.user, "thread-1", "hi").WithModel("openai", "gpt-5"),
		uimessage.NewWriter(rec),
	); err != nil {
		t.Fatalf("RunTurn: %v", err)
	}

	var got bytes.Buffer
	sc := uimessage.NewScanner(strings.NewReader(rec.Body.String()))
	for sc.Scan() {
		frame := normalizeFrame(t, sc.Frame())
		line, err := json.Marshal(frame)
		if err != nil {
			t.Fatalf("marshal frame: %v", err)
		}
		got.Write(line)
		got.WriteByte('\n')
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !sc.Done() {
		t.Fatal("the stream did not end with its [DONE] sentinel")
	}

	path := filepath.Join("testdata", "turn_frames.jsonl")
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", path)
		return
	}

	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden (run with UPDATE_GOLDEN=1 to create): %v", err)
	}
	if !bytes.Equal(bytes.TrimSpace(want), bytes.TrimSpace(got.Bytes())) {
		t.Errorf("the stream's frame sequence changed.\n\n--- want (golden)\n%s\n\n--- got\n%s\n\n"+
			"Every client renders from these frames. If the change is intended, regenerate with "+
			"UPDATE_GOLDEN=1 and check what it does to both the desktop app and the terminal client.",
			want, got.Bytes())
	}
}

// normalizeFrame replaces the parts of a frame that legitimately differ
// between runs -- generated ids, and the wall-clock duration on the closing
// metadata -- so the golden asserts on shape and order rather than on a
// clock.
func normalizeFrame(t *testing.T, f uimessage.Frame) uimessage.Frame {
	t.Helper()

	if f.MessageID != "" {
		f.MessageID = "<generated>"
	}
	if f.ID != "" {
		f.ID = "<generated>"
	}
	if len(f.MessageMetadata) > 0 {
		var meta map[string]any
		if err := json.Unmarshal(f.MessageMetadata, &meta); err != nil {
			t.Fatalf("decode message metadata: %v", err)
		}
		meta["durationMs"] = 0
		normalized, err := json.Marshal(meta)
		if err != nil {
			t.Fatalf("re-encode message metadata: %v", err)
		}
		f.MessageMetadata = normalized
	}
	return f
}

type captureSystemEngine struct {
	capturedSystem string
}

func (c *captureSystemEngine) StreamStep(ctx context.Context, _ bifrostai.ResolvedModel, system string, _ []bifrostai.Message, _ []bifrostai.ToolSpec, hooks bifrostai.StepHooks) (*bifrostai.StepResult, error) {
	c.capturedSystem = system
	if hooks.OnTextDelta != nil {
		hooks.OnTextDelta("done")
	}
	return &bifrostai.StepResult{}, nil
}

func (c *captureSystemEngine) Stream(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message) (<-chan bifrostai.Chunk, error) {
	panic("not implemented")
}

func TestRunner_SkillsMention_InjectsSkillContent(t *testing.T) {
	tempDir := t.TempDir()
	skillDir := filepath.Join(tempDir, ".agents", "skills", "my-skill")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	skillContent := "---\nname: my-skill\ndescription: Test skill.\ndisable-model-invocation: true\n---\n# My Skill Body\n"
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(skillContent), 0o644); err != nil {
		t.Fatal(err)
	}

	engine := &captureSystemEngine{}
	env := newRunnerEnv(t, engine)
	skillsService := skills.NewService()
	env.h = env.h.WithSkills(skillsService)

	w := httptest.NewRecorder()
	_, err := env.h.RunTurn(context.Background(), TurnRequest{
		User:     env.user,
		ThreadID: "test-thread-skills",
		Message: uiMessage{
			ID:    "msg-1",
			Role:  "user",
			Parts: []json.RawMessage{json.RawMessage(`{"type":"text","text":"run skill"}`)},
		},
		Mentions:      []mentionDTO{{Type: "skill", Name: "my-skill"}},
		WorkspaceRoot: tempDir,
	}, uimessage.NewWriter(w))

	if err != nil {
		t.Fatalf("RunTurn: %v", err)
	}

	if !strings.Contains(engine.capturedSystem, `<skill_content name="my-skill">`) {
		t.Fatalf("expected <skill_content name=\"my-skill\"> in captured system prompt, got:\n%s", engine.capturedSystem)
	}
	if !strings.Contains(engine.capturedSystem, "# My Skill Body") {
		t.Fatalf("expected skill body in captured system prompt, got:\n%s", engine.capturedSystem)
	}
}

// TestRunner_AGENTSMd_InjectsAheadOfSkillCatalog covers phase-00's
// deliverable 2 (docs/coding-agent-parity/phases/phase-00-workspace-trust-and-rules.md):
// AGENTS.md is read every turn, unconditionally, and lands ahead of the
// skill catalog in the system prompt -- the ordering that makes it a
// standing fact rather than one more thing competing with on-demand
// disclosure.
func TestRunner_AGENTSMd_InjectsAheadOfSkillCatalog(t *testing.T) {
	tempDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(tempDir, "AGENTS.md"), []byte("use pnpm for everything in this repo"), 0o644); err != nil {
		t.Fatal(err)
	}

	engine := &captureSystemEngine{}
	env := newRunnerEnv(t, engine)

	w := httptest.NewRecorder()
	_, err := env.h.RunTurn(context.Background(), TurnRequest{
		User:     env.user,
		ThreadID: "test-thread-agents-md",
		Message: uiMessage{
			ID:    "msg-1",
			Role:  "user",
			Parts: []json.RawMessage{json.RawMessage(`{"type":"text","text":"hello"}`)},
		},
		WorkspaceRoot: tempDir,
	}, uimessage.NewWriter(w))
	if err != nil {
		t.Fatalf("RunTurn: %v", err)
	}

	if !strings.Contains(engine.capturedSystem, "use pnpm for everything in this repo") {
		t.Fatalf("expected AGENTS.md content in captured system prompt, got:\n%s", engine.capturedSystem)
	}
	if !strings.Contains(engine.capturedSystem, "<project_rules>") {
		t.Fatalf("expected a <project_rules> block, got:\n%s", engine.capturedSystem)
	}
}

// TestRunner_WorkspaceTrust_EnvSourcedRootAutoGrants is
// docs/coding-agent-parity/phases/phase-00-workspace-trust-and-rules.md's
// exit criterion 3: a root sourced from the handler's own configured
// default (the process's AMIRO_WORKSPACE_ROOT / CLI-flag root, reached here
// via WithWorkspace exactly as appwiring wires it) is granted at first use
// with no prompt, recorded with granted_via "env" -- never left as an
// invisible bypass.
func TestRunner_WorkspaceTrust_EnvSourcedRootAutoGrants(t *testing.T) {
	env := newRunnerEnv(t, textEngine{reply: "hi"})
	trustRepo := repository.NewWorkspaceTrustRepository(env.db)
	env.h = env.h.WithWorkspaceTrust(trustRepo)

	ws, err := workspace.New(t.TempDir())
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	env.h = env.h.WithWorkspace(ws, t.TempDir())

	w := httptest.NewRecorder()
	if _, err := env.h.RunTurn(context.Background(), NewTextTurn(env.user, "test-thread-env-grant", "hi"), uimessage.NewWriter(w)); err != nil {
		t.Fatalf("RunTurn: %v", err)
	}

	trusted, err := trustRepo.IsTrusted(context.Background(), env.user.ID, ws.Root())
	if err != nil {
		t.Fatalf("IsTrusted: %v", err)
	}
	if !trusted {
		t.Fatal("a turn against the handler's own configured default workspace must auto-grant, not require a prompt")
	}

	grants, err := trustRepo.List(context.Background(), env.user.ID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(grants) != 1 || grants[0].GrantedVia != repository.GrantedViaEnv {
		t.Fatalf("grants = %+v, want exactly one grant with granted_via=%q", grants, repository.GrantedViaEnv)
	}
}

// TestRunner_WorkspaceTrust_RequestEchoingProcessDefaultStillAutoGrants
// covers the case that broke the naive "was WorkspaceRoot supplied at all"
// signal: the TUI (and this suite's own request builders) always echo
// WorkspaceRoot back explicitly, every turn, including when its value is
// simply the server's own default. That must still auto-grant -- comparing
// by resolved root, not by whether the field was left empty, is what makes
// this so.
func TestRunner_WorkspaceTrust_RequestEchoingProcessDefaultStillAutoGrants(t *testing.T) {
	env := newRunnerEnv(t, textEngine{reply: "hi"})
	trustRepo := repository.NewWorkspaceTrustRepository(env.db)
	env.h = env.h.WithWorkspaceTrust(trustRepo)

	dir := t.TempDir()
	ws, err := workspace.New(dir)
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	env.h = env.h.WithWorkspace(ws, t.TempDir())

	w := httptest.NewRecorder()
	_, err = env.h.RunTurn(context.Background(), TurnRequest{
		User:     env.user,
		ThreadID: "test-thread-echoed-default",
		Message: uiMessage{
			ID:    "msg-1",
			Role:  "user",
			Parts: []json.RawMessage{json.RawMessage(`{"type":"text","text":"hi"}`)},
		},
		WorkspaceRoot: dir, // explicitly echoed, not left empty
	}, uimessage.NewWriter(w))
	if err != nil {
		t.Fatalf("RunTurn: %v", err)
	}

	trusted, err := trustRepo.IsTrusted(context.Background(), env.user.ID, ws.Root())
	if err != nil {
		t.Fatalf("IsTrusted: %v", err)
	}
	if !trusted {
		t.Fatal("a request that explicitly echoes the server's own default workspace root must still auto-grant")
	}
}

// TestRunner_WorkspaceTrust_RequestSuppliedRootIsNotAutoGranted is the
// converse: a root the request itself named (an interactively-opened
// project, e.g. the web dashboard's project picker) must not be silently
// trusted just because a turn ran against it -- only a prior grant (a
// human answering the trust prompt) may set it.
func TestRunner_WorkspaceTrust_RequestSuppliedRootIsNotAutoGranted(t *testing.T) {
	env := newRunnerEnv(t, textEngine{reply: "hi"})
	trustRepo := repository.NewWorkspaceTrustRepository(env.db)
	env.h = env.h.WithWorkspaceTrust(trustRepo)

	projectDir := t.TempDir()
	w := httptest.NewRecorder()
	_, err := env.h.RunTurn(context.Background(), TurnRequest{
		User:     env.user,
		ThreadID: "test-thread-no-auto-grant",
		Message: uiMessage{
			ID:    "msg-1",
			Role:  "user",
			Parts: []json.RawMessage{json.RawMessage(`{"type":"text","text":"hi"}`)},
		},
		WorkspaceRoot: projectDir,
	}, uimessage.NewWriter(w))
	if err != nil {
		t.Fatalf("RunTurn: %v", err)
	}

	resolved, err := workspace.New(projectDir)
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	trusted, err := trustRepo.IsTrusted(context.Background(), env.user.ID, resolved.Root())
	if err != nil {
		t.Fatalf("IsTrusted: %v", err)
	}
	if trusted {
		t.Fatal("a request-supplied workspace root must not be auto-granted -- only an explicit prompt/grant may trust it")
	}
}

