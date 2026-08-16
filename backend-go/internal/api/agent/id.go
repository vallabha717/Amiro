package agent

import (
	"encoding/json"
	"net/http"

	"gorm.io/datatypes"

	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/repository"
)

// Get ports agent/[id]/route.ts's GET.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	id := r.PathValue("id")
	hasAccess, err := h.agents.CheckAccess(r.Context(), id, authedUser.ID, false)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if !hasAccess {
		httpjson.Unauthorized(w)
		return
	}

	agent, err := h.agents.SelectByID(r.Context(), id, authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if agent == nil {
		httpjson.NotFound(w, "Agent not found")
		return
	}
	httpjson.OK(w, toAgentWithMetaResponse(*agent, true))
}

// updateRequest ports AgentUpdateSchema (types/agent.ts:33): every field
// optional, and an omitted field must stay unchanged rather than be
// blanked -- which is why each is a pointer/raw-JSON nil check.
type updateRequest struct {
	Name         *string         `json:"name"`
	Description  *string         `json:"description"`
	Icon         json.RawMessage `json:"icon"`
	Instructions json.RawMessage `json:"instructions"`
	Visibility   *string         `json:"visibility"`
}

// Update ports agent/[id]/route.ts's PUT, including its
// preserve-visibility rule: a non-owner editing a public agent may not
// change its visibility (agent/[id]/route.ts:60-67).
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	id := r.PathValue("id")
	var req updateRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}

	name := ""
	if req.Name != nil {
		name = *req.Name
		if writeAgentValidationError(w, name, req.Description, "") {
			return
		}
	}
	if req.Visibility != nil && !isValidVisibility(*req.Visibility) {
		httpjson.BadRequest(w, `visibility must be "public", "private" or "readonly"`)
		return
	}

	hasAccess, err := h.agents.CheckAccess(r.Context(), id, authedUser.ID, false)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if !hasAccess {
		httpjson.Unauthorized(w)
		return
	}

	existing, err := h.agents.SelectByID(r.Context(), id, authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if existing == nil {
		httpjson.NotFound(w, "Agent not found")
		return
	}
	if existing.UserID != authedUser.ID {
		preserved := existing.Visibility
		req.Visibility = &preserved
	}

	update := repositoryUpdate(req)
	agent, err := h.agents.Update(r.Context(), id, authedUser.ID, update)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if agent == nil {
		httpjson.NotFound(w, "Agent not found")
		return
	}
	httpjson.OK(w, toAgentResponse(*agent))
}

// Delete ports agent/[id]/route.ts's DELETE. checkAccess runs with
// destructive=true, which denies a non-owner even on a public agent.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	id := r.PathValue("id")
	hasAccess, err := h.agents.CheckAccess(r.Context(), id, authedUser.ID, true)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if !hasAccess {
		httpjson.Unauthorized(w)
		return
	}

	if err := h.agents.Delete(r.Context(), id, authedUser.ID); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}

func repositoryUpdate(req updateRequest) repository.AgentUpdate {
	update := repository.AgentUpdate{
		Name:        req.Name,
		Description: req.Description,
		Visibility:  req.Visibility,
	}
	if len(req.Icon) > 0 {
		update.Icon = datatypes.JSON(req.Icon)
	}
	if len(req.Instructions) > 0 {
		update.Instructions = datatypes.JSON(req.Instructions)
	}
	return update
}
