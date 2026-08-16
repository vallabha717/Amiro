package auth

import (
	"context"
	"net/http"
	"strings"

	"amiro/backend/internal/db/models"
)

type contextKey int

const userContextKey contextKey = iota

// UserFromContext returns the authenticated user a previous RequireSession
// call stored on the request context, if any.
func UserFromContext(ctx context.Context) (*models.User, bool) {
	user, ok := ctx.Value(userContextKey).(*models.User)
	return user, ok
}

// RequireSession rejects any request without a valid "Authorization:
// Bearer <session token>" header and stores the resolved user on the
// request context for downstream handlers. This is a second, user-level
// gate layered on top of middleware.RequireToken's sidecar-level shared
// secret -- RequireToken proves the request came from this app's own
// webview, RequireSession proves which logged-in user it's acting as.
func RequireSession(service *Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}

			token, ok := BearerToken(r)
			if !ok {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}

			user, _, err := service.ValidateSession(r.Context(), token)
			if err != nil {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), userContextKey, user)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// BearerToken extracts the session token from a request's
// "Authorization: Bearer <token>" header, shared by RequireSession and by
// internal/api/auth's login/logout handlers so both agree on one parsing
// rule.
func BearerToken(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return "", false
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	if token == "" {
		return "", false
	}
	return token, true
}

// OptionalSession resolves a session token when one is present and valid,
// storing the user on the request context exactly like RequireSession --
// but never rejects the request when it's absent or invalid.
//
// Ports the `getUserId().catch(() => undefined)` pattern the public
// export-comments GET uses (export/[id]/comments/route.ts:13): the comment
// list is readable by anyone holding the export link, and knowing who is
// asking only adds the per-comment isOwner flag. Handlers behind this
// middleware must treat UserFromContext's second return value as
// meaningful, not assume a user is always there.
func OptionalSession(service *Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := BearerToken(r)
			if !ok {
				next.ServeHTTP(w, r)
				return
			}
			user, _, err := service.ValidateSession(r.Context(), token)
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userContextKey, user)))
		})
	}
}
