package httpserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"amiro/backend/internal/middleware"
)

// stubUI stands in for internal/web.Handler. The router's job is deciding
// *what reaches the dashboard*, not how the dashboard resolves a path --
// that is internal/web's own test's job, and coupling the two would make
// this file fail for reasons that have nothing to do with routing.
func stubUI() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("DASHBOARD " + r.URL.Path))
	})
}

func serveModeHandler() http.Handler {
	return NewWithOptions(testConfig(), Handlers{}, Options{
		UI:          stubUI(),
		BrowserAuth: true,
	})
}

func browserGet(h http.Handler, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	// What a browser sends when someone types the URL or follows a link
	// within the app.
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestServeMode_UnmatchedPathsReachTheDashboard is the SPA-fallback wiring:
// the UI is registered on the bare "/" pattern, which ServeMux reaches only
// after every method+path API pattern has failed to match.
func TestServeMode_UnmatchedPathsReachTheDashboard(t *testing.T) {
	h := serveModeHandler()

	for _, path := range []string{"/", "/admin", "/agents", "/sign-in", "/_next/static/chunk.js", "/deep/link/here"} {
		rec := browserGet(h, path)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s: status = %d, want 200", path, rec.Code)
			continue
		}
		if !strings.HasPrefix(rec.Body.String(), "DASHBOARD") {
			t.Errorf("GET %s: did not reach the dashboard, body = %q", path, rec.Body.String())
		}
	}
}

// TestServeMode_UnmatchedAPIPathsAnswerAsAnAPI guards the one thing the
// catch-all could get badly wrong. "/" matches everything, so without
// apiAware a mistyped API route would hand back the SPA shell with a 200 --
// a client would parse HTML as JSON, and a person debugging would see a
// page that looks like it briefly loaded.
func TestServeMode_UnmatchedAPIPathsAnswerAsAnAPI(t *testing.T) {
	h := serveModeHandler()

	for _, path := range []string{"/api/nope", "/api/thread/typo/extra", "/storage/nope", "/health/typo"} {
		rec := browserGet(h, path)
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s: status = %d, want 404", path, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
			t.Errorf("GET %s: Content-Type = %q, want application/json", path, ct)
		}
		if strings.Contains(rec.Body.String(), "DASHBOARD") {
			t.Errorf("GET %s: an unmatched API path fell through to the dashboard", path)
		}
	}
}

// TestServeMode_RealAPIRoutesStillWin: the catch-all must lose to every
// registered route. /health is the one route New registers unconditionally,
// so it is the one that can be checked without a full handler graph.
func TestServeMode_RealAPIRoutesStillWin(t *testing.T) {
	rec := browserGet(serveModeHandler(), "/health")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != `{"status":"ok"}` {
		t.Fatalf("body = %q -- the dashboard shadowed a registered route", got)
	}
}

// TestServeMode_ServesTheDashboardWithoutASharedSecret is what makes the
// whole thing usable: the browser loading this page has never been given a
// secret, and could not be given one privately even in principle.
func TestServeMode_ServesTheDashboardWithoutASharedSecret(t *testing.T) {
	rec := browserGet(serveModeHandler(), "/sign-in")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 -- a browser cannot send the shared secret for a page it has not loaded yet", rec.Code)
	}
}

// TestServeMode_RefusesCrossSiteRequests: relaxing the header requirement
// must not open the API to any page that can reach the port.
func TestServeMode_RefusesCrossSiteRequests(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/chat", nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	req.Header.Set("Origin", "http://evil.example")
	rec := httptest.NewRecorder()
	serveModeHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

// TestSidecarMode_IsUnchanged pins the guarantee that matters most: New()
// is what cmd/server and every existing test use, and serve mode must be
// something you opt into, never a relaxation everyone silently inherits.
func TestSidecarMode_IsUnchanged(t *testing.T) {
	h := New(testConfig(), Handlers{})

	// No dashboard: an unmatched path is a plain 404 from ServeMux, not a
	// page, and certainly not a 200.
	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	req.Header.Set(middleware.AuthHeader, "test-token")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("sidecar mode GET /admin: status = %d, want 404 (it serves no UI)", rec.Code)
	}

	// And a browser claiming same-origin still gets nowhere without the
	// secret -- BrowserAuth is off.
	rec = browserGet(h, "/health")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("sidecar mode GET /health with Sec-Fetch-Site: same-origin: status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

// TestServeMode_DropsTheAnyLoopbackPortCORSAllowance: reflecting every
// http://localhost:<port> origin is a harmless convenience for a listener
// only this machine can reach. Once the listener is on a network it is a
// blanket cross-origin pass handed to whatever a local process happens to
// be serving, so serve mode turns it off.
func TestServeMode_DropsTheAnyLoopbackPortCORSAllowance(t *testing.T) {
	serve := serveModeHandler()
	sidecar := New(testConfig(), Handlers{})

	check := func(h http.Handler) string {
		req := httptest.NewRequest(http.MethodOptions, "/health", nil)
		req.Header.Set("Origin", "http://localhost:9999")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Header().Get("Access-Control-Allow-Origin")
	}

	if got := check(sidecar); got != "http://localhost:9999" {
		t.Errorf("sidecar mode: Access-Control-Allow-Origin = %q, want the loopback origin reflected (unchanged behaviour)", got)
	}
	if got := check(serve); got != "" {
		t.Errorf("serve mode: Access-Control-Allow-Origin = %q, want empty", got)
	}
}

func TestServeMode_AllowOriginIsHonouredByCORS(t *testing.T) {
	h := NewWithOptions(testConfig(), Handlers{}, Options{
		UI:             stubUI(),
		BrowserAuth:    true,
		AllowedOrigins: []string{"https://amiro.example"},
	})

	req := httptest.NewRequest(http.MethodOptions, "/health", nil)
	req.Header.Set("Origin", "https://amiro.example")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://amiro.example" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want the origin named by --allow-origin", got)
	}
}

func TestServeMode_RateLimitIsInstalledOnlyWhenAskedFor(t *testing.T) {
	limit := middleware.AuthRateLimit()
	h := NewWithOptions(testConfig(), Handlers{}, Options{
		UI:          stubUI(),
		BrowserAuth: true,
		RateLimit:   &limit,
	})

	// No Auth handler is wired, so login is not a registered route and
	// falls to apiAware's 404 -- but the limiter sits outside the mux and
	// still counts every attempt, which is exactly where it belongs: a
	// flood should be refused before any routing work happens.
	var last int
	for range limit.Burst + 5 {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
		req.RemoteAddr = "10.0.0.1:5555"
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		last = rec.Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("status after %d attempts = %d, want %d", limit.Burst+5, last, http.StatusTooManyRequests)
	}

	// Without the option, the same flood is never throttled.
	plain := serveModeHandler()
	for range limit.Burst + 5 {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
		req.RemoteAddr = "10.0.0.1:5555"
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		rec := httptest.NewRecorder()
		plain.ServeHTTP(rec, req)
		if rec.Code == http.StatusTooManyRequests {
			t.Fatal("a rate limit was applied without Options.RateLimit -- loopback binds must not pay for it")
		}
	}
}
