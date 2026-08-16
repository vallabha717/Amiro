package mcp

import (
	"encoding/json"
	"net/http"

	"amiro/backend/internal/auth"
	"amiro/backend/internal/mcp"
)

// Get ports selectMcpClientAction (mcp/actions.ts:46).
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")

	info, err := h.manager.Get(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if info == nil {
		http.Error(w, "MCP server not found", http.StatusNotFound)
		return
	}
	if info.UserID != authedUser.ID && info.Visibility != "public" {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}
	if info.UserID != authedUser.ID {
		info.Config = nil // hidden from non-owners, matching mcp/list/route.ts:39
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(info)
}

// Delete ports mcp/[id]/route.ts's DELETE handler.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")

	info, err := h.manager.Get(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if info == nil {
		http.Error(w, "MCP server not found", http.StatusNotFound)
		return
	}
	if !mcp.CanManage(authedUser, info.UserID, info.Visibility) {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	if err := h.manager.Remove(r.Context(), id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// Refresh ports refreshMcpClientAction (mcp/actions.ts:136) -- see
// handler.go's doc comment on why this HTTP surface exists ahead of Phase 7.
func (h *Handler) Refresh(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")

	info, err := h.manager.Get(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if info == nil {
		http.Error(w, "MCP server not found", http.StatusNotFound)
		return
	}
	if !mcp.CanManage(authedUser, info.UserID, info.Visibility) {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	if _, err := h.manager.Refresh(r.Context(), id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

type shareRequest struct {
	Visibility string `json:"visibility"`
}

// Share ports shareMcpServerAction (mcp/actions.ts:174): admin-only.
func (h *Handler) Share(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if !mcp.CanShare(authedUser) {
		http.Error(w, "Only administrators can feature MCP servers", http.StatusForbidden)
		return
	}

	var req shareRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	id := r.PathValue("id")
	if err := h.manager.ShareVisibility(r.Context(), id, req.Visibility); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// CallTool ports callMcpToolAction (mcp/actions.ts:158).
func (h *Handler) CallTool(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")
	toolName := r.PathValue("tool")

	info, err := h.manager.Get(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if info == nil {
		http.Error(w, "MCP server not found", http.StatusNotFound)
		return
	}
	if info.UserID != authedUser.ID && info.Visibility != "public" {
		http.Error(w, "Unauthorized", http.StatusForbidden)
		return
	}

	var args json.RawMessage
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&args)
	}

	result := h.manager.CallTool(r.Context(), id, toolName, args)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}
