package workflow

import (
	"encoding/json"
	"net/http"

	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/db/models"
	"betterchatbot/backend/internal/db/repository"
)

// GetStructure ports workflow/[id]/structure/route.ts's GET handler.
func (h *Handler) GetStructure(w http.ResponseWriter, r *http.Request) {
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

	structure, err := h.repo.SelectStructureByID(r.Context(), id, false)
	if err != nil {
		serverError(w, err)
		return
	}
	if structure == nil {
		http.Error(w, "Workflow not found", http.StatusNotFound)
		return
	}
	writeJSON(w, toStructureResponse(*structure))
}

// saveStructureRequest ports workflow/[id]/structure/route.ts's POST body
// (route.ts:25). WorkflowNode/WorkflowEdge decode straight off the
// frontend's camelCase JSON via encoding/json's case-insensitive field
// matching (no json tags needed on the shared GORM models for this
// direction -- only outgoing responses need the dto.go DTOs).
type saveStructureRequest struct {
	Nodes       []models.WorkflowNode `json:"nodes"`
	Edges       []models.WorkflowEdge `json:"edges"`
	DeleteNodes []string              `json:"deleteNodes,omitempty"`
	DeleteEdges []string              `json:"deleteEdges,omitempty"`
}

// SaveStructure ports workflow/[id]/structure/route.ts's POST handler.
func (h *Handler) SaveStructure(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		unauthorized(w)
		return
	}
	id := r.PathValue("id")

	var req saveStructureRequest
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

	for i := range req.Nodes {
		req.Nodes[i].WorkflowID = id
	}
	for i := range req.Edges {
		req.Edges[i].WorkflowID = id
	}

	if err := h.repo.SaveStructure(r.Context(), repository.SaveStructureInput{
		WorkflowID:  id,
		Nodes:       req.Nodes,
		Edges:       req.Edges,
		DeleteNodes: req.DeleteNodes,
		DeleteEdges: req.DeleteEdges,
	}); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, map[string]bool{"success": true})
}
