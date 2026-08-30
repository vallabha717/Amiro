// Package backgroundjob exposes background agent runs over HTTP
// (docs/coding-agent-parity/05-background-agent-runs.md): create one,
// list the caller's own (or, for an admin, everyone's), and read one job's
// current status.
//
// There is deliberately no resolve/resume-approval route here. A suspended
// job's pending approval lives on its thread as an ordinary
// data-tool-approval part, exactly like an interactive turn's, and is
// answered the same way -- POST /api/chat against that thread, from
// whichever surface the user has open. Building a second resolution path
// here would be exactly the "parallel mechanism" the design doc's principle
// 1 rules out.
package backgroundjob

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"amiro/backend/internal/agent/background"
	"amiro/backend/internal/agent/permission"
	"amiro/backend/internal/agent/workspace"
	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
)

type Handler struct {
	jobs   *repository.BackgroundJobRepository
	trust  *repository.WorkspaceTrustRepository
	chats  *repository.ChatRepository
	worker *background.Worker

	// defaultRoot is the server's own configured workspace root, used both
	// as the fallback when a create request omits workspaceRoot and as
	// IsTrustedForTurn's auto-grant comparison -- see workspacetrust's
	// identical field for why a status check and a turn must never
	// disagree about which roots are trusted.
	defaultRoot string
}

func NewHandler(jobs *repository.BackgroundJobRepository, trust *repository.WorkspaceTrustRepository, chats *repository.ChatRepository, worker *background.Worker, defaultRoot string) *Handler {
	return &Handler{jobs: jobs, trust: trust, chats: chats, worker: worker, defaultRoot: defaultRoot}
}

type createRequest struct {
	Prompt        string `json:"prompt"`
	Mode          string `json:"mode"`
	WorkspaceRoot string `json:"workspaceRoot,omitempty"`
	AutoPR        bool   `json:"autoPr,omitempty"`
}

type jobResponse struct {
	ID            string     `json:"id"`
	ThreadID      string     `json:"threadId"`
	WorkspaceRoot string     `json:"workspaceRoot"`
	Prompt        string     `json:"prompt"`
	Mode          string     `json:"mode"`
	Status        string     `json:"status"`
	AutoPR        bool       `json:"autoPr"`
	Error         string     `json:"error,omitempty"`
	StartedAt     time.Time  `json:"startedAt"`
	FinishedAt    *time.Time `json:"finishedAt,omitempty"`
}

func toJobResponse(j models.BackgroundJob) jobResponse {
	return jobResponse{
		ID: j.ID, ThreadID: j.ThreadID, WorkspaceRoot: j.WorkspaceRoot,
		Prompt: j.Prompt, Mode: j.Mode, Status: j.Status, AutoPR: j.AutoPR,
		Error: j.Error, StartedAt: j.StartedAt, FinishedAt: j.FinishedAt,
	}
}

// Create starts a new background job.
//
// Every refusal here is a refusal the design doc names explicitly: mode
// outside {edit, auto} (a job has no one to ask, so plan and interactive
// make no sense unattended), an untrusted workspace root (there is no such
// thing as a background run against an ungranted root), and the
// concurrency cap (refused by name, never queued silently).
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req createRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		httpjson.BadRequest(w, "prompt is required")
		return
	}

	mode := permission.ParseMode(req.Mode)
	if mode != permission.ModeEdit && mode != permission.ModeAuto {
		httpjson.BadRequest(w, `mode must be "edit" or "auto" -- a background job has no one to ask, so plan and interactive are refused at creation`)
		return
	}

	root := req.WorkspaceRoot
	if root == "" {
		root = h.defaultRoot
	}
	if root == "" {
		httpjson.BadRequest(w, "workspaceRoot is required")
		return
	}
	ws, err := workspace.New(root)
	if err != nil {
		httpjson.BadRequest(w, "workspaceRoot is not a directory this server can reach: "+err.Error())
		return
	}
	resolvedRoot := ws.Root()

	trusted, err := h.trust.IsTrustedForTurn(r.Context(), authedUser.ID, resolvedRoot, h.defaultRoot)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if !trusted {
		httpjson.Error(w, http.StatusForbidden,
			"this workspace has not been granted trust -- a background job may never run against an ungranted root")
		return
	}

	running, err := h.jobs.RunningJobs(r.Context())
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if len(running) >= background.MaxConcurrent {
		names := make([]string, 0, len(running))
		for _, j := range running {
			names = append(names, j.ID)
		}
		httpjson.Error(w, http.StatusConflict, fmt.Sprintf(
			"%d background jobs are already running (max %d): %s",
			len(running), background.MaxConcurrent, strings.Join(names, ", ")))
		return
	}

	// The thread has to exist before the job row does: background_jobs'
	// foreign key on chat_thread means a job can never point at a thread
	// nothing backs, and chat.RunTurn only creates a thread lazily on its
	// first turn -- which for a background job is the worker goroutine
	// Start is about to launch, too late for this insert to reference.
	threadID := models.NewID()
	if err := h.chats.InsertThread(r.Context(), &models.ChatThread{ID: threadID, UserID: authedUser.ID, Title: req.Prompt}); err != nil {
		httpjson.ServerError(w, err)
		return
	}

	job := &models.BackgroundJob{
		ThreadID:      threadID,
		UserID:        authedUser.ID,
		WorkspaceRoot: resolvedRoot,
		Prompt:        req.Prompt,
		Mode:          string(mode),
		Status:        models.BackgroundJobRunning,
		AutoPR:        req.AutoPR,
		StartedAt:     time.Now(),
	}
	if err := h.jobs.Create(r.Context(), job); err != nil {
		httpjson.ServerError(w, err)
		return
	}

	h.worker.Start(*job, authedUser)
	httpjson.Write(w, http.StatusCreated, toJobResponse(*job))
}

// List returns the caller's own jobs, newest first -- or, for an admin,
// every user's. There is no third visibility tier.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}
	includeAll := authedUser.Role == "admin"
	jobs, err := h.jobs.ListVisible(r.Context(), authedUser.ID, includeAll)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	resp := make([]jobResponse, 0, len(jobs))
	for _, j := range jobs {
		resp = append(resp, toJobResponse(j))
	}
	httpjson.OK(w, map[string]any{"jobs": resp})
}

// Get returns one job's current status, for the panel to poll.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}
	job, err := h.jobs.FindByID(r.Context(), r.PathValue("id"))
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if job == nil {
		httpjson.NotFound(w, "job not found")
		return
	}
	if job.UserID != authedUser.ID && authedUser.Role != "admin" {
		httpjson.Forbidden(w)
		return
	}
	httpjson.OK(w, toJobResponse(*job))
}
