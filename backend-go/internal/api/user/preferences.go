package user

import (
	"net/http"

	"betterchatbot/backend/internal/api/httpjson"
	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/user"
)

// GetPreferences ports user/preferences/route.ts's GET.
func (h *Handler) GetPreferences(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	prefs, err := h.users.GetPreferences(r.Context(), authedUser.ID)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if prefs == nil {
		// `NextResponse.json(preferences ?? {})` (route.ts:14).
		httpjson.OK(w, map[string]any{})
		return
	}
	httpjson.OK(w, prefs)
}

// UpdatePreferences ports user/preferences/route.ts's PUT. Every field of
// UserPreferencesZodSchema is optional, so an omitted one is stored as
// absent -- the whole object is replaced, matching the TS `.set({
// preferences })` rather than a per-field merge.
func (h *Handler) UpdatePreferences(w http.ResponseWriter, r *http.Request) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	var prefs user.Preferences
	if !httpjson.Decode(w, r, &prefs) {
		return
	}

	updated, err := h.users.UpdatePreferences(r.Context(), authedUser.ID, prefs)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	httpjson.OK(w, map[string]any{"success": true, "preferences": updated})
}
