package chat

import (
	"encoding/json"
	"net/http"
	"time"

	"amiro/backend/internal/auth"
)

type exportRequest struct {
	ThreadID  string     `json:"threadId"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
}

// Export ports chat/export/route.ts's POST handler: snapshot a thread the
// requesting user owns into a new chat_export row.
func (h *Handler) Export(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req exportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.ThreadID == "" {
		http.Error(w, "threadId is required", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	access, err := h.chats.CheckAccess(ctx, req.ThreadID, authedUser.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !access {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	if _, err := h.exports.ExportChat(ctx, req.ThreadID, authedUser.ID, req.ExpiresAt); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"message": "Chat exported successfully"})
}
