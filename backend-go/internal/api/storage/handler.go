// Package storage ports src/app/api/storage/**: the upload-url -> PUT
// flow, the multipart server-side upload fallback, and CSV ingest -- plus
// the /storage/{token} endpoint that actually serves what LocalStorage's
// presigned URLs point at (plan section 3), which Phase 2 built the token
// half of and left the handler to this phase.
//
// The frontend's request/response shapes are unchanged from the TS routes,
// per plan section 3's requirement that "the frontend's existing
// upload-url -> PUT -> done flow keeps the exact same request/response
// shape it has today -- only the interface implementation selected at
// startup changes".
//
// Not ported: the Vercel Blob branch of upload-url/route.ts
// (handleVercelBlobUpload, the `blob.generate-client-token` body shape).
// Vercel Blob is a hosting-platform-specific service with no place in
// either deploy target this rewrite has -- a local desktop sidecar or a
// self-hosted web deploy -- and plan section 3's storage row replaces it
// outright with the local/S3 pair. A client sending that body shape gets
// the ordinary presigned-URL response instead.
package storage

import (
	"net/http"
	"time"

	"amiro/backend/internal/storage"
)

// uploadExpiry ports DEFAULT_UPLOAD_EXPIRES_SECONDS (upload-url/route.ts:14).
const uploadExpiry = time.Hour

// maxUploadMemory bounds how much of a multipart upload is buffered in RAM
// before net/http spills the rest to a temp file. Not a size limit on the
// upload itself -- the TS route has none either.
const maxUploadMemory = 32 << 20 // 32 MiB

type Handler struct {
	store storage.Storage
}

func NewHandler(store storage.Storage) *Handler {
	return &Handler{store: store}
}

// sourceURL resolves the durable URL a stored key is referenced by. Both
// backends implement storage.SourceURLProvider; the fallback exists so a
// test double implementing only storage.Storage still works.
func (h *Handler) sourceURL(r *http.Request, key string) (string, error) {
	if provider, ok := h.store.(storage.SourceURLProvider); ok {
		return provider.SourceURL(r.Context(), key)
	}
	return h.store.PresignGetURL(r.Context(), key, storage.SourceURLTTL)
}
