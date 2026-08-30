// Package githubapi exposes the GitHub-token entry
// (docs/coding-agent-parity/04-git-remote-operations.md) over HTTP: is a
// token connected, connect one, disconnect it. Presence/status only, never
// the token itself in a response -- the same rule internal/api/ai's
// provider routes follow for provider keys, extended here to a different
// KeyStore entry with a different blast radius (write access to the user's
// repositories, not model spend).
package githubapi

import (
	"context"
	"net/http"
	"strings"

	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/secrets"
)

type Handler struct {
	store secrets.KeyStore
}

func NewHandler(store secrets.KeyStore) *Handler {
	return &Handler{store: store}
}

type statusResponse struct {
	Connected bool `json:"connected"`
}

// Status reports whether a GitHub token is currently stored -- never the
// token itself.
func (h *Handler) Status(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}
	if h.store == nil {
		httpjson.OK(w, statusResponse{Connected: false})
		return
	}
	_, ok, err := h.store.Get(r.Context(), secrets.GitHubTokenKey)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.OK(w, statusResponse{Connected: ok})
}

type connectRequest struct {
	Token string `json:"token"`
}

// Connect stores a personal access token. Overwrites whatever was stored
// before -- there is only ever one GitHub connection per install, the same
// as the desktop app's own account-level connections.
func (h *Handler) Connect(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}
	if h.store == nil {
		httpjson.ServerError(w, nil)
		return
	}

	var req connectRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	req.Token = strings.TrimSpace(req.Token)
	if req.Token == "" {
		httpjson.BadRequest(w, "token is required")
		return
	}

	if err := h.store.Set(r.Context(), secrets.GitHubTokenKey, req.Token); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.OK(w, statusResponse{Connected: true})
}

// Disconnect removes the stored token, if any.
func (h *Handler) Disconnect(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}
	if h.store == nil {
		httpjson.Success(w)
		return
	}
	if err := h.store.Delete(r.Context(), secrets.GitHubTokenKey); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}

// TokenLookup adapts store into tools.Deps.GitHubToken's shape -- a plain
// func rather than the store itself, so internal/ai/tools never imports
// internal/secrets. Exported so appwiring can hand it straight to
// chatapi.Handler.WithGitHub without repeating the closure at every call
// site (there is only one today, but the shape belongs here next to the
// store it closes over).
func TokenLookup(store secrets.KeyStore) func(ctx context.Context) (string, bool, error) {
	return func(ctx context.Context) (string, bool, error) {
		if store == nil {
			return "", false, nil
		}
		return store.Get(ctx, secrets.GitHubTokenKey)
	}
}
