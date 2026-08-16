package thread

import (
	"net/http"

	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
)

// DeleteMessage ports deleteMessageAction (chat/actions.ts:88). Matches
// the Server Action's own trust level: session-gated but no per-message
// ownership check, since chatRepository.deleteChatMessage never took a
// userID either -- deleteChatMessage(id) unconditionally deletes by id on
// both sides.
func (h *Handler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}
	if err := h.chats.DeleteChatMessage(r.Context(), r.PathValue("id")); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}

// TruncateAfter ports deleteMessagesByChatIdAfterTimestampAction
// (chat/actions.ts:95): the "edit and resend" / "regenerate from here"
// path -- deletes the named message and everything after it in the same
// thread.
func (h *Handler) TruncateAfter(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}
	if err := h.chats.DeleteMessagesByChatIDAfterTimestamp(r.Context(), r.PathValue("id")); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}
