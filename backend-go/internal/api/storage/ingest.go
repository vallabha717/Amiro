package storage

import (
	"io"
	"net/http"
	"regexp"
	"strings"

	"betterchatbot/backend/internal/ai/ingest"
	"betterchatbot/backend/internal/api/httpjson"
	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/storage"
)

// ingestRequest ports storage/ingest/route.ts's Body type (route.ts:6).
type ingestRequest struct {
	Key     string `json:"key"`
	URL     string `json:"url"`
	Type    string `json:"type"`
	MaxRows int    `json:"maxRows"`
	MaxCols int    `json:"maxCols"`
}

// csvContentTypeInURL ports the query-string sniff at ingest/route.ts:35.
var csvContentTypeInURL = regexp.MustCompile(`(?i)(^|[?&])contentType=text/csv(&|$)`)

// maxIngestBytes caps how much of a stored object ingest will read. The TS
// route downloads the whole object into memory unbounded; a preview only
// ever reads the first rows, and this process is a desktop sidecar sharing
// the user's RAM, so a truncating read is the better default. 16 MiB is
// far past any CSV whose first 50 rows matter.
const maxIngestBytes = 16 << 20

// Ingest ports storage/ingest/route.ts's POST: turn a stored CSV into a
// bounded preview plus the markdown text the chat model reads.
//
// One deliberate deviation: this requires a session. The TS route has no
// auth check at all, which means any caller can read any storage key it
// can name -- reachable in that app from the open internet. Here the
// sidecar is already loopback- and token-gated, so the exposure is far
// smaller, but adding the session check costs nothing and the frontend
// only ever calls this from a signed-in context anyway.
func (h *Handler) Ingest(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req ingestRequest
	if !httpjson.Decode(w, r, &req) {
		// The TS route answers a bad body with `{"error": "Invalid JSON"}`;
		// httpjson.Decode's message differs only in wording.
		return
	}

	key := req.Key
	if key == "" && req.URL != "" {
		if resolved, ok := storage.KeyFromURL(h.store, req.URL); ok {
			key = resolved
		}
	}
	if key == "" {
		httpjson.BadRequest(w, "Missing 'key' or 'url'")
		return
	}

	// Type inference from ingest/route.ts:31-35.
	isCSV := req.Type == "csv" ||
		strings.HasSuffix(strings.ToLower(key), ".csv") ||
		csvContentTypeInURL.MatchString(req.URL)
	if !isCSV {
		httpjson.Write(w, http.StatusBadRequest, map[string]string{
			"error":    "Unsupported file type for ingest",
			"solution": "Currently supported: CSV. Convert your spreadsheet to CSV or paste sample rows.",
		})
		return
	}

	reader, err := h.store.Get(r.Context(), key)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	defer reader.Close()

	content, err := io.ReadAll(io.LimitReader(reader, maxIngestBytes))
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	// clamp(1, 200) / clamp(1, 40) around the defaults (route.ts:50-51).
	preview := ingest.ParseCsvPreview(content, ingest.Options{
		MaxRows: clamp(req.MaxRows, 50, 1, 200),
		MaxCols: clamp(req.MaxCols, 12, 1, 40),
	})

	httpjson.OK(w, map[string]any{
		"ok":      true,
		"type":    "csv",
		"key":     key,
		"preview": preview,
		"text":    ingest.FormatCsvPreviewText(key, preview),
	})
}

func clamp(value, fallback, min, max int) int {
	if value == 0 {
		value = fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
