// Package bookmark ports src/app/api/bookmark/route.ts: POST to bookmark
// an item, DELETE to un-bookmark it. Both take the same body.
package bookmark

import (
	"net/http"

	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/repository"
)

type Handler struct {
	bookmarks *repository.BookmarkRepository
}

func NewHandler(bookmarks *repository.BookmarkRepository) *Handler {
	return &Handler{bookmarks: bookmarks}
}

// request ports BookmarkTable's zod shape (bookmark/route.ts:5).
type request struct {
	ItemID   string `json:"itemId"`
	ItemType string `json:"itemType"`
}

func (req request) validate() (string, bool) {
	if req.ItemID == "" {
		return "itemId is required", false
	}
	if req.ItemType != repository.BookmarkItemTypeAgent && req.ItemType != repository.BookmarkItemTypeWorkflow {
		return `itemType must be "agent" or "workflow"`, false
	}
	return "", true
}

// Create ports bookmark/route.ts's POST: access-checked, then idempotent.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req request
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if msg, ok := req.validate(); !ok {
		httpjson.BadRequest(w, msg)
		return
	}

	hasAccess, err := h.bookmarks.CheckItemAccess(r.Context(), req.ItemID, req.ItemType, authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if !hasAccess {
		httpjson.NotFound(w, "Item not found or access denied")
		return
	}

	if err := h.bookmarks.Create(r.Context(), authedUser.ID, req.ItemID, req.ItemType); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}

// Delete ports bookmark/route.ts's DELETE. Deliberately no access check,
// matching the TS route: removing a bookmark you hold is always allowed,
// even if the underlying item has since gone private or been deleted --
// otherwise a user could be left unable to clear a dead bookmark.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req request
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if msg, ok := req.validate(); !ok {
		httpjson.BadRequest(w, msg)
		return
	}

	if err := h.bookmarks.Remove(r.Context(), authedUser.ID, req.ItemID, req.ItemType); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}
