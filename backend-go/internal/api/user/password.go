package user

import (
	"errors"
	"net/http"

	"betterchatbot/backend/internal/api/httpjson"
	"betterchatbot/backend/internal/auth"
)

const minPasswordLength = 8

type updatePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

// UpdatePassword ports the credential half of user-update-password-dialog's
// action: set or change the caller's own password. auth.Service.SetPassword
// enforces the actual "must supply the current one if a password already
// exists" rule; this handler is just request validation + status mapping.
func (h *Handler) UpdatePassword(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req updatePasswordRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}

	if len(req.NewPassword) < minPasswordLength {
		httpjson.BadRequest(w, "New password must be at least 8 characters")
		return
	}

	err := h.auth.SetPassword(r.Context(), authedUser.ID, req.CurrentPassword, req.NewPassword)
	switch {
	case err == nil:
		httpjson.Success(w)
	case errors.Is(err, auth.ErrCurrentPasswordRequired):
		httpjson.BadRequest(w, "Current password is required")
	case errors.Is(err, auth.ErrInvalidCredentials):
		httpjson.Error(w, http.StatusUnauthorized, "Current password is incorrect")
	case errors.Is(err, auth.ErrUserNotFound):
		httpjson.NotFound(w, "User not found")
	default:
		httpjson.ServerError(w, err)
	}
}
