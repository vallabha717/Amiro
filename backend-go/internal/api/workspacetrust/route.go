package workspacetrust

import (
	"net/http"

	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/repository"
)

// List returns every root the caller has granted, for a Settings page's
// "granted roots, with a revoke action" section.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	grants, err := h.trust.List(r.Context(), authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	resp := listResponse{Grants: make([]grantResponse, 0, len(grants))}
	for _, g := range grants {
		resp.Grants = append(resp.Grants, toGrantResponse(g))
	}
	httpjson.OK(w, resp)
}

// Status reports whether the caller has already granted ?root=, and the
// resolved form of that root -- what a first-open-of-project prompt calls
// before deciding whether to show itself.
func (h *Handler) Status(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	root := r.URL.Query().Get("root")
	if root == "" {
		httpjson.BadRequest(w, "root is required")
		return
	}
	resolved, err := resolveRoot(root)
	if err != nil {
		httpjson.BadRequest(w, "root is not a directory this server can reach: "+err.Error())
		return
	}

	trusted, err := h.trust.IsTrustedForTurn(r.Context(), authedUser.ID, resolved, h.defaultRoot)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.OK(w, statusResponse{Trusted: trusted, ResolvedRoot: resolved})
}

type grantRequest struct {
	Root string `json:"root"`
}

// Grant records the caller's consent for the request body's root -- the
// human answer to the trust prompt. granted_via is always "prompt" here;
// the "env" value is only ever written by the auto-grant at process start
// (internal/appwiring), never by a client request.
func (h *Handler) Grant(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req grantRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if req.Root == "" {
		httpjson.BadRequest(w, "root is required")
		return
	}
	resolved, err := resolveRoot(req.Root)
	if err != nil {
		httpjson.BadRequest(w, "root is not a directory this server can reach: "+err.Error())
		return
	}

	if err := h.trust.Grant(r.Context(), authedUser.ID, resolved, repository.GrantedViaPrompt); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.OK(w, statusResponse{Trusted: true, ResolvedRoot: resolved})
}

// Revoke removes the caller's grant for the request body's root, if one
// exists. Forward-only, per the design doc: a turn already in flight keeps
// the permission state it started with.
func (h *Handler) Revoke(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req grantRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if req.Root == "" {
		httpjson.BadRequest(w, "root is required")
		return
	}
	resolved, err := resolveRoot(req.Root)
	if err != nil {
		httpjson.BadRequest(w, "root is not a directory this server can reach: "+err.Error())
		return
	}

	if err := h.trust.Revoke(r.Context(), authedUser.ID, resolved); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.Success(w)
}
