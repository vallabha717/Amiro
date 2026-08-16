package export

import (
	"encoding/json"
	"net/http"

	"gorm.io/datatypes"

	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/models"
)

// ListComments ports export/[id]/comments/route.ts's GET. The session is
// optional (auth.OptionalSession, mirroring the TS
// `getUserId().catch(() => undefined)`): anyone with the share link may
// read the thread, and being signed in only adds the per-comment isOwner
// flag that drives the delete button.
func (h *Handler) ListComments(w http.ResponseWriter, r *http.Request) {
	userID := ""
	if authedUser, ok := auth.UserFromContext(r.Context()); ok {
		userID = authedUser.ID
	}

	comments, err := h.exports.SelectCommentsByExportID(r.Context(), r.PathValue("id"), userID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	out := make([]commentResponse, 0, len(comments))
	for _, comment := range comments {
		out = append(out, toCommentResponse(comment))
	}
	httpjson.OK(w, out)
}

// createCommentRequest ports ChatExportCommentCreateSchema's caller-supplied
// half (export/[id]/comments/route.ts:42) -- exportId comes from the path
// and authorId from the session, so neither is read from the body.
type createCommentRequest struct {
	ParentID *string         `json:"parentId"`
	Content  json.RawMessage `json:"content"`
}

// CreateComment ports export/[id]/comments/route.ts's POST.
func (h *Handler) CreateComment(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req createCommentRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if len(req.Content) == 0 {
		httpjson.BadRequest(w, "content is required")
		return
	}

	exportID := r.PathValue("id")
	// Not in the TS route, which inserts straight into a FK column and
	// surfaces the driver's constraint error as a 500. Checking first turns
	// "comment on an export that doesn't exist" into a clean 404 -- and on
	// SQLite the FK is only enforced at all because internal/db.Open sets
	// PRAGMA foreign_keys, so relying on it alone would be fragile.
	export, err := h.exports.SelectByID(r.Context(), exportID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if export == nil {
		httpjson.NotFound(w, "Export not found")
		return
	}

	comment := &models.ChatExportComment{
		ExportID: exportID,
		AuthorID: authedUser.ID,
		ParentID: req.ParentID,
		Content:  datatypes.JSON(req.Content),
	}
	if err := h.exports.InsertComment(r.Context(), comment); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}

// DeleteComment ports export/[id]/comments/[commentId]/route.ts's DELETE:
// author-only.
func (h *Handler) DeleteComment(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	commentID := r.PathValue("commentId")
	hasAccess, err := h.exports.CheckCommentAccess(r.Context(), commentID, authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if !hasAccess {
		httpjson.Forbidden(w)
		return
	}

	if err := h.exports.DeleteComment(r.Context(), commentID, authedUser.ID); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}
