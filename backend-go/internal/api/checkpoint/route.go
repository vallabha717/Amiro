package checkpoint

import (
	"net/http"

	"amiro/backend/internal/agent/checkpoint"
	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
)

// Files lists a specific turn's checkpointed files -- what the web
// dashboard's "Rewind to here" action on one assistant message renders as
// its confirmation dialog.
func (h *Handler) Files(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}
	threadID := r.URL.Query().Get("threadId")
	turnID := r.URL.Query().Get("turnId")
	if threadID == "" || turnID == "" {
		httpjson.BadRequest(w, "threadId and turnId are required")
		return
	}
	allowed, err := h.chats.CheckAccess(r.Context(), threadID, authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if !allowed {
		httpjson.Forbidden(w)
		return
	}

	rows, err := h.repo.ListForTurn(r.Context(), threadID, turnID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.OK(w, toFilesResponse(turnID, rows))
}

// Latest resolves "the most recent turn with checkpoints" for a thread --
// what the TUI's /rewind and Esc-Esc target, since neither names a specific
// message the way the web action does. An empty turnId with zero files
// (200, not 404) is the "nothing to rewind" state both surfaces render
// explicitly rather than showing a confusing empty confirmation.
func (h *Handler) Latest(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}
	threadID := r.URL.Query().Get("threadId")
	if threadID == "" {
		httpjson.BadRequest(w, "threadId is required")
		return
	}
	allowed, err := h.chats.CheckAccess(r.Context(), threadID, authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if !allowed {
		httpjson.Forbidden(w)
		return
	}

	turnID, found, err := h.repo.MostRecentTurnWithCheckpoints(r.Context(), threadID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if !found {
		httpjson.OK(w, filesResponse{Files: []fileResponse{}})
		return
	}

	rows, err := h.repo.ListForTurn(r.Context(), threadID, turnID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.OK(w, toFilesResponse(turnID, rows))
}

type restoreRequest struct {
	ThreadID string `json:"threadId"`
	TurnID   string `json:"turnId"`
}

// Restore reverts every file checkpointed for the request's turn -- the
// human's "yes" answer to the rewind confirmation. Takes the thread's
// exclusive write-lock for the duration, so this can never interleave with
// a live turn's writes to the same thread (permission.Session.writeMu).
func (h *Handler) Restore(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}
	var req restoreRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if req.ThreadID == "" || req.TurnID == "" {
		httpjson.BadRequest(w, "threadId and turnId are required")
		return
	}
	allowed, err := h.chats.CheckAccess(r.Context(), req.ThreadID, authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if !allowed {
		httpjson.Forbidden(w)
		return
	}

	sess := h.grants.For(req.ThreadID)
	sess.Lock()
	defer sess.Unlock()

	result, err := checkpoint.Restore(r.Context(), h.repo, h.blobs, req.ThreadID, req.TurnID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.OK(w, toRestoreResponse(result))
}
