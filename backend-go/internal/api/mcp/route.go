package mcp

import (
	"encoding/json"
	"errors"
	"net/http"

	"amiro/backend/internal/auth"
	"amiro/backend/internal/mcp"
)

// saveRequest ports McpServerTable's insert shape (mcp/route.ts:23):
// `id` present means update, absent means create -- an upsert, matching
// saveMcpClientAction/persistClient's own behavior (mcp/actions.ts:57).
type saveRequest struct {
	ID         string           `json:"id,omitempty"`
	Name       string           `json:"name"`
	Config     mcp.ServerConfig `json:"config"`
	Visibility string           `json:"visibility,omitempty"`
}

// Save ports mcp/route.ts's POST handler. Any authenticated user may
// create/update their own servers -- see mcp.CanManage's doc comment for
// why this diverges from the TS route's canCreateMCP() gate.
func (h *Handler) Save(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req saveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.ID != "" {
		existing, err := h.manager.Get(r.Context(), req.ID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if existing == nil {
			http.Error(w, "MCP server not found", http.StatusNotFound)
			return
		}
		if !mcp.CanManage(authedUser, existing.UserID, existing.Visibility) {
			http.Error(w, "You don't have permission to update this MCP connection", http.StatusForbidden)
			return
		}
	}

	server, err := h.manager.Save(r.Context(), mcp.SaveInput{
		ID:         req.ID,
		Name:       req.Name,
		Config:     req.Config,
		UserID:     authedUser.ID,
		Visibility: req.Visibility,
	})
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, mcp.ErrInvalidName) || errors.Is(err, mcp.ErrDuplicateName) {
			status = http.StatusBadRequest
		}
		http.Error(w, err.Error(), status)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "id": server.ID})
}
