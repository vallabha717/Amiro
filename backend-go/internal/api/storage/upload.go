package storage

import (
	"net/http"
	"time"

	"betterchatbot/backend/internal/api/httpjson"
	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/storage"
)

// fileMetadata ports FileMetadata (file-storage.interface.ts:10).
type fileMetadata struct {
	Key         string    `json:"key"`
	Filename    string    `json:"filename"`
	ContentType string    `json:"contentType"`
	Size        int64     `json:"size"`
	UploadedAt  time.Time `json:"uploadedAt"`
}

// Upload ports storage/upload/route.ts's POST: a multipart form with one
// "file" field, uploaded through the server.
func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}

	if err := r.ParseMultipartForm(maxUploadMemory); err != nil {
		httpjson.BadRequest(w, "No file provided. Use 'file' field in FormData.")
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	file, header, err := r.FormFile("file")
	if err != nil {
		httpjson.BadRequest(w, "No file provided. Use 'file' field in FormData.")
		return
	}
	defer file.Close()

	filename := header.Filename
	if filename == "" {
		filename = "file"
	}
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		// `file.type || "application/octet-stream"` (upload/route.ts:44),
		// with an extension-based guess first -- a browser that omits the
		// part's Content-Type would otherwise make every CSV upload
		// un-ingestible, since ingest sniffs on content type or extension.
		contentType = storage.ContentTypeFromFilename(filename)
	}

	key := storage.BuildKey(filename)
	if err := h.store.Put(r.Context(), key, file); err != nil {
		httpjson.ServerError(w, err)
		return
	}

	url, err := h.sourceURL(r, key)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	httpjson.OK(w, map[string]any{
		"success": true,
		"key":     key,
		"url":     url,
		"metadata": fileMetadata{
			Key:         key,
			Filename:    storage.SanitizeFilename(filename),
			ContentType: contentType,
			Size:        header.Size,
			UploadedAt:  time.Now(),
		},
	})
}

// uploadURLRequest ports GenericUploadRequest (upload-url/route.ts:18).
type uploadURLRequest struct {
	Filename    string `json:"filename"`
	ContentType string `json:"contentType"`
}

// UploadURL ports storage/upload-url/route.ts's POST: hand the client a
// short-lived slot to PUT directly into, so a large file never passes
// through this process's memory.
func (h *Handler) UploadURL(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req uploadURLRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if req.Filename == "" {
		req.Filename = "file"
	}
	if req.ContentType == "" {
		req.ContentType = "application/octet-stream"
	}

	key := storage.BuildKey(req.Filename)
	url, err := h.store.PresignUploadURL(r.Context(), key, uploadExpiry)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	sourceURL, err := h.sourceURL(r, key)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	// The createFallbackResponse branch (upload-url/route.ts:30) is
	// unreachable here: it exists for a backend with no createUploadUrl at
	// all, and both of this rewrite's backends presign uploads natively.
	httpjson.OK(w, map[string]any{
		"directUploadSupported": true,
		"key":                   key,
		"url":                   url,
		"method":                "PUT",
		"expiresAt":             time.Now().Add(uploadExpiry),
		"headers":               map[string]string{"Content-Type": req.ContentType},
		"sourceUrl":             sourceURL,
	})
}
