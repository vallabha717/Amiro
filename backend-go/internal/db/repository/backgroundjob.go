package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"

	"amiro/backend/internal/db/models"
)

// BackgroundJobRepository persists background agent runs
// (docs/coding-agent-parity/05-background-agent-runs.md). The worker's
// in-memory registry is a liveness cache over these rows, never the source
// of truth -- every status transition lands here first.
type BackgroundJobRepository struct {
	db *gorm.DB
}

func NewBackgroundJobRepository(db *gorm.DB) *BackgroundJobRepository {
	return &BackgroundJobRepository{db: db}
}

func (r *BackgroundJobRepository) Create(ctx context.Context, job *models.BackgroundJob) error {
	return r.db.WithContext(ctx).Create(job).Error
}

func (r *BackgroundJobRepository) FindByID(ctx context.Context, id string) (*models.BackgroundJob, error) {
	var job models.BackgroundJob
	err := r.db.WithContext(ctx).Where("id = ?", id).First(&job).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &job, nil
}

// FindActiveByThreadID returns threadID's non-terminal job, if it has one.
// This is what lets chat.Handler.RunTurn recognize -- for any caller,
// whether the dedicated worker goroutine or an ordinary approval
// resubmission through /api/chat -- that a thread it just ran a turn for
// belongs to a background job, without threading a job id through every
// call site that can end up resuming one.
func (r *BackgroundJobRepository) FindActiveByThreadID(ctx context.Context, threadID string) (*models.BackgroundJob, error) {
	var job models.BackgroundJob
	err := r.db.WithContext(ctx).
		Where("thread_id = ? AND status IN ?", threadID, []string{models.BackgroundJobRunning, models.BackgroundJobSuspended}).
		First(&job).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &job, nil
}

// CountRunning reports how many jobs are actively occupying a worker
// goroutine right now, for the concurrency cap
// (docs/coding-agent-parity/05-background-agent-runs.md's "capped at 2"). A
// suspended job holds no goroutine and no resources, so it does not count --
// only running does.
func (r *BackgroundJobRepository) CountRunning(ctx context.Context) (int64, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&models.BackgroundJob{}).
		Where("status = ?", models.BackgroundJobRunning).
		Count(&count).Error
	return count, err
}

// RunningJobs lists every currently-running job, for a refusal message that
// names them (the design doc's "refused with a message naming the running
// jobs, not queued silently").
func (r *BackgroundJobRepository) RunningJobs(ctx context.Context) ([]models.BackgroundJob, error) {
	var jobs []models.BackgroundJob
	err := r.db.WithContext(ctx).Where("status = ?", models.BackgroundJobRunning).Find(&jobs).Error
	return jobs, err
}

// ListVisible returns userID's own jobs, newest first -- or, if
// includeAll is set (the caller is an admin), every user's jobs. There is
// no third visibility tier to model; see the "own + visible-to-role"
// investigation this repository's design followed.
func (r *BackgroundJobRepository) ListVisible(ctx context.Context, userID string, includeAll bool) ([]models.BackgroundJob, error) {
	q := r.db.WithContext(ctx).Order("started_at DESC")
	if !includeAll {
		q = q.Where("user_id = ?", userID)
	}
	var jobs []models.BackgroundJob
	err := q.Find(&jobs).Error
	return jobs, err
}

// ListInterrupted returns every job left interrupted by a prior shutdown,
// for ResumeInterrupted to re-check trust against on the next launch.
func (r *BackgroundJobRepository) ListInterrupted(ctx context.Context) ([]models.BackgroundJob, error) {
	var jobs []models.BackgroundJob
	err := r.db.WithContext(ctx).Where("status = ?", models.BackgroundJobInterrupted).Find(&jobs).Error
	return jobs, err
}

// MarkRunning transitions a job (freshly created, or a resumed
// interrupted/suspended one) back into running, clearing any finished_at a
// prior interruption left -- a job actively being worked has not finished.
func (r *BackgroundJobRepository) MarkRunning(ctx context.Context, id string) error {
	return r.db.WithContext(ctx).Model(&models.BackgroundJob{}).Where("id = ?", id).
		Updates(map[string]any{"status": models.BackgroundJobRunning, "finished_at": nil}).Error
}

func (r *BackgroundJobRepository) MarkSuspended(ctx context.Context, id string) error {
	return r.db.WithContext(ctx).Model(&models.BackgroundJob{}).Where("id = ?", id).
		Update("status", models.BackgroundJobSuspended).Error
}

func (r *BackgroundJobRepository) MarkDone(ctx context.Context, id string) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&models.BackgroundJob{}).Where("id = ?", id).
		Updates(map[string]any{"status": models.BackgroundJobDone, "finished_at": now}).Error
}

func (r *BackgroundJobRepository) MarkFailed(ctx context.Context, id, errMsg string) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&models.BackgroundJob{}).Where("id = ?", id).
		Updates(map[string]any{"status": models.BackgroundJobFailed, "error": errMsg, "finished_at": now}).Error
}

func (r *BackgroundJobRepository) MarkInterrupted(ctx context.Context, id string) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&models.BackgroundJob{}).Where("id = ?", id).
		Updates(map[string]any{"status": models.BackgroundJobInterrupted, "finished_at": now}).Error
}

func (r *BackgroundJobRepository) MarkAutoPRStarted(ctx context.Context, id string) error {
	return r.db.WithContext(ctx).Model(&models.BackgroundJob{}).Where("id = ?", id).
		Update("auto_pr_started", true).Error
}

// MarkRunningAsInterrupted marks every job still "running" as interrupted --
// the final, belt-and-suspenders sweep Worker.Shutdown runs after canceling
// every job context and waiting (bounded) for their goroutines to return.
// Idempotent and cheap to call even when every goroutine already exited
// cleanly: a bulk WHERE status = 'running' update touches zero rows then.
func (r *BackgroundJobRepository) MarkRunningAsInterrupted(ctx context.Context) error {
	return r.db.WithContext(ctx).Model(&models.BackgroundJob{}).
		Where("status = ?", models.BackgroundJobRunning).
		Update("status", models.BackgroundJobInterrupted).Error
}
