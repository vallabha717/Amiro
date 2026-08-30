package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
)

// nonUnwrappingCancelEngine reproduces a real bug found via the
// tests/suites/backend/backgroundjob harness suite: a real provider
// client's own error wrapping (here, "%v" instead of "%w") does not
// preserve context.Canceled through errors.Is. syncBackgroundJob must not
// rely on that to recognize a shutdown-interrupted turn.
type nonUnwrappingCancelEngine struct{}

func (nonUnwrappingCancelEngine) StreamStep(ctx context.Context, _ bifrostai.ResolvedModel, _ string, _ []bifrostai.Message, _ []bifrostai.ToolSpec, _ bifrostai.StepHooks) (*bifrostai.StepResult, error) {
	<-ctx.Done()
	return nil, fmt.Errorf("request cancelled while waiting for stream response: %v", ctx.Err())
}
func (nonUnwrappingCancelEngine) Stream(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message) (<-chan bifrostai.Chunk, error) {
	ch := make(chan bifrostai.Chunk)
	close(ch)
	return ch, nil
}

// TestSyncBackgroundJob_CtxCanceledIsInterruptedEvenWhenTheEngineErrorDoesNotUnwrap
// pins the fix: ctxCanceled is read directly off ctx.Err() in runner.go,
// never inferred from loopErr's own wrapping, precisely because a real
// engine's error text cannot be trusted to preserve the sentinel.
func TestSyncBackgroundJob_CtxCanceledIsInterruptedEvenWhenTheEngineErrorDoesNotUnwrap(t *testing.T) {
	env := newRunnerEnv(t, nonUnwrappingCancelEngine{})
	repo := repository.NewBackgroundJobRepository(env.db)
	env.h = env.h.WithBackgroundJobs(repo)

	threadID := "thread-1"
	if err := env.h.chats.InsertThread(context.Background(), &models.ChatThread{ID: threadID, UserID: env.user.ID, Title: "t"}); err != nil {
		t.Fatalf("insert thread: %v", err)
	}
	job := &models.BackgroundJob{
		ThreadID: threadID, UserID: env.user.ID, WorkspaceRoot: t.TempDir(),
		Prompt: "do it", Mode: "auto", Status: models.BackgroundJobRunning,
	}
	if err := repo.Create(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	turn := NewTextTurn(env.user, threadID, "do it").
		WithWorkspace(job.WorkspaceRoot).WithPermissionMode("auto").AsBackgroundJob()
	_, _ = env.h.RunTurn(ctx, turn, uimessage.NewWriter(httptest.NewRecorder()))

	got, err := repo.FindByID(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if got.Status != models.BackgroundJobInterrupted {
		t.Fatalf("Status = %q (error: %q), want interrupted even though the engine's error text "+
			"does not unwrap to context.Canceled", got.Status, got.Error)
	}
}

func TestWithoutClientExecutedTools_DropsOnlyNilExecuteTools(t *testing.T) {
	noop := func(context.Context, json.RawMessage) (any, error) { return nil, nil }
	defs := []tools.Definition{
		{Name: "a", Execute: noop},
		{Name: "b", Execute: nil},
		{Name: "c", Execute: noop},
	}
	out := withoutClientExecutedTools(defs)
	if len(out) != 2 {
		t.Fatalf("len(out) = %d, want 2", len(out))
	}
	for _, d := range out {
		if d.Name == "b" {
			t.Fatal("client-executed tool b was not dropped")
		}
	}
}

// TestSyncBackgroundJob_NoOpWhenThreadHasNoJob is the regression guard for
// every ordinary chat turn: RunTurn must behave identically whether or not
// a background job repository is wired, as long as the thread it's running
// against has no job row.
func TestSyncBackgroundJob_NoOpWhenThreadHasNoJob(t *testing.T) {
	env := newRunnerEnv(t, textEngine{reply: "hi"})
	env.h = env.h.WithBackgroundJobs(repository.NewBackgroundJobRepository(env.db))

	turn := NewTextTurn(env.user, "thread-1", "hello")
	if _, err := env.h.RunTurn(context.Background(), turn, uimessage.NewWriter(httptest.NewRecorder())); err != nil {
		t.Fatalf("RunTurn: %v", err)
	}
}

// TestSyncBackgroundJob_AutoPRFollowUpCreatesJobBranchAndSuspendsAtPush
// exercises the whole completion action end to end: a clean finish with
// auto_pr set kicks off exactly one follow-up turn, which switches the
// workspace to a real agent/<job-id>-<slug> branch (never the branch that
// was checked out when the job started) before the model ever runs, and
// that follow-up's own push call still suspends at the AlwaysAsk gate --
// an auto-PR job gets no bypass Phase 3 doesn't already grant every other
// caller.
func TestSyncBackgroundJob_AutoPRFollowUpCreatesJobBranchAndSuspendsAtPush(t *testing.T) {
	root := t.TempDir()
	runGitForSync(t, root, "init", "-q")
	runGitForSync(t, root, "checkout", "-q", "-b", "main")
	runGitForSync(t, root, "commit", "-q", "--allow-empty", "-m", "initial")

	pushCall := bifrostai.ToolCall{ID: "call-1", Name: "git", Arguments: `{"subcommand":"push"}`}
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{Text: "all done"},                                  // the main turn: a clean finish
		{ToolCalls: []bifrostai.ToolCall{pushCall}},          // the auto-PR follow-up: push, which suspends
	}}

	env := newRunnerEnv(t, engine)
	repo := repository.NewBackgroundJobRepository(env.db)
	env.h = env.h.WithBackgroundJobs(repo)

	threadID := "thread-1"
	if err := env.h.chats.InsertThread(context.Background(), &models.ChatThread{ID: threadID, UserID: env.user.ID, Title: "t"}); err != nil {
		t.Fatalf("insert thread: %v", err)
	}
	job := &models.BackgroundJob{
		ThreadID: threadID, UserID: env.user.ID, WorkspaceRoot: root,
		Prompt: "Fix the bug", Mode: "auto", Status: models.BackgroundJobRunning, AutoPR: true,
	}
	if err := repo.Create(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}

	turn := NewTextTurn(env.user, threadID, "fix the bug please").
		WithWorkspace(root).WithPermissionMode("auto").AsBackgroundJob()
	if _, err := env.h.RunTurn(context.Background(), turn, uimessage.NewWriter(httptest.NewRecorder())); err != nil {
		t.Fatalf("RunTurn: %v", err)
	}

	got, err := repo.FindByID(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if !got.AutoPRStarted {
		t.Fatal("AutoPRStarted was never set -- the completion action never ran")
	}
	if got.Status != models.BackgroundJobSuspended {
		t.Fatalf("Status = %q, want suspended (the follow-up turn's own push call)", got.Status)
	}

	branch := strings.TrimSpace(runGitForSync(t, root, "rev-parse", "--abbrev-ref", "HEAD"))
	if !strings.HasPrefix(branch, "agent/"+job.ID) {
		t.Fatalf("current branch = %q, want an agent/%s-... branch", branch, job.ID)
	}
	if branch == "main" {
		t.Fatal("still on main -- the job must never push to the branch it started on")
	}
}

// TestSyncBackgroundJob_AutoPRNeverStartsTwice guards the recursion guard:
// once AutoPRStarted is true, a later clean finish on the same thread (the
// follow-up turn's own eventual completion, once its push/create_pr
// approvals are answered) must land in the plain "done" branch, never
// trigger a second completion action.
func TestSyncBackgroundJob_AutoPRNeverStartsTwice(t *testing.T) {
	root := t.TempDir()
	runGitForSync(t, root, "init", "-q")
	runGitForSync(t, root, "checkout", "-q", "-b", "main")
	runGitForSync(t, root, "commit", "-q", "--allow-empty", "-m", "initial")

	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{{Text: "already finished"}}}
	env := newRunnerEnv(t, engine)
	repo := repository.NewBackgroundJobRepository(env.db)
	env.h = env.h.WithBackgroundJobs(repo)

	threadID := "thread-1"
	if err := env.h.chats.InsertThread(context.Background(), &models.ChatThread{ID: threadID, UserID: env.user.ID, Title: "t"}); err != nil {
		t.Fatalf("insert thread: %v", err)
	}
	job := &models.BackgroundJob{
		ThreadID: threadID, UserID: env.user.ID, WorkspaceRoot: root,
		Prompt: "already done", Mode: "auto", Status: models.BackgroundJobRunning, AutoPR: true,
	}
	if err := repo.Create(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	if err := repo.MarkAutoPRStarted(context.Background(), job.ID); err != nil {
		t.Fatalf("MarkAutoPRStarted: %v", err)
	}

	turn := NewTextTurn(env.user, threadID, "anything").
		WithWorkspace(root).WithPermissionMode("auto").AsBackgroundJob()
	if _, err := env.h.RunTurn(context.Background(), turn, uimessage.NewWriter(httptest.NewRecorder())); err != nil {
		t.Fatalf("RunTurn: %v", err)
	}

	got, _ := repo.FindByID(context.Background(), job.ID)
	if got.Status != models.BackgroundJobDone {
		t.Fatalf("Status = %q, want done", got.Status)
	}
	branch := strings.TrimSpace(runGitForSync(t, root, "rev-parse", "--abbrev-ref", "HEAD"))
	if branch != "main" {
		t.Fatalf("branch = %q, want main -- no second branch should have been created", branch)
	}
}
