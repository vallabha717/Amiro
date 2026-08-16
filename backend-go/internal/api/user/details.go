package user

import (
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
)

// Details ports user/details/route.ts's GET: the caller's own record.
func (h *Handler) Details(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}
	h.writeUser(w, r, authedUser.ID)
}

// Stats returns the caller's own usage statistics for the requested date range.
func (h *Handler) Stats(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	opts := parseStatsQueryOptions(r)
	stats, err := h.users.GetUserStats(r.Context(), authedUser.ID, opts)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.OK(w, stats)
}

func parseStatsQueryOptions(r *http.Request) repository.UserStatsOptions {
	q := r.URL.Query()
	var opts repository.UserStatsOptions

	if daysStr := q.Get("days"); daysStr != "" {
		if d, err := strconv.Atoi(daysStr); err == nil && d >= 0 {
			opts.Days = &d
		}
	}

	if fromStr := q.Get("from"); fromStr != "" {
		if t, err := time.Parse(time.RFC3339, fromStr); err == nil {
			opts.From = &t
		} else if t, err := time.Parse("2006-01-02", fromStr); err == nil {
			opts.From = &t
		}
	}

	if toStr := q.Get("to"); toStr != "" {
		if t, err := time.Parse(time.RFC3339, toStr); err == nil {
			opts.To = &t
		} else if t, err := time.Parse("2006-01-02", toStr); err == nil {
			endOfDay := time.Date(t.Year(), t.Month(), t.Day(), 23, 59, 59, 999999999, t.Location())
			opts.To = &endOfDay
		}
	}

	return opts
}

// DetailsByID ports user/details/[id]/route.ts's GET, gated by
// canManageUser: you may read your own record, an admin may read anyone's.
func (h *Handler) DetailsByID(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}
	id := r.PathValue("id")
	if !canManageUser(authedUser, id) {
		httpjson.Forbidden(w)
		return
	}
	h.writeUser(w, r, id)
}

// canManageUser ports canManageUser (lib/auth/permissions.ts): self, or an
// admin. Unlike the create/edit tiers this backend drops (see
// internal/api/agent's package doc), this one ports cleanly -- it only
// distinguishes "admin" from everyone else, which is exactly the two-value
// role model Phase 2's auth service assigns.
func canManageUser(authedUser *models.User, targetID string) bool {
	return authedUser.ID == targetID || authedUser.Role == "admin"
}

// updateDetailsRequest is deliberately narrower than the TS
// UpdateUserDetailsSchema: this endpoint only ever edits the caller's own
// record (there's no admin-edits-someone-else path wired to it, unlike
// DetailsByID's GET), so there's no userId field to trust from the body.
type updateDetailsRequest struct {
	Name  *string `json:"name"`
	Email *string `json:"email"`
	Image *string `json:"image"`
}

const (
	maxNameLength  = 100
	maxImageLength = 2048 // a URL from /api/storage/upload-url, not raw image bytes
)

// UpdateDetails ports the self-service half of user/actions.ts's
// updateUserDetailsAction/updateUserImageAction: the caller's own name,
// email, and avatar image. Email is guarded against being changed on the
// desktop auto-provisioned local account -- EnsureDesktopDefaultUser
// (service.go) finds that account by its fixed, well-known email on every
// sidecar restart, so silently letting it change here would orphan the
// account (and everything owned by it) on the next launch.
func (h *Handler) UpdateDetails(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req updateDetailsRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}

	var name, email, image *string

	if req.Name != nil {
		trimmed := strings.TrimSpace(*req.Name)
		if trimmed == "" {
			httpjson.BadRequest(w, "Name cannot be empty")
			return
		}
		if len(trimmed) > maxNameLength {
			httpjson.BadRequest(w, "Name is too long")
			return
		}
		name = &trimmed
	}

	if req.Image != nil {
		trimmed := strings.TrimSpace(*req.Image)
		if trimmed != "" {
			if len(trimmed) > maxImageLength {
				httpjson.BadRequest(w, "Image URL is too long")
				return
			}
			if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") {
				httpjson.BadRequest(w, "Image must be a valid URL")
				return
			}
		}
		image = &trimmed
	}

	if req.Email != nil {
		normalized := strings.ToLower(strings.TrimSpace(*req.Email))
		if normalized != strings.ToLower(authedUser.Email) {
			if authedUser.Email == auth.DesktopDefaultUserEmail {
				httpjson.BadRequest(w, "Email cannot be changed for the local desktop account")
				return
			}
			if _, err := mail.ParseAddress(normalized); err != nil {
				httpjson.BadRequest(w, "Invalid email address")
				return
			}
			exists, err := h.users.ExistsByEmail(r.Context(), normalized)
			if err != nil {
				httpjson.ServerError(w, err)
				return
			}
			if exists {
				httpjson.BadRequest(w, "Email is already in use")
				return
			}
			email = &normalized
		}
	}

	if name == nil && email == nil && image == nil {
		h.writeUser(w, r, authedUser.ID)
		return
	}

	if _, err := h.users.UpdateDetails(r.Context(), authedUser.ID, name, email, image); err != nil {
		httpjson.ServerError(w, err)
		return
	}
	h.writeUser(w, r, authedUser.ID)
}

// AuthMethods exposes UserRepository.GetAuthMethods over HTTP -- the
// caller's own hasPassword/oauthProviders, which the user-settings
// password form needs to know whether to ask for a current password.
func (h *Handler) AuthMethods(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}
	methods, err := h.users.GetAuthMethods(r.Context(), authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.OK(w, map[string]any{
		"hasPassword":    methods.HasPassword,
		"oauthProviders": methods.OAuthProviders,
	})
}

func (h *Handler) writeUser(w http.ResponseWriter, r *http.Request, userID string) {
	found, err := h.users.GetByID(r.Context(), userID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if found == nil {
		// `return NextResponse.json(user ?? {})` (user/details/route.ts:13)
		// -- a missing user is an empty object, not a 404.
		httpjson.OK(w, map[string]any{})
		return
	}
	httpjson.OK(w, toUserResponse(*found))
}
