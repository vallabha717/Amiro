package middleware

import (
	"net/http"
	"strings"
)

func isAllowedOrigin(origin string, allowedOrigins []string, loopbackWildcard bool) bool {
	if origin == "" {
		return false
	}
	for _, allowed := range allowedOrigins {
		if allowed != "" && origin == allowed {
			return true
		}
	}
	if loopbackWildcard {
		return strings.HasPrefix(origin, "http://localhost:") || strings.HasPrefix(origin, "http://127.0.0.1:") ||
			strings.HasPrefix(origin, "https://localhost:") || strings.HasPrefix(origin, "https://127.0.0.1:")
	}
	return false
}

// LoopbackCORS allows exactly one origin — the app's own webview — never a
// wildcard. A loopback HTTP server is reachable by any local process
// including a browser tab, so an exact-origin allowlist is what actually
// stops a "localhost drive-by" page from calling this API cross-origin.
func LoopbackCORS(allowedOrigin string) func(http.Handler) http.Handler {
	return CORS([]string{allowedOrigin}, true)
}

// CORS is LoopbackCORS generalised for `amiro serve`, which needs two
// things the sidecar never did: more than one allowed origin
// (--allow-origin, repeatable), and the ability to switch the
// any-loopback-port allowance off.
//
// That switch is the point. Reflecting every http://localhost:<port>
// origin is a reasonable convenience for a sidecar that is only ever
// reachable from this machine anyway. It is the wrong default the moment
// the listener is bound past loopback, because it hands a blanket
// cross-origin pass to any page a local process happens to be serving. In
// serve mode the dashboard is same-origin with the API and needs no CORS
// allowance at all, so the list starts empty and only grows by explicit
// operator choice.
func CORS(allowedOrigins []string, loopbackWildcard bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if isAllowedOrigin(origin, allowedOrigins, loopbackWildcard) {
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
				w.Header().Set("Access-Control-Allow-Headers", AuthHeader+", "+LegacyAuthHeader+", Authorization, Content-Type")
			}

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
