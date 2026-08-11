package archive

import (
	"net/http"

	"betterchatbot/backend/internal/api/httpjson"
	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/db/models"
)

// List ports archive/route.ts's GET.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	rows, err := h.archives.GetByUserID(r.Context(), authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	out := make([]archiveWithCountResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, archiveWithCountResponse{
			archiveResponse: toArchiveResponse(row.Archive),
			ItemCount:       row.ItemCount,
		})
	}
	httpjson.OK(w, out)
}

// Create ports archive/route.ts's POST.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req writeRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if msg, ok := req.validate(true); !ok {
		httpjson.BadRequest(w, msg)
		return
	}

	// `description: data.description || null` (archive/route.ts:37) --
	// an empty string is stored as NULL, not "".
	archive := &models.Archive{Name: req.Name, UserID: authedUser.ID}
	if req.Description != nil && *req.Description != "" {
		archive.Description = req.Description
	}

	if err := h.archives.Create(r.Context(), archive); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.OK(w, toArchiveResponse(*archive))
}
