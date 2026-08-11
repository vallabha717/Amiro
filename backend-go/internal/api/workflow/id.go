package workflow

import (
	"encoding/json"
	"net/http"

	"betterchatbot/backend/internal/auth"
)

// Get ports workflow/[id]/route.ts's GET handler.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		unauthorized(w)
		return
	}
	id := r.PathValue("id")

	hasAccess, err := h.repo.CheckAccess(r.Context(), id, authedUser.ID, true)
	if err != nil {
		serverError(w, err)
		return
	}
	if !hasAccess {
		unauthorized(w)
		return
	}

	wf, err := h.repo.SelectByID(r.Context(), id)
	if err != nil {
		serverError(w, err)
		return
	}
	if wf == nil {
		http.Error(w, "Workflow not found", http.StatusNotFound)
		return
	}
	writeJSON(w, toWorkflowResponse(*wf))
}

type updateRequest struct {
	Visibility  *string `json:"visibility,omitempty"`
	IsPublished *bool   `json:"isPublished,omitempty"`
}

// Update ports workflow/[id]/route.ts's PUT handler: updates only
// visibility/isPublished, leaving every other field as-is.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		unauthorized(w)
		return
	}
	id := r.PathValue("id")

	var req updateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		badRequest(w, "invalid request body")
		return
	}

	hasAccess, err := h.repo.CheckAccess(r.Context(), id, authedUser.ID, false)
	if err != nil {
		serverError(w, err)
		return
	}
	if !hasAccess {
		unauthorized(w)
		return
	}

	existing, err := h.repo.SelectByID(r.Context(), id)
	if err != nil {
		serverError(w, err)
		return
	}
	if existing == nil {
		http.Error(w, "Workflow not found", http.StatusNotFound)
		return
	}

	if req.Visibility != nil {
		existing.Visibility = *req.Visibility
	}
	if req.IsPublished != nil {
		existing.IsPublished = *req.IsPublished
	}

	saved, err := h.repo.Save(r.Context(), existing, true)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, toWorkflowResponse(*saved))
}

// Delete ports workflow/[id]/route.ts's DELETE handler.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		unauthorized(w)
		return
	}
	id := r.PathValue("id")

	hasAccess, err := h.repo.CheckAccess(r.Context(), id, authedUser.ID, false)
	if err != nil {
		serverError(w, err)
		return
	}
	if !hasAccess {
		unauthorized(w)
		return
	}

	if err := h.repo.Delete(r.Context(), id); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, map[string]string{"message": "Workflow deleted"})
}
