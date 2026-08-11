package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLoopbackCORS_OmitsHeaderForMismatchedOrigin(t *testing.T) {
	handler := LoopbackCORS("tauri://localhost")(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "http://evil.example")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want empty (never a wildcard, never an unmatched origin)", got)
	}
}

func TestLoopbackCORS_NeverEchoesWildcard(t *testing.T) {
	handler := LoopbackCORS("tauri://localhost")(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "*")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got == "*" {
		t.Fatal("Access-Control-Allow-Origin must never be set to a wildcard")
	}
}

func TestLoopbackCORS_SetsHeaderForMatchingOrigin(t *testing.T) {
	handler := LoopbackCORS("tauri://localhost")(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "tauri://localhost")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "tauri://localhost" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, "tauri://localhost")
	}
}

func TestLoopbackCORS_RespondsNoContentToPreflightWithoutCallingNext(t *testing.T) {
	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	})
	handler := LoopbackCORS("tauri://localhost")(next)

	req := httptest.NewRequest(http.MethodOptions, "/health", nil)
	req.Header.Set("Origin", "tauri://localhost")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
	if called {
		t.Fatal("preflight OPTIONS request should be answered by CORS middleware, not passed to next")
	}
}

// TestLoopbackCORS_AllowsAuthorizationHeader guards against a real Phase 7
// regression: Access-Control-Allow-Headers only listed AuthHeader and
// Content-Type, so a real browser's preflight for any session-bearing
// request (every auth.RequireSession route, i.e. almost the whole API)
// failed CORS before the request was ever sent -- curl-based testing never
// caught it, since curl doesn't run a preflight at all. Found by driving
// the actual frontend against a real running sidecar in a real browser.
func TestLoopbackCORS_AllowsAuthorizationHeader(t *testing.T) {
	handler := LoopbackCORS("tauri://localhost")(okHandler())

	req := httptest.NewRequest(http.MethodOptions, "/api/thread", nil)
	req.Header.Set("Origin", "tauri://localhost")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "authorization")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	got := rec.Header().Get("Access-Control-Allow-Headers")
	if !strings.Contains(strings.ToLower(got), "authorization") {
		t.Fatalf("Access-Control-Allow-Headers = %q, want it to include Authorization", got)
	}
}

func TestLoopbackCORS_PassesThroughRequestsWithNoOriginHeader(t *testing.T) {
	// A non-browser caller (curl, the Rust sidecar itself during health checks)
	// sends no Origin header at all -- CORS is a browser-enforced policy, so
	// this must not block the request, only skip annotating it.
	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	handler := LoopbackCORS("tauri://localhost")(next)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Fatal("expected request with no Origin header to reach next handler")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}
