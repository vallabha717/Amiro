package models

import (
	"time"

	"gorm.io/gorm"
)

// Background job status values (docs/coding-agent-parity/05-background-agent-runs.md).
const (
	// BackgroundJobRunning is the job's state while its worker goroutine is
	// actively driving chat.RunTurn, and again while a resumed turn is
	// running after a suspended approval was answered.
	BackgroundJobRunning = "running"
	// BackgroundJobSuspended means the turn stopped on a gated call (most
	// often push/create_pr's AlwaysAsk) and is waiting for a human to answer
	// the pending approval on its thread, from any surface.
	BackgroundJobSuspended = "suspended"
	// BackgroundJobDone is a clean finish with no pending suspension.
	BackgroundJobDone = "done"
	// BackgroundJobFailed is a turn that ended in an error that was not a
	// shutdown-driven cancellation -- a budget overrun, a containment
	// failure, a broken tool.
	BackgroundJobFailed = "failed"
	// BackgroundJobInterrupted is a job whose context was canceled by
	// graceful shutdown while its worker was still running. Not the job's
	// own error and not a clean finish -- see Worker's doc comment.
	BackgroundJobInterrupted = "interrupted"
)

// BackgroundJob is one durable, possibly unattended agent run
// (docs/coding-agent-parity/05-background-agent-runs.md). The in-memory
// worker registry is a liveness cache over this row, never the source of
// truth: a row here outlives the process that created it.
type BackgroundJob struct {
	ID            string     `gorm:"column:id;primaryKey"`
	ThreadID      string     `gorm:"column:thread_id;not null"`
	UserID        string     `gorm:"column:user_id;not null"`
	WorkspaceRoot string     `gorm:"column:workspace_root;not null"`
	Prompt        string     `gorm:"column:prompt;not null"`
	// Mode is "edit" or "auto" -- enforced at creation time, never "plan" or
	// "interactive". See the meta guard in tests/suites/meta.
	Mode string `gorm:"column:mode;not null"`
	// Status is one of the BackgroundJob* constants above.
	Status string `gorm:"column:status;not null"`
	// AutoPR opts this job into the walkthrough+push+create_pr completion
	// action on a clean finish. Never a default -- see the design doc's
	// "Auto-PR creating branch/PR noise" risk.
	AutoPR bool `gorm:"column:auto_pr;not null"`
	// AutoPRStarted marks that the completion action's follow-up turn has
	// already been kicked off, so a job resumed multiple times (once per
	// push/create_pr approval) never starts it twice.
	AutoPRStarted bool `gorm:"column:auto_pr_started;not null"`
	// Error is set when Status is failed -- the loop error's own message,
	// the same wording a live turn would have streamed as an error frame.
	Error      string     `gorm:"column:error;not null"`
	StartedAt  time.Time  `gorm:"column:started_at;not null"`
	FinishedAt *time.Time `gorm:"column:finished_at"`
}

func (BackgroundJob) TableName() string { return "background_jobs" }

func (b *BackgroundJob) BeforeCreate(tx *gorm.DB) error {
	if b.ID == "" {
		b.ID = NewID()
	}
	return nil
}

// Terminal reports whether this status is one syncBackgroundJob should never
// overwrite -- a finished job's row is a record, not a cursor.
func (b BackgroundJob) Terminal() bool {
	switch b.Status {
	case BackgroundJobDone, BackgroundJobFailed, BackgroundJobInterrupted:
		return true
	default:
		return false
	}
}
