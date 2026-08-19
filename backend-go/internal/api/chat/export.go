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

	exportID, err := h.exports.ExportChat(ctx, req.ThreadID, authedUser.ID, req.ExpiresAt)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// The response body is the bare export id, not a wrapper object: both
	// existing callers of this route -- src/lib/backend/chat-api.ts's
	// exportChat, and chat-export-popup.tsx's `.ifOk((exportId) => ...)` --
	// read the resolved JSON body directly as the id string and build
	// `${origin}/export/${exportId}` from it. Encoding
	// `{"message": "..."}` here (as this handler did until now) silently
	// broke that: `exportId` became the whole object, and the copied link
	// read literally as ".../export/[object Object]" -- a bug entirely
	// hidden from any test that only checks the response status.
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(exportID)
}
