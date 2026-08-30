package background

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	bifrostai "amiro/backend/internal/ai/bifrost"
	chatapi "amiro/backend/internal/api/chat"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
)

// fakeEngine is a canned chatapi.Engine, one bifrostai.StepResult per
// StreamStep call, consumed in order -- the same shape
// internal/api/chat's own fakeStreamEngine uses, redefined here since that
// one is unexported in its package.
type fakeEngine struct {
	steps []bifrostai.StepResult
	calls int

	// blockUntilCtxDone makes StreamStep hang until ctx is canceled instead
	// of returning a scripted step -- for proving Shutdown actually cancels
	// an in-flight job rather than merely appearing to.
	blockUntilCtxDone bool
}

func (f *fakeEngine) StreamStep(ctx context.Context, _ bifrostai.ResolvedModel, _ string, _ []bifrostai.Message, _ []bifrostai.ToolSpec, _ bifrostai.StepHooks) (*bifrostai.StepResult, error) {
	f.calls++
	if f.blockUntilCtxDone {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	step := f.steps[f.calls-1]
	return &step, nil
}

func (f *fakeEngine) Stream(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message) (<-chan bifrostai.Chunk, error) {
	ch := make(chan bifrostai.Chunk)
	close(ch)
	return ch, nil
}

// testEnv is a real chat.Handler + real sqlite-backed repositories -- the
// same "real database, canned engine" shape internal/api/chat's own tests
// use, because persistence (a job row actually changing status) is exactly
// what this package's tests need to observe.
type testEnv struct {
	chat  *chatapi.Handler
	jobs  *repository.BackgroundJobRepository
	trust *repository.WorkspaceTrustRepository
	users *repository.UserRepository
	chats *repository.ChatRepository
	user  *models.User
}

func newTestEnv(t *testing.T, engine chatapi.Engine) testEnv {
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

	user, err := auth.NewService(gdb).Register(context.Background(), "Ada", "ada@example.com", "hunter2hunter2")
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	chatRepo := repository.NewChatRepository(gdb)
	jobs := repository.NewBackgroundJobRepository(gdb)
	trust := repository.NewWorkspaceTrustRepository(gdb)
	users := repository.NewUserRepository(gdb)
	h := chatapi.NewHandler(chatRepo, nil, engine, nil, nil, nil, nil, nil, nil, nil).
		WithWorkspaceTrust(trust).
		WithBackgroundJobs(jobs)
	return testEnv{chat: h, jobs: jobs, trust: trust, users: users, user: user, chats: chatRepo}
}

// newJobRow inserts the thread background_jobs' foreign key requires, then
// the job row itself -- mirroring internal/api/backgroundjob's Create,
// which must do the same for the same reason (see that handler's comment).
func newJobRow(t *testing.T, env testEnv, root string) models.BackgroundJob {
	t.Helper()
	threadID := models.NewID()
	if err := env.chats.InsertThread(context.Background(), &models.ChatThread{ID: threadID, UserID: env.user.ID, Title: "t"}); err != nil {
		t.Fatalf("insert thread: %v", err)
	}
	job := &models.BackgroundJob{
		ThreadID:      threadID,
		UserID:        env.user.ID,
		WorkspaceRoot: root,
		Prompt:        "do the thing",
		Mode:          "auto",
		Status:        models.BackgroundJobRunning,
		StartedAt:     time.Now(),
	}
	if err := env.jobs.Create(context.Background(), job); err != nil {
		t.Fatalf("create job: %v", err)
	}
	return *job
}

func waitForStatus(t *testing.T, jobs *repository.BackgroundJobRepository, id, want string, timeout time.Duration) *models.BackgroundJob {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		job, err := jobs.FindByID(context.Background(), id)
		if err != nil {
			t.Fatalf("FindByID: %v", err)
		}
		if job != nil && job.Status == want {
			return job
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("job %s did not reach status %q within %s", id, want, timeout)
	return nil
}

func TestWorker_StartRunsTurnAndMarksJobDone(t *testing.T) {
	engine := &fakeEngine{steps: []bifrostai.StepResult{{Text: "all done"}}}
	env := newTestEnv(t, engine)
	job := newJobRow(t, env, t.TempDir())

	w := New(env.chat, env.jobs, env.trust, env.users)
	w.Start(job, env.user)

	waitForStatus(t, env.jobs, job.ID, models.BackgroundJobDone, 2*time.Second)
}

func TestWorker_StartMarksJobSuspendedOnAlwaysAskGate(t *testing.T) {
	pushCall := bifrostai.ToolCall{ID: "call-1", Name: "git", Arguments: `{"subcommand":"push"}`}
	engine := &fakeEngine{steps: []bifrostai.StepResult{{ToolCalls: []bifrostai.ToolCall{pushCall}}}}
	env := newTestEnv(t, engine)
	root := t.TempDir()
	// A background job is only ever created against an already-trusted
	// root (Phase 0's gate, enforced at creation by
	// internal/api/backgroundjob) -- granted here to isolate what this
	// test actually checks: that AlwaysAsk suspends rather than allowing,
	// not workspace trust itself.
	if err := env.trust.Grant(context.Background(), env.user.ID, root, repository.GrantedViaPrompt); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	job := newJobRow(t, env, root)
	job.Mode = "auto"

	w := New(env.chat, env.jobs, env.trust, env.users)
	w.Start(job, env.user)

	// AlwaysAsk gates push in every mode including auto -- see
	// docs/coding-agent-parity/04-git-remote-operations.md -- so this
	// suspends rather than running, even though Mode is auto.
	waitForStatus(t, env.jobs, job.ID, models.BackgroundJobSuspended, 2*time.Second)
}

func TestWorker_ShutdownCancelsRunningJobAndMarksInterrupted(t *testing.T) {
	engine := &fakeEngine{blockUntilCtxDone: true}
	env := newTestEnv(t, engine)
	job := newJobRow(t, env, t.TempDir())

	w := New(env.chat, env.jobs, env.trust, env.users)
	w.Start(job, env.user)

	// Give the goroutine a moment to actually enter StreamStep and start
	// blocking, so Shutdown genuinely interrupts an in-flight call rather
	// than racing its own start.
	time.Sleep(20 * time.Millisecond)

	w.Shutdown(2 * time.Second)

	got, err := env.jobs.FindByID(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if got.Status != models.BackgroundJobInterrupted {
		t.Fatalf("Status = %q after Shutdown, want interrupted", got.Status)
	}
	if got.FinishedAt == nil {
		t.Fatal("FinishedAt not set on an interrupted job")
	}
}

func TestWorker_ResumeInterrupted_OnlyResumesJobsWithValidTrustAndRoot(t *testing.T) {
	engine := &fakeEngine{steps: []bifrostai.StepResult{
		{Text: "resumed and done"}, // for the valid job
	}}
	env := newTestEnv(t, engine)

	validRoot := t.TempDir()
	if err := env.trust.Grant(context.Background(), env.user.ID, validRoot, repository.GrantedViaPrompt); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	validJob := newJobRow(t, env, validRoot)
	if err := env.jobs.MarkInterrupted(context.Background(), validJob.ID); err != nil {
		t.Fatalf("MarkInterrupted: %v", err)
	}

	untrustedRoot := t.TempDir()
	untrustedJob := newJobRow(t, env, untrustedRoot)
	if err := env.jobs.MarkInterrupted(context.Background(), untrustedJob.ID); err != nil {
		t.Fatalf("MarkInterrupted: %v", err)
	}

	missingRoot := filepath.Join(t.TempDir(), "gone")
	_ = os.RemoveAll(missingRoot)
	missingJob := newJobRow(t, env, missingRoot)
	if err := env.jobs.MarkInterrupted(context.Background(), missingJob.ID); err != nil {
		t.Fatalf("MarkInterrupted: %v", err)
	}

	w := New(env.chat, env.jobs, env.trust, env.users)
	w.ResumeInterrupted(context.Background())

	waitForStatus(t, env.jobs, validJob.ID, models.BackgroundJobDone, 2*time.Second)

	// Neither the untrusted-root job nor the missing-root job should ever
	// have been started -- give any wrongly-started goroutine a moment to
	// misbehave, then assert both are still exactly where
	// ResumeInterrupted found them.
	time.Sleep(50 * time.Millisecond)
	got, _ := env.jobs.FindByID(context.Background(), untrustedJob.ID)
	if got.Status != models.BackgroundJobInterrupted {
		t.Fatalf("untrusted job Status = %q, want unchanged (interrupted)", got.Status)
	}
	got, _ = env.jobs.FindByID(context.Background(), missingJob.ID)
	if got.Status != models.BackgroundJobInterrupted {
		t.Fatalf("missing-root job Status = %q, want unchanged (interrupted)", got.Status)
	}
}
