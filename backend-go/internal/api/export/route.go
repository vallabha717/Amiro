package export

import (
	"net/http"

	"betterchatbot/backend/internal/api/httpjson"
	"betterchatbot/backend/internal/auth"
)

// List ports export/route.ts's GET: every export the caller made.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	rows, err := h.exports.SelectSummaryByExporterID(r.Context(), authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	out := make([]summaryResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, summaryResponse{
			ID:               row.ChatExport.ID,
			Title:            row.ChatExport.Title,
			ExporterID:       row.ChatExport.ExporterID,
			OriginalThreadID: row.ChatExport.OriginalThreadID,
			CommentCount:     row.CommentCount,
			ExportedAt:       row.ChatExport.ExportedAt,
			ExpiresAt:        row.ChatExport.ExpiresAt,
		})
	}
	httpjson.OK(w, out)
}
