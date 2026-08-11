package workflow

import (
	"encoding/json"
	"net/http"

	"gorm.io/datatypes"

	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/db/models"
)

// List ports workflow/route.ts's GET.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		unauthorized(w)
		return
	}
	rows, err := h.repo.SelectAll(r.Context(), authedUser.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, toWorkflowSummaries(rows))
}

// saveRequest ports workflow/route.ts's POST body (route.ts:14-23).
type saveRequest struct {
	ID                  string          `json:"id,omitempty"`
	Name                string          `json:"name"`
	Description         *string         `json:"description,omitempty"`
	Icon                json.RawMessage `json:"icon,omitempty"`
	IsPublished         *bool           `json:"isPublished,omitempty"`
	Visibility          *string         `json:"visibility,omitempty"`
	NoGenerateInputNode bool            `json:"noGenerateInputNode,omitempty"`
}

// Save ports workflow/route.ts's POST handler: id present means edit
// (requires existing write access), absent means create.
func (h *Handler) Save(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		unauthorized(w)
		return
	}

	var req saveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		badRequest(w, "invalid request body")
		return
	}

	if req.ID != "" {
		hasAccess, err := h.repo.CheckAccess(r.Context(), req.ID, authedUser.ID, false)
		if err != nil {
			serverError(w, err)
			return
		}
		if !hasAccess {
			unauthorized(w)
			return
		}
	}

	wf := &models.Workflow{
		ID:          req.ID,
		Name:        req.Name,
		Description: req.Description,
		UserID:      authedUser.ID,
	}
	if req.Icon != nil {
		wf.Icon = datatypes.JSON(req.Icon)
	}
	if req.IsPublished != nil {
		wf.IsPublished = *req.IsPublished
	}
	if req.Visibility != nil {
		wf.Visibility = *req.Visibility
	}

	saved, err := h.repo.Save(r.Context(), wf, req.NoGenerateInputNode)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, toWorkflowResponse(*saved))
}
