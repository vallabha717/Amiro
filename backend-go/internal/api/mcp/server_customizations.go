package mcp

import (
	"encoding/json"
	"net/http"
	"time"

	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/models"
)

// serverCustomizationResponse ports McpServerCustomization (types/mcp.ts) --
// a small DTO, matching internal/api/auth's userResponse precedent, kept
// separate from internal/db/models (no json tags there anywhere in this
// codebase) so the wire shape stays camelCase like every other API
// response instead of leaking GORM's Go field names.
type serverCustomizationResponse struct {
	ID          string    `json:"id"`
	UserID      string    `json:"userId"`
	McpServerID string    `json:"mcpServerId"`
	Prompt      *string   `json:"prompt,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

func toServerCustomizationResponse(c *models.McpServerCustomization) serverCustomizationResponse {
	return serverCustomizationResponse{
		ID: c.ID, UserID: c.UserID, McpServerID: c.McpServerID,
		Prompt: c.Prompt, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt,
	}
}

// GetServerCustomization ports server-customizations/[server]/route.ts's
// GET handler.
func (h *Handler) GetServerCustomization(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	server := r.PathValue("server")

	result, err := h.serverCustom.SelectByUserIDAndServerID(r.Context(), authedUser.ID, server)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if result == nil {
		_ = json.NewEncoder(w).Encode(map[string]any{})
		return
	}
	_ = json.NewEncoder(w).Encode(toServerCustomizationResponse(result))
}

type serverCustomizationRequest struct {
	Prompt *string `json:"prompt"`
}

// SaveServerCustomization ports server-customizations/[server]/route.ts's
// POST handler.
func (h *Handler) SaveServerCustomization(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	server := r.PathValue("server")

	var req serverCustomizationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	result, err := h.serverCustom.Upsert(r.Context(), authedUser.ID, server, req.Prompt)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(toServerCustomizationResponse(result))
}

// DeleteServerCustomization ports server-customizations/[server]/route.ts's
// DELETE handler.
func (h *Handler) DeleteServerCustomization(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	server := r.PathValue("server")

	if err := h.serverCustom.DeleteByUserIDAndServerID(r.Context(), authedUser.ID, server); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"success": true})
}
