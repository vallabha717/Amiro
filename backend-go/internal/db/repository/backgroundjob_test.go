package repository

import (
	"context"
	"path/filepath"
	"testing"

	"gorm.io/gorm"

	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
)

// newBackgroundJobTestEnv mirrors newCheckpointTestEnv's shape: a fresh
// sqlite db (foreign keys enforced), one user, one thread so
// background_jobs' FK on chat_thread has something real to reference.
func newBackgroundJobTestEnv(t *testing.T) (*BackgroundJobRepository, *gorm.DB, *models.User, *models.ChatThread) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	owner := &models.User{Name: "Ada", Email: "ada@example.com"}
	if err := gdb.Create(owner).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	thread := &models.ChatThread{ID: models.NewID(), UserID: owner.ID, Title: "t"}
	if err := gdb.Create(thread).Error; err != nil {
		t.Fatalf("create thread: %v", err)
	}
	return NewBackgroundJobRepository(gdb), gdb, owner, thread
}

func newJob(userID, threadID, status string) *models.BackgroundJob {
	return &models.BackgroundJob{
		ThreadID: threadID, UserID: userID, WorkspaceRoot: "/tmp/ws",
		Prompt: "do the thing", Mode: "edit", Status: status,
	}
}

func TestBackgroundJobRepository_CreateThenFindByID(t *testing.T) {
	repo, _, u, th := newBackgroundJobTestEnv(t)
	ctx := context.Background()
	job := newJob(u.ID, th.ID, models.BackgroundJobRunning)
	if err := repo.Create(ctx, job); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if job.ID == "" {
		t.Fatal("Create did not assign an ID")
	}

	got, err := repo.FindByID(ctx, job.ID)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if got == nil || got.Prompt != "do the thing" {
		t.Fatalf("FindByID = %+v, want the created job", got)
	}
}

func TestBackgroundJobRepository_FindByIDMissingReturnsNilNotError(t *testing.T) {
	repo, _, _, _ := newBackgroundJobTestEnv(t)
	got, err := repo.FindByID(context.Background(), "nonexistent")
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if got != nil {
		t.Fatalf("FindByID = %+v, want nil", got)
	}
}

func TestBackgroundJobRepository_FindActiveByThreadIDIgnoresTerminalJobs(t *testing.T) {
	repo, _, u, th := newBackgroundJobTestEnv(t)
	ctx := context.Background()
	job := newJob(u.ID, th.ID, models.BackgroundJobDone)
	if err := repo.Create(ctx, job); err != nil {
		t.Fatalf("Create: %v", err)
	}

	active, err := repo.FindActiveByThreadID(ctx, th.ID)
	if err != nil {
		t.Fatalf("FindActiveByThreadID: %v", err)
	}
	if active != nil {
		t.Fatalf("FindActiveByThreadID = %+v for a done job, want nil", active)
	}
}

func TestBackgroundJobRepository_FindActiveByThreadIDFindsRunningAndSuspended(t *testing.T) {
	for _, status := range []string{models.BackgroundJobRunning, models.BackgroundJobSuspended} {
		repo, _, u, th := newBackgroundJobTestEnv(t)
		ctx := context.Background()
		job := newJob(u.ID, th.ID, status)
		if err := repo.Create(ctx, job); err != nil {
			t.Fatalf("Create: %v", err)
		}
		active, err := repo.FindActiveByThreadID(ctx, th.ID)
		if err != nil {
			t.Fatalf("FindActiveByThreadID: %v", err)
		}
		if active == nil || active.ID != job.ID {
			t.Fatalf("status %q: FindActiveByThreadID = %+v, want %s", status, active, job.ID)
		}
	}
}

func TestBackgroundJobRepository_CountRunningOnlyCountsRunning(t *testing.T) {
	repo, gdb, u, _ := newBackgroundJobTestEnv(t)
	ctx := context.Background()
	statuses := []string{
		models.BackgroundJobRunning, models.BackgroundJobRunning,
		models.BackgroundJobSuspended, models.BackgroundJobDone, models.BackgroundJobFailed,
	}
	for _, status := range statuses {
		th := &models.ChatThread{ID: models.NewID(), UserID: u.ID, Title: "t"}
		if err := gdb.Create(th).Error; err != nil {
			t.Fatalf("create thread: %v", err)
		}
		if err := repo.Create(ctx, newJob(u.ID, th.ID, status)); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	count, err := repo.CountRunning(ctx)
	if err != nil {
		t.Fatalf("CountRunning: %v", err)
	}
	if count != 2 {
		t.Fatalf("CountRunning = %d, want 2", count)
	}
}

func TestBackgroundJobRepository_ListVisibleScopesToOwnerUnlessIncludeAll(t *testing.T) {
	repo, gdb, owner, ownerThread := newBackgroundJobTestEnv(t)
	ctx := context.Background()
	other := &models.User{Name: "Bob", Email: "bob@example.com"}
	if err := gdb.Create(other).Error; err != nil {
		t.Fatalf("create other user: %v", err)
	}
	otherThread := &models.ChatThread{ID: models.NewID(), UserID: other.ID, Title: "t"}
	if err := gdb.Create(otherThread).Error; err != nil {
		t.Fatalf("create other thread: %v", err)
	}
	if err := repo.Create(ctx, newJob(owner.ID, ownerThread.ID, models.BackgroundJobDone)); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := repo.Create(ctx, newJob(other.ID, otherThread.ID, models.BackgroundJobDone)); err != nil {
		t.Fatalf("Create: %v", err)
	}

	own, err := repo.ListVisible(ctx, owner.ID, false)
	if err != nil {
		t.Fatalf("ListVisible: %v", err)
	}
	if len(own) != 1 || own[0].UserID != owner.ID {
		t.Fatalf("ListVisible(includeAll=false) = %+v, want only owner's job", own)
	}

	all, err := repo.ListVisible(ctx, owner.ID, true)
	if err != nil {
		t.Fatalf("ListVisible: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("ListVisible(includeAll=true) = %d jobs, want 2", len(all))
	}
}

func TestBackgroundJobRepository_StatusTransitions(t *testing.T) {
	repo, _, u, th := newBackgroundJobTestEnv(t)
	ctx := context.Background()
	job := newJob(u.ID, th.ID, models.BackgroundJobRunning)
	if err := repo.Create(ctx, job); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := repo.MarkSuspended(ctx, job.ID); err != nil {
		t.Fatalf("MarkSuspended: %v", err)
	}
	got, _ := repo.FindByID(ctx, job.ID)
	if got.Status != models.BackgroundJobSuspended {
		t.Fatalf("Status = %q after MarkSuspended, want suspended", got.Status)
	}

	if err := repo.MarkFailed(ctx, job.ID, "boom"); err != nil {
		t.Fatalf("MarkFailed: %v", err)
	}
	got, _ = repo.FindByID(ctx, job.ID)
	if got.Status != models.BackgroundJobFailed || got.Error != "boom" || got.FinishedAt == nil {
		t.Fatalf("after MarkFailed: %+v", got)
	}

	if err := repo.MarkAutoPRStarted(ctx, job.ID); err != nil {
		t.Fatalf("MarkAutoPRStarted: %v", err)
	}
	got, _ = repo.FindByID(ctx, job.ID)
	if !got.AutoPRStarted {
		t.Fatal("AutoPRStarted did not persist")
	}

	if err := repo.MarkDone(ctx, job.ID); err != nil {
		t.Fatalf("MarkDone: %v", err)
	}
	got, _ = repo.FindByID(ctx, job.ID)
	if got.Status != models.BackgroundJobDone || got.FinishedAt == nil {
		t.Fatalf("after MarkDone: %+v", got)
	}
}

func TestBackgroundJobRepository_MarkRunningAsInterruptedIsScopedAndIdempotent(t *testing.T) {
	repo, gdb, u, _ := newBackgroundJobTestEnv(t)
	ctx := context.Background()
	running := &models.ChatThread{ID: models.NewID(), UserID: u.ID, Title: "t"}
	done := &models.ChatThread{ID: models.NewID(), UserID: u.ID, Title: "t"}
	if err := gdb.Create(running).Error; err != nil {
		t.Fatalf("create thread: %v", err)
	}
	if err := gdb.Create(done).Error; err != nil {
		t.Fatalf("create thread: %v", err)
	}
	runningJob := newJob(u.ID, running.ID, models.BackgroundJobRunning)
	doneJob := newJob(u.ID, done.ID, models.BackgroundJobDone)
	if err := repo.Create(ctx, runningJob); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := repo.Create(ctx, doneJob); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := repo.MarkRunningAsInterrupted(ctx); err != nil {
		t.Fatalf("MarkRunningAsInterrupted: %v", err)
	}

	got, _ := repo.FindByID(ctx, runningJob.ID)
	if got.Status != models.BackgroundJobInterrupted {
		t.Fatalf("running job Status = %q, want interrupted", got.Status)
	}
	got, _ = repo.FindByID(ctx, doneJob.ID)
	if got.Status != models.BackgroundJobDone {
		t.Fatalf("done job Status = %q, want unchanged (done)", got.Status)
	}

	// Idempotent: a second sweep with nothing left running touches nothing
	// and errors on nothing.
	if err := repo.MarkRunningAsInterrupted(ctx); err != nil {
		t.Fatalf("second MarkRunningAsInterrupted: %v", err)
	}

	interrupted, err := repo.ListInterrupted(ctx)
	if err != nil {
		t.Fatalf("ListInterrupted: %v", err)
	}
	if len(interrupted) != 1 || interrupted[0].ID != runningJob.ID {
		t.Fatalf("ListInterrupted = %+v, want just %s", interrupted, runningJob.ID)
	}
}

func TestBackgroundJobRepository_MarkRunningClearsFinishedAt(t *testing.T) {
	repo, _, u, th := newBackgroundJobTestEnv(t)
	ctx := context.Background()
	job := newJob(u.ID, th.ID, models.BackgroundJobRunning)
	if err := repo.Create(ctx, job); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := repo.MarkInterrupted(ctx, job.ID); err != nil {
		t.Fatalf("MarkInterrupted: %v", err)
	}
	got, _ := repo.FindByID(ctx, job.ID)
	if got.FinishedAt == nil {
		t.Fatal("MarkInterrupted did not set finished_at")
	}

	if err := repo.MarkRunning(ctx, job.ID); err != nil {
		t.Fatalf("MarkRunning: %v", err)
	}
	got, _ = repo.FindByID(ctx, job.ID)
	if got.Status != models.BackgroundJobRunning || got.FinishedAt != nil {
		t.Fatalf("after resume MarkRunning: %+v, want running with no finished_at", got)
	}
}
