package mcp

import (
	"encoding/json"
	"net/http"

	"betterchatbot/backend/internal/auth"
)

// List ports mcp/list/route.ts's GET handler.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	servers, err := h.manager.List(r.Context(), authedUser.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(servers)
}
