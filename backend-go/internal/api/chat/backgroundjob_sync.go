package chat

import (
	"context"
	"fmt"
	"os/exec"
	"strings"

	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/db/models"
)

// syncBackgroundJob keeps threadID's background job row (if it has one) in
// sync with whatever chat.RunTurn just did to it.
//
// Called from RunTurn's own tail, unconditionally when a job repository is
// wired -- which means this runs identically whether the caller was the
// dedicated worker goroutine's initial call, a later approval resubmission
// through the ordinary POST /api/chat route (any surface -- see the design
// doc's "resolvable from any surface" decision), or amiro run against a
// job's thread. There is exactly one place a job's status changes, matching
// docs/coding-agent-parity's "compose existing primitives, no parallel
// mechanism" principle: resuming a suspended job is not a distinct code
// path, it is an ordinary chat continuation that happens to update one more
// row afterward.
func (h *Handler) syncBackgroundJob(ctx context.Context, threadID string, req TurnRequest, result TurnResult, loopErr error, ctxCanceled bool) {
	job, err := h.backgroundJobs.FindActiveByThreadID(ctx, threadID)
	if err != nil || job == nil {
		return
	}

	switch {
	case ctxCanceled:
		// Cut off from outside -- graceful shutdown canceling the job's own
		// context is the only thing that does this to a background job's
		// context, which has no deadline of its own. Not the job's own
		// error and not a clean finish -- see internal/agent/background's
		// doc comment. Checked directly on the turn's own context rather
		// than by inspecting loopErr with errors.Is: a real provider
		// client's error wrapping does not reliably preserve
		// context.Canceled through the chain (found live -- see runner.go's
		// comment where ctxCanceled is captured).
		_ = h.backgroundJobs.MarkInterrupted(ctx, job.ID)
	case loopErr != nil:
		_ = h.backgroundJobs.MarkFailed(ctx, job.ID, loopErr.Error())
	case turnSuspended(result):
		_ = h.backgroundJobs.MarkSuspended(ctx, job.ID)
	case job.AutoPR && !job.AutoPRStarted:
		_ = h.backgroundJobs.MarkAutoPRStarted(ctx, job.ID)
		h.runAutoPRFollowUp(ctx, threadID, req, job)
	default:
		_ = h.backgroundJobs.MarkDone(ctx, job.ID)
	}
}

// turnSuspended reports whether any call in this turn stopped for an
// approval or a client-executed tool -- both recorded identically as
// Observation.Suspended (session/event.go), read here rather than from the
// live emitter so this works the same whether or not anything was actually
// streaming (see tool_scheduler.go: the persisted parts are projected from
// this same log, independent of the emitter).
func turnSuspended(result TurnResult) bool {
	if result.Log == nil {
		return false
	}
	for _, e := range result.Log.Events() {
		if e.Observation != nil && e.Observation.Suspended {
			return true
		}
	}
	return false
}

// runAutoPRFollowUp is the design doc's completion action: walkthrough, push
// a job-created branch, open a PR -- each still going through its own
// AlwaysAsk gate exactly as an interactive call would
// (docs/coding-agent-parity/05-background-agent-runs.md).
//
// This is one more chat.RunTurn call, not a direct invocation of the
// push/create_pr tools' Execute -- the whole reason a suspended approval is
// resolvable from any surface is that resolveApprovals works over a
// message's persisted parts, which only exist because the model, not job
// orchestration code, made the call inside an ordinary turn. Bypassing the
// model here would produce a call with no message part behind it: nothing
// for a human to see or resolve later. See progress/phase-04's "auto-PR
// composition" note for the fuller reasoning.
//
// What job code *does* decide, deterministically, is the one thing that
// must never be left to the model: the branch name. git's push tool always
// resolves and targets whatever branch is currently checked out (Phase 3's
// "current branch only" contract), so the workspace is switched to a fresh,
// job-named branch here, directly, before the follow-up turn ever starts --
// creating a new branch from HEAD is additive and never discards work, so
// this needs no tool, no model, and no approval of its own.
func (h *Handler) runAutoPRFollowUp(ctx context.Context, threadID string, req TurnRequest, job *models.BackgroundJob) {
	branch := jobBranchName(job.ID, job.Prompt)
	if err := createAndCheckoutBranch(ctx, job.WorkspaceRoot, branch); err != nil {
		_ = h.backgroundJobs.MarkFailed(ctx, job.ID, "auto_pr: could not create "+branch+": "+err.Error())
		return
	}
	base := resolveDefaultBranch(ctx, job.WorkspaceRoot)

	prompt := fmt.Sprintf(
		"Your task work is complete. The workspace is now on a new branch, %q, "+
			"created for this purpose -- do not switch branches or create another one. "+
			"Finish by, in order: (1) staging and committing any remaining uncommitted "+
			"changes, (2) calling the walkthrough tool to summarize everything you "+
			"changed in this task, (3) calling git with subcommand \"push\" to push "+
			"%q to the remote, (4) calling create_pr with base %q to open a pull "+
			"request. Do all four now, then stop.",
		branch, branch, base,
	)

	followUp := NewTextTurn(req.User, threadID, prompt).
		WithWorkspace(job.WorkspaceRoot).
		WithPermissionMode(req.PermissionMode).
		AsBackgroundJob()
	if req.ChatModel != nil {
		followUp = followUp.WithModel(req.ChatModel.Provider, req.ChatModel.Model)
	}

	// This nested RunTurn's own tail calls syncBackgroundJob again -- the
	// job is still non-terminal, and AutoPRStarted is now true, so that
	// call can only land in the suspended/failed/done branches, never
	// trigger a second follow-up. That single re-entrant hop is what marks
	// the job suspended (almost always, at the push step's AlwaysAsk gate)
	// or done from here on.
	_, _ = h.RunTurn(ctx, followUp, uimessage.NewDiscardWriter())
}

// jobBranchName is agent/<job-id>-<slug-of-the-prompt>, never the branch the
// user was on when the job started -- see the design doc's "never the
// branch the user was on" constraint.
func jobBranchName(jobID, prompt string) string {
	slug := slugify(prompt)
	if slug == "" {
		slug = "run"
	}
	return fmt.Sprintf("agent/%s-%s", jobID, slug)
}

// slugify lowercases and keeps only [a-z0-9], collapsing everything else to
// a single '-', capped short -- a branch name, not a description.
func slugify(s string) string {
	var b strings.Builder
	lastDash := true // suppresses a leading dash
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	out := strings.TrimRight(b.String(), "-")
	const maxLen = 40
	if len(out) > maxLen {
		out = strings.TrimRight(out[:maxLen], "-")
	}
	return out
}

// createAndCheckoutBranch creates a brand-new local branch from HEAD and
// switches to it. Safe by construction: a new branch pointing at the
// current commit neither discards uncommitted work nor rewrites history,
// which is why this runs as a direct subprocess rather than needing a model
// tool or an approval -- see git.go's own reasoning for why checkout stays
// absent from the model-facing tool for every *other* case.
func createAndCheckoutBranch(ctx context.Context, root, branch string) error {
	cmd := exec.CommandContext(ctx, "git", "checkout", "-b", branch)
	cmd.Dir = root
	cmd.Env = append(cmd.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=true")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// resolveDefaultBranch reads origin's default branch (what create_pr's base
// should target), falling back to "main" -- the same fallback a human
// guessing blind would make, and never a fatal error: a wrong guess here is
// a PR opened against the wrong base, not a lost result.
func resolveDefaultBranch(ctx context.Context, root string) string {
	cmd := exec.CommandContext(ctx, "git", "symbolic-ref", "refs/remotes/origin/HEAD")
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		return "main"
	}
	ref := strings.TrimSpace(string(out))
	parts := strings.Split(ref, "/")
	if len(parts) == 0 || parts[len(parts)-1] == "" {
		return "main"
	}
	return parts[len(parts)-1]
}
