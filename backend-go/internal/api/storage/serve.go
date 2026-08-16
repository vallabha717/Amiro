package storage

import (
	"errors"
	"io"
	"net/http"
	"os"
	"strings"

	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/storage"
)

// tokenResolver is what a backend must implement for the /storage/{token}
// routes to mean anything: only LocalStorage issues URLs this server has
// to serve itself. A web deploy's presigned URLs point straight at S3, so
// these routes are simply not registered there (httpserver.New checks).
type tokenResolver interface {
	ValidateSignedToken(token string) (string, storage.Operation, error)
}

// TokenResolver reports whether the configured backend serves its own
// presigned URLs, i.e. whether Serve/ReceiveUpload should be routed.
func (h *Handler) TokenResolver() bool {
	_, ok := h.store.(tokenResolver)
	return ok
}

func (h *Handler) resolveToken(w http.ResponseWriter, r *http.Request, want storage.Operation) (string, bool) {
	resolver, ok := h.store.(tokenResolver)
	if !ok {
		httpjson.NotFound(w, "Not found")
		return "", false
	}

	key, op, err := resolver.ValidateSignedToken(r.PathValue("token"))
	if err != nil {
		if errors.Is(err, storage.ErrTokenExpired) {
			httpjson.Error(w, http.StatusGone, "Link expired")
			return "", false
		}
		httpjson.Forbidden(w)
		return "", false
	}
	// An upload slot must not double as a read grant, or vice versa --
	// the same split S3's PresignPutObject/PresignGetObject draws.
	if op != want {
		httpjson.Forbidden(w)
		return "", false
	}
	return key, true
}

// Serve answers GET /storage/{token}: the read half of LocalStorage's
// presigned URLs. Deliberately outside /api and exempt from the
// shared-secret header (see middleware.RequireToken's exemptPrefixes doc)
// -- an <img src> can't send headers, and the signed token in the path is
// what authorizes the read.
func (h *Handler) Serve(w http.ResponseWriter, r *http.Request) {
	key, ok := h.resolveToken(w, r, storage.OperationGet)
	if !ok {
		return
	}

	reader, err := h.store.Get(r.Context(), key)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			httpjson.NotFound(w, "Not found")
			return
		}
		httpjson.ServerError(w, err)
		return
	}
	defer reader.Close()

	// No content type is stored alongside the object (the Storage
	// interface has no metadata concept), so it's inferred from the key's
	// extension -- which BuildKey always preserves from the original
	// filename. Unknown extensions fall back to application/octet-stream,
	// which browsers download rather than render.
	w.Header().Set("Content-Type", storage.ContentTypeFromFilename(key))
	w.Header().Set("Content-Disposition", "inline; filename=\""+storage.SanitizeFilename(key)+"\"")
	// Presigned reads are immutable for their lifetime: the key embeds a
	// UUID, so a given key's bytes never change.
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if _, err := io.Copy(w, reader); err != nil && !isClientDisconnect(err) {
		// Headers are already sent; nothing useful left to report to the
		// client, and the copy failing mid-body is almost always the
		// webview navigating away.
		return
	}
}

// ReceiveUpload answers PUT /storage/{token}: the write half of
// LocalStorage's presigned URLs, i.e. what a client PUTs to after calling
// /api/storage/upload-url. Same header exemption and same reasoning as
// Serve -- the token is the authorization.
func (h *Handler) ReceiveUpload(w http.ResponseWriter, r *http.Request) {
	key, ok := h.resolveToken(w, r, storage.OperationUpload)
	if !ok {
		return
	}

	defer r.Body.Close()
	if err := h.store.Put(r.Context(), key, r.Body); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}

func isClientDisconnect(err error) bool {
	return errors.Is(err, io.ErrClosedPipe) ||
		strings.Contains(err.Error(), "broken pipe") ||
		strings.Contains(err.Error(), "connection reset")
}
