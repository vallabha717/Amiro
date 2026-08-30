// Package background owns the goroutine a background agent run lives in
// (docs/coding-agent-parity/05-background-agent-runs.md).
//
// Nothing in this tree before Phase 4 owned work whose lifetime exceeds one
// HTTP request or PTY session: task subagents run synchronously inside their
// parent turn, and amiro run is one complete turn per process invocation.
// Worker is the first goroutine appwiring.App owns directly, tracked in an
// in-memory registry that is a liveness cache over the durable
// background_jobs row -- never the source of truth. Execution reuses
// chat.Handler.RunTurn exactly as amiro run already does; this package adds
// no second agent loop, only the bookkeeping that outlives one call to it.
package background

import (
	"context"
	"sync"
	"time"

	"amiro/backend/internal/agent/workspace"
	chatapi "amiro/backend/internal/api/chat"
	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
)

// MaxConcurrent caps how many jobs may occupy a worker goroutine at once --
// the design doc's deliberately conservative "2 concurrent background runs
// per instance for this plan", raised only once the shape has run in
// anger. Job creation enforces this, not Worker: a job already past the cap
// is refused before a row ever exists, rather than accepted and queued.
const MaxConcurrent = 2

// resumePrompt is what a resumed interrupted job's follow-up turn opens
// with. True mid-tool-call resumption has no mechanism anywhere in this
// codebase -- a canceled turn's partial work is simply history, exactly
// like any other turn a human walked away from -- so "resume" means an
// ordinary conversation continuation in the same thread, not replaying
// state.
const resumePrompt = "You were interrupted mid-task by a server restart. " +
	"Check the current state of your work (git status, and anything else " +
	"relevant), then continue from where you left off. If it turns out the " +
	"task was already complete, say so and stop."

// Worker drives background jobs' chat.RunTurn calls on goroutines it owns.
//
// Safe for concurrent use: Start may be called from any request handling a
// job-creation call while Shutdown runs from the process's own shutdown
// path.
type Worker struct {
	chat  *chatapi.Handler
	jobs  *repository.BackgroundJobRepository
	trust *repository.WorkspaceTrustRepository
	users *repository.UserRepository

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// New builds a Worker. Its own context is independent of any request's --
// canceled only by Shutdown -- because a background job must outlive the
// request that created it by definition.
func New(chat *chatapi.Handler, jobs *repository.BackgroundJobRepository, trust *repository.WorkspaceTrustRepository, users *repository.UserRepository) *Worker {
	ctx, cancel := context.WithCancel(context.Background())
	return &Worker{chat: chat, jobs: jobs, trust: trust, users: users, ctx: ctx, cancel: cancel}
}

// Start runs job's prompt as one chat.RunTurn call on a new goroutine.
//
// The caller (internal/api/backgroundjob) owns validation -- trust, mode,
// the concurrency cap -- and has already inserted job's row as `running`
// before calling this; Start's only job is to drive the call. The row's
// terminal status (suspended/done/failed/interrupted) is decided by
// chat.Handler.RunTurn's own tail (syncBackgroundJob), identically whether
// this goroutine's call suspends immediately or runs to completion -- this
// function never writes the job's status itself.
func (w *Worker) Start(job models.BackgroundJob, user *models.User) {
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		req := chatapi.NewTextTurn(user, job.ThreadID, job.Prompt).
			WithWorkspace(job.WorkspaceRoot).
			WithPermissionMode(job.Mode).
			AsBackgroundJob()
		_, _ = w.chat.RunTurn(w.ctx, req, uimessage.NewDiscardWriter())
	}()
}

// resume is Start's counterpart for a job ResumeInterrupted decided is safe
// to continue -- same shape, different prompt (see resumePrompt).
func (w *Worker) resume(job models.BackgroundJob, user *models.User) {
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		req := chatapi.NewTextTurn(user, job.ThreadID, resumePrompt).
			WithWorkspace(job.WorkspaceRoot).
			WithPermissionMode(job.Mode).
			AsBackgroundJob()
		_, _ = w.chat.RunTurn(w.ctx, req, uimessage.NewDiscardWriter())
	}()
}

// ResumeInterrupted re-checks every job graceful shutdown left interrupted
// and restarts the ones still safe to run: the workspace root must still
// resolve and the user's trust grant for it must still hold. Anything else
// is left interrupted for the user to see and restart explicitly, per the
// design doc -- silently resuming a job whose grant was revoked while the
// process was down would be exactly the trust-gate bypass Phase 0 exists to
// prevent.
func (w *Worker) ResumeInterrupted(ctx context.Context) {
	jobs, err := w.jobs.ListInterrupted(ctx)
	if err != nil {
		return
	}
	for _, job := range jobs {
		ws, err := workspace.New(job.WorkspaceRoot)
		if err != nil {
			continue
		}
		trusted, err := w.trust.IsTrusted(ctx, job.UserID, ws.Root())
		if err != nil || !trusted {
			continue
		}
		withUser, err := w.users.GetByID(ctx, job.UserID)
		if err != nil || withUser == nil {
			continue
		}
		if err := w.jobs.MarkRunning(ctx, job.ID); err != nil {
			continue
		}
		user := withUser.User
		w.resume(job, &user)
	}
}

// Shutdown cancels every job this Worker started and waits, bounded by
// timeout, for their goroutines to notice and return. Whatever is still
// "running" afterward -- whether its goroutine exited within the deadline
// or not -- is marked interrupted in one final bulk update, so a job can
// never be left claiming a status that stopped being true the moment this
// process went away.
func (w *Worker) Shutdown(timeout time.Duration) {
	w.cancel()
	done := make(chan struct{})
	go func() {
		w.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
	}
	_ = w.jobs.MarkRunningAsInterrupted(context.Background())
}
