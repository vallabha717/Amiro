// Package thread ports src/app/api/thread/route.ts (the sidebar's thread
// list) plus Phase 7's HTTP surface for the thread/message Server Actions
// in src/app/api/chat/actions.ts that had no route.ts counterpart at all
// until the frontend needed one to call over HTTP instead of importing
// the action function directly.
package thread

import (
	"net/http"
	"time"

	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/repository"
)

type Handler struct {
	chats *repository.ChatRepository
}

func NewHandler(chats *repository.ChatRepository) *Handler {
	return &Handler{chats: chats}
}

// threadResponse ports the object selectThreadsByUserId's mapper returns
// (chat-repository.pg.ts:100). lastMessageAt is epoch milliseconds, not an
// ISO timestamp -- the TS mapper calls .getTime() on it, and the sidebar
// compares it numerically.
type threadResponse struct {
	ID            string    `json:"id"`
	Title         string    `json:"title"`
	UserID        string    `json:"userId"`
	CreatedAt     time.Time `json:"createdAt"`
	LastMessageAt int64     `json:"lastMessageAt"`
}

// List ports thread/route.ts's GET.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	rows, err := h.chats.SelectThreadsByUserID(r.Context(), authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	out := make([]threadResponse, 0, len(rows))
	for _, row := range rows {
		item := threadResponse{
			ID:        row.ChatThread.ID,
			Title:     row.ChatThread.Title,
			UserID:    row.ChatThread.UserID,
			CreatedAt: row.ChatThread.CreatedAt,
		}
		if row.LastMessageAt != nil {
			item.LastMessageAt = row.LastMessageAt.UnixMilli()
		}
		out = append(out, item)
	}
	httpjson.OK(w, out)
}
