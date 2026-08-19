package middleware

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// fetchSiteHeader is sent by every current browser and cannot be set from
// JavaScript -- it is on the forbidden-header list, so a page cannot lie
// about it. That property is what makes it usable as a CSRF signal, which
// an Origin check alone is not: Origin is absent on same-origin GETs,
// making "no Origin" ambiguous between a same-origin fetch and a
// non-browser client.
const fetchSiteHeader = "Sec-Fetch-Site"

// RequireTokenOrBrowser is RequireToken's counterpart for `amiro serve`,
// where the dashboard is served from the same origin as the API.
//
// The shared secret exists to stop a "localhost drive-by" -- some other
// page in the user's browser calling the sidecar's loopback API. In the
// desktop app that works because only the Tauri webview is ever told the
// secret (src-tauri/src/lib.rs injects it). A served dashboard has no such
// channel: whatever the page needs to authenticate itself is, by
// definition, handed to every browser that loads the page, so shipping the
// secret to it would not be a second factor, only a longer URL.
//
// So in serve mode the secret keeps its meaning for programmatic clients
// (`amiro --connect`, the TUI attaching to a running server) and the
// browser proves itself structurally instead:
//
//   - a matching secret header always passes -- unchanged for every
//     existing client;
//   - a same-origin browser request passes, and is by construction the
//     dashboard this very server just served;
//   - a cross-site browser request passes only from an origin the operator
//     named with --allow-origin;
//   - anything else state-changing is refused.
//
// Authorization proper is still auth.RequireSession's job on every route
// that has one. What this guard removes is the header requirement, not the
// login.
func RequireTokenOrBrowser(token string, allowedOrigins []string, exemptPrefixes ...string) func(http.Handler) http.Handler {
	expected := []byte(token)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Preflights carry no custom headers by design; CORS answers
			// them before anything here can judge them. Same rule as
			// RequireToken.
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

			if hasValidToken(r, expected) {
				next.ServeHTTP(w, r)
				return
			}

			if allowedAsBrowserRequest(r, allowedOrigins) {
				next.ServeHTTP(w, r)
				return
			}

			http.Error(w, "unauthorized", http.StatusUnauthorized)
		})
	}
}

func hasValidToken(r *http.Request, expected []byte) bool {
	got := []byte(r.Header.Get(AuthHeader))
	if len(got) == 0 {
		got = []byte(r.Header.Get(LegacyAuthHeader))
	}
	return len(got) == len(expected) && subtle.ConstantTimeCompare(got, expected) == 1
}

// allowedAsBrowserRequest decides whether a request with no shared secret
// is one the served dashboard could legitimately have made.
//
// The two headers are read in order of trustworthiness. Sec-Fetch-Site is
// browser-set and unforgeable, so it decides on its own when present.
// Origin is next: a browser attaches it to every cross-origin request and
// to every same-origin state-changing one, so a *foreign* Origin is proof
// of a cross-site call even without Sec-Fetch-Site.
//
// When neither header is present the request is not a browser request at
// all -- curl, a script, a native client -- and is allowed through to the
// session check. That is the deliberate part of serve mode: a dashboard
// reachable over the network is a web app, and a web app's front door is
// its login page, not a header only its own JavaScript could know.
func allowedAsBrowserRequest(r *http.Request, allowedOrigins []string) bool {
	origin := r.Header.Get("Origin")

	switch r.Header.Get(fetchSiteHeader) {
	case "same-origin", "none":
		// "none" is a user-initiated navigation -- typing the URL,
		// following a bookmark. That is how someone reaches the login page.
		return true
	case "same-site", "cross-site":
		return originAllowed(origin, allowedOrigins)
	}

	// No Sec-Fetch-Site. If the client named an origin, judge it; a
	// browser too old to send Sec-Fetch-Site still sends Origin on exactly
	// the requests that matter.
	if origin != "" {
		return originAllowed(origin, allowedOrigins)
	}

	// No origin signal of any kind: a non-browser client. Safe methods
	// reach static assets and read-only routes; anything state-changing
	// still has to satisfy auth.RequireSession on every route that has
	// one, and the routes that have none (register, login) are rate
	// limited -- see RateLimit.
	return true
}

func originAllowed(origin string, allowed []string) bool {
	if origin == "" {
		return false
	}
	for _, a := range allowed {
		if a != "" && a == origin {
			return true
		}
	}
	return false
}
