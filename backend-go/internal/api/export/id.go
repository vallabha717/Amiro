package export

import (
	"encoding/json"
	"net/http"
	"time"

	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
)

// Get reads one export. See the package doc comment for why this endpoint
// exists without a route.ts counterpart.
//
// Deliberately unauthenticated, matching what it replaces: the TS
// /export/[id] page is a public share link -- anyone holding the id can
// read it -- which is also why the comments GET below takes an optional
// session rather than requiring one.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	export, err := h.exports.SelectByIDWithUser(r.Context(), r.PathValue("id"))
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if export == nil {
		httpjson.NotFound(w, "Export not found")
		return
	}

	expired := export.ChatExport.ExpiresAt != nil && export.ChatExport.ExpiresAt.Before(time.Now())
	out := exportResponse{
		ID:               export.ChatExport.ID,
		Title:            export.ChatExport.Title,
		ExporterID:       export.ChatExport.ExporterID,
		OriginalThreadID: export.ChatExport.OriginalThreadID,
		ExportedAt:       export.ChatExport.ExportedAt,
		ExpiresAt:        export.ChatExport.ExpiresAt,
		ExporterName:     export.ExporterName,
		ExporterImage:    export.ExporterImage,
		IsExpired:        expired,
	}
	// An expired export's messages are withheld rather than served with a
	// flag beside them: the expiry only means anything if the content
	// actually stops being readable.
	if expired {
		out.Messages = json.RawMessage("[]")
	} else {
		out.Messages = json.RawMessage(export.ChatExport.Messages)
	}
	httpjson.OK(w, out)
}

// Delete ports export/[id]/route.ts's DELETE: exporter-only.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	id := r.PathValue("id")
	hasAccess, err := h.exports.CheckAccess(r.Context(), id, authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if !hasAccess {
		httpjson.Forbidden(w)
		return
	}

	if err := h.exports.DeleteByID(r.Context(), id); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}
