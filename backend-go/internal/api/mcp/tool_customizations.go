package mcp

import (
	"encoding/json"
	"net/http"
	"time"

	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/db/models"
)

// toolCustomizationResponse ports McpToolCustomization (types/mcp.ts) --
// see server_customizations.go's toServerCustomizationResponse for why this
// is a DTO rather than encoding the GORM model directly.
type toolCustomizationResponse struct {
	ID          string    `json:"id"`
	UserID      string    `json:"userId"`
	ToolName    string    `json:"toolName"`
	McpServerID string    `json:"mcpServerId"`
	Prompt      *string   `json:"prompt,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

func toToolCustomizationResponse(c models.McpToolCustomization) toolCustomizationResponse {
	return toolCustomizationResponse{
		ID: c.ID, UserID: c.UserID, ToolName: c.ToolName, McpServerID: c.McpServerID,
		Prompt: c.Prompt, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt,
	}
}

// ListToolCustomizations ports
// tool-customizations/[server]/route.ts's GET handler.
func (h *Handler) ListToolCustomizations(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	server := r.PathValue("server")

	results, err := h.toolCustom.SelectByUserIDAndServerID(r.Context(), authedUser.ID, server)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	out := make([]toolCustomizationResponse, 0, len(results))
	for _, r := range results {
		out = append(out, toToolCustomizationResponse(r))
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// GetToolCustomization ports
// tool-customizations/[server]/[tool]/route.ts's GET handler.
func (h *Handler) GetToolCustomization(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	server, tool := r.PathValue("server"), r.PathValue("tool")

	result, err := h.toolCustom.Select(r.Context(), authedUser.ID, server, tool)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if result == nil {
		_ = json.NewEncoder(w).Encode(map[string]any{})
		return
	}
	_ = json.NewEncoder(w).Encode(toToolCustomizationResponse(*result))
}

type toolCustomizationRequest struct {
	Prompt *string `json:"prompt"`
}

// SaveToolCustomization ports
// tool-customizations/[server]/[tool]/route.ts's POST handler.
func (h *Handler) SaveToolCustomization(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	server, tool := r.PathValue("server"), r.PathValue("tool")

	var req toolCustomizationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	result, err := h.toolCustom.Upsert(r.Context(), authedUser.ID, server, tool, req.Prompt)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(toToolCustomizationResponse(*result))
}

// DeleteToolCustomization ports
// tool-customizations/[server]/[tool]/route.ts's DELETE handler.
func (h *Handler) DeleteToolCustomization(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	server, tool := r.PathValue("server"), r.PathValue("tool")

	if err := h.toolCustom.Delete(r.Context(), authedUser.ID, server, tool); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"success": true})
}
