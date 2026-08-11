// Package middleware holds the two guards every request must pass before
// reaching a handler: the shared-secret auth check and the loopback-only
// CORS policy. See docs/desktop-rewrite-go-rust-plan.md §1 "Security
// hardening this pattern requires — do not skip".
package middleware

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

const AuthHeader = "X-BetterChatbot-Token"

// RequireToken rejects any request whose X-BetterChatbot-Token header does
// not match the per-launch shared secret. Constant-time compare so response
// timing can't be used to brute-force the token.
//
// exemptPrefixes lists URL path prefixes that carry their own proof of
// authorization instead of the shared-secret header. Exactly one family
// needs this: internal/storage's presigned "/storage/<signed token>" URLs
// (plan section 3), which exist to be pasted into an <img src> or a
// download link -- and a browser resource load cannot attach a custom
// request header, so requiring one there would make presigned URLs
// unusable for the only thing they're for. Those requests are gated by the
// HMAC token in the path itself, which is expiring, key-scoped, and
// verified with the same constant-time compare. Keep this list to paths
// that genuinely cannot send a header.
func RequireToken(token string, exemptPrefixes ...string) func(http.Handler) http.Handler {
	expected := []byte(token)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Preflight requests never carry the custom header; let CORS
			// middleware answer them before auth is checked.
			if r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}

			for _, prefix := range exemptPrefixes {
				if strings.HasPrefix(r.URL.Path, prefix) {
					next.ServeHTTP(w, r)
					return
				}
			}

			got := []byte(r.Header.Get(AuthHeader))
			if len(got) != len(expected) || subtle.ConstantTimeCompare(got, expected) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
