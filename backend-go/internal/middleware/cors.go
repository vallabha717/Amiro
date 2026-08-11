package middleware

import "net/http"

// LoopbackCORS allows exactly one origin — the app's own webview — never a
// wildcard. A loopback HTTP server is reachable by any local process
// including a browser tab, so an exact-origin allowlist is what actually
// stops a "localhost drive-by" page from calling this API cross-origin.
func LoopbackCORS(allowedOrigin string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && origin == allowedOrigin {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
				// Authorization carries the per-user session bearer token
				// (auth.RequireSession) -- added in Phase 7 when the
				// frontend started attaching it on every request. Found by
				// live browser testing, not curl: curl doesn't run a CORS
				// preflight at all, so this omission never showed up
				// against real requests until an actual cross-origin
				// fetch() (the webview -> sidecar shape this middleware
				// exists for) tried it.
				w.Header().Set("Access-Control-Allow-Headers", AuthHeader+", Authorization, Content-Type")
			}

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
