package thread

import (
	"encoding/json"
	"net/http"

	"betterchatbot/backend/internal/api/httpjson"
	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/db/models"
)

// threadWithMessagesResponse ports selectThreadWithMessagesAction's return
// shape (chat/actions.ts:69): the thread's own fields spread alongside a
// messages array, not nested under a "thread" key.
type threadWithMessagesResponse struct {
	ID        string               `json:"id"`
	Title     string               `json:"title"`
	UserID    string               `json:"userId"`
	CreatedAt json.RawMessage      `json:"createdAt"`
	Messages  []models.ChatMessage `json:"messages"`
}

// Get ports selectThreadWithMessagesAction: the thread this chat page
// loads, plus its full message history. Returns 404 both when the thread
// doesn't exist and when it belongs to someone else -- the Server Action
// returned null for both cases too (chat/actions.ts:76), never
// distinguishing "missing" from "not yours" to an unauthenticated caller.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	id := r.PathValue("id")
	thread, err := h.chats.SelectThread(r.Context(), id)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if thread == nil || thread.UserID != authedUser.ID {
		httpjson.NotFound(w, "Thread not found")
		return
	}

	messages, err := h.chats.SelectMessagesByThreadID(r.Context(), id)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	createdAt, _ := json.Marshal(thread.CreatedAt)
	httpjson.OK(w, threadWithMessagesResponse{
		ID: thread.ID, Title: thread.Title, UserID: thread.UserID,
		CreatedAt: createdAt, Messages: messages,
	})
}

type updateThreadRequest struct {
	Title string `json:"title"`
}

// Update ports updateThreadAction (chat/actions.ts:104): rename a thread.
// Ownership-checked here even though the Server Action wasn't -- a Server
// Action only ever ran with the calling page's own thread id in scope, but
// an HTTP endpoint is reachable with any id, so this closes a gap the
// in-process call never had a chance to open.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	id := r.PathValue("id")
	var req updateThreadRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}

	thread, err := h.chats.SelectThread(r.Context(), id)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if thread == nil || thread.UserID != authedUser.ID {
		httpjson.NotFound(w, "Thread not found")
		return
	}

	if err := h.chats.UpdateThread(r.Context(), id, req.Title); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}

// Delete ports deleteThreadAction (chat/actions.ts:92), same
// ownership-check addition as Update above.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	id := r.PathValue("id")
	thread, err := h.chats.SelectThread(r.Context(), id)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if thread == nil || thread.UserID != authedUser.ID {
		httpjson.NotFound(w, "Thread not found")
		return
	}

	if err := h.chats.DeleteThread(r.Context(), id); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}

// DeleteAll ports deleteThreadsAction/deleteUnarchivedThreadsAction
// (chat/actions.ts:110,114): DELETE /api/thread deletes every thread the
// user owns, or -- with ?scope=unarchived -- every thread that isn't in
// any archive.
func (h *Handler) DeleteAll(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	var err error
	if r.URL.Query().Get("scope") == "unarchived" {
		err = h.chats.DeleteUnarchivedThreads(r.Context(), authedUser.ID)
	} else {
		err = h.chats.DeleteAllThreads(r.Context(), authedUser.ID)
	}
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}
