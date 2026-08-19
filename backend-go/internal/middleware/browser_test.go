package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const testToken = "0123456789abcdef0123456789abcdef"

func browserGuard(origins ...string) func(http.Handler) http.Handler {
	return RequireTokenOrBrowser(testToken, origins)
}

// call drives one request through the guard and reports whether it reached
// the handler.
func call(t *testing.T, guard func(http.Handler) http.Handler, method, path string, headers map[string]string) (reached bool, status int) {
	t.Helper()
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	})
	req := httptest.NewRequest(method, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	guard(next).ServeHTTP(rec, req)
	return reached, rec.Code
}

// TestRequireTokenOrBrowser_StillAcceptsTheSharedSecret is the
// compatibility floor: serve mode relaxes the header requirement for
// browsers, it does not remove the header path every existing client
// (the TUI attaching, `amiro --connect`, the Tauri webview) depends on.
func TestRequireTokenOrBrowser_StillAcceptsTheSharedSecret(t *testing.T) {
	for _, header := range []string{AuthHeader, LegacyAuthHeader} {
		reached, status := call(t, browserGuard(), http.MethodPost, "/api/thread", map[string]string{
			header: testToken,
			// Deliberately the worst-case origin signal: a valid token
			// must pass regardless of what a browser would have said.
			fetchSiteHeader: "cross-site",
			"Origin":        "http://evil.example",
		})
		if !reached {
			t.Errorf("%s: valid shared secret was rejected (status %d)", header, status)
		}
	}
}

func TestRequireTokenOrBrowser_RejectsAWrongSecretFromAForeignOrigin(t *testing.T) {
	reached, status := call(t, browserGuard(), http.MethodPost, "/api/thread", map[string]string{
		AuthHeader:      "wrong-token-entirely-but-same-length!",
		fetchSiteHeader: "cross-site",
		"Origin":        "http://evil.example",
	})
	if reached {
		t.Fatal("a cross-site request with a wrong secret reached the handler")
	}
	if status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", status, http.StatusUnauthorized)
	}
}

// TestRequireTokenOrBrowser_AcceptsTheDashboardItJustServed is the point of
// the whole middleware: the page this server delivered calls the API on the
// same origin, carrying no secret, because there was no private channel to
// give it one over.
func TestRequireTokenOrBrowser_AcceptsTheDashboardItJustServed(t *testing.T) {
	for _, site := range []string{"same-origin", "none"} {
		reached, status := call(t, browserGuard(), http.MethodPost, "/api/chat", map[string]string{
			fetchSiteHeader: site,
			"Origin":        "http://192.168.1.5:8080",
		})
		if !reached {
			t.Errorf("Sec-Fetch-Site: %s was rejected (status %d)", site, status)
		}
	}
}

// TestRequireTokenOrBrowser_RefusesCrossSiteBrowserRequests is the CSRF
// case, and the reason Sec-Fetch-Site is used rather than Origin alone: it
// is on the browser's forbidden-header list, so a malicious page cannot
// claim to be same-origin. A page on evil.example must not be able to
// drive this API just because the victim's browser can reach it.
func TestRequireTokenOrBrowser_RefusesCrossSiteBrowserRequests(t *testing.T) {
	for _, site := range []string{"cross-site", "same-site"} {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
			reached, status := call(t, browserGuard(), method, "/api/thread", map[string]string{
				fetchSiteHeader: site,
				"Origin":        "http://evil.example",
			})
			if reached {
				t.Errorf("%s with Sec-Fetch-Site: %s reached the handler", method, site)
			}
			if status != http.StatusUnauthorized {
				t.Errorf("%s with Sec-Fetch-Site: %s status = %d, want %d", method, site, status, http.StatusUnauthorized)
			}
		}
	}
}

func TestRequireTokenOrBrowser_AcceptsAnExplicitlyAllowedCrossSiteOrigin(t *testing.T) {
	guard := browserGuard("https://amiro.example")

	reached, _ := call(t, guard, http.MethodPost, "/api/thread", map[string]string{
		fetchSiteHeader: "cross-site",
		"Origin":        "https://amiro.example",
	})
	if !reached {
		t.Fatal("an origin named by --allow-origin was rejected")
	}

	reached, _ = call(t, guard, http.MethodPost, "/api/thread", map[string]string{
		fetchSiteHeader: "cross-site",
		"Origin":        "https://amiro.example.evil.com",
	})
	if reached {
		t.Fatal("origin matching must be exact, not a prefix -- a lookalike host was accepted")
	}
}

// TestRequireTokenOrBrowser_JudgesAForeignOriginWithoutSecFetchSite covers
// a browser too old to send Sec-Fetch-Site. Origin is still attached to
// every cross-origin request, so the cross-site case is still caught.
func TestRequireTokenOrBrowser_JudgesAForeignOriginWithoutSecFetchSite(t *testing.T) {
	reached, _ := call(t, browserGuard(), http.MethodPost, "/api/thread", map[string]string{
		"Origin": "http://evil.example",
	})
	if reached {
		t.Fatal("a foreign Origin with no Sec-Fetch-Site reached the handler")
	}
}

// TestRequireTokenOrBrowser_AllowsNonBrowserClientsThroughToTheSessionCheck
// is the deliberate part of serve mode. curl and scripts send no origin
// signal at all; refusing them would mean a dashboard reachable over the
// network whose API only its own JavaScript could use. What actually
// protects those routes is auth.RequireSession, which this guard sits in
// front of and does not replace.
func TestRequireTokenOrBrowser_AllowsNonBrowserClientsThroughToTheSessionCheck(t *testing.T) {
	reached, _ := call(t, browserGuard(), http.MethodGet, "/api/thread", nil)
	if !reached {
		t.Fatal("a request with no origin signal was rejected before the session check could run")
	}
}

func TestRequireTokenOrBrowser_PassesPreflightAndExemptPrefixes(t *testing.T) {
	guard := RequireTokenOrBrowser(testToken, nil, "/storage/")

	reached, _ := call(t, guard, http.MethodOptions, "/api/thread", map[string]string{
		fetchSiteHeader: "cross-site",
		"Origin":        "http://evil.example",
	})
	if !reached {
		t.Error("preflight must reach CORS rather than being refused here -- same rule as RequireToken")
	}

	// A presigned /storage/ URL is pasted into an <img src>, which cannot
	// carry a header; the HMAC in the path is its proof instead.
	reached, _ = call(t, guard, http.MethodGet, "/storage/signed-token", map[string]string{
		fetchSiteHeader: "cross-site",
		"Origin":        "http://evil.example",
	})
	if !reached {
		t.Error("an exempt prefix was refused")
	}
}
