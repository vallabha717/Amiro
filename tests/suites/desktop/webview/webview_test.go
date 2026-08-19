// Package webview_test covers the "webview" feature: "the correct origin
// is allowed; CORS matches AMIRO_ALLOWED_ORIGIN; the auth token reaches
// the backend."
//
// The auth-token half is already proven, repeatedly, by
// backend-go/tests/e2e/sidecar_test.go's health-with/without-token pair --
// not repeated here. The CORS half does not need cargo: it is a property
// of backend-go/internal/middleware.CORS and cmd/server's own wiring,
// driven with an HTTP client sending a real Origin header at a real
// sidecar. What genuinely needs cargo -- whether a live webview actually
// loads the dashboard -- is not here.
package webview_test

import (
	"context"
	"net/http"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/config"
	"amiro/tests/harness/desktop"
)

// TestWebview_DevOriginIsAllowedByTheLoopbackWildcard covers the dev half
// of "the correct origin is allowed": cmd/server always passes
// LoopbackOriginWildcard: true (main.go), so Tauri's dev origin --
// http://localhost:3210, per src-tauri/tauri.conf.json's build.devUrl --
// is allowed without AMIRO_ALLOWED_ORIGIN needing to name it explicitly.
func TestWebview_DevOriginIsAllowedByTheLoopbackWildcard(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, be.URL+"/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	be.Authorize(req)
	req.Header.Set("Origin", "http://localhost:3210")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	defer resp.Body.Close()

	got := resp.Header.Get("Access-Control-Allow-Origin")
	if got != "http://localhost:3210" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want Tauri's dev origin echoed back", got)
	}
}

// TestWebview_PackagedOriginIsAllowedOnlyWhenAMIROAllowedOriginNamesIt is
// the literal "CORS matches AMIRO_ALLOWED_ORIGIN" half. A packaged Tauri
// app's webview origin is http://tauri.localhost (src-tauri/src/lib.rs's
// non-dev allowed_origin) -- NOT a "localhost:<port>" loopback origin, so
// the wildcard the dev-origin test relies on does not cover it. Rust is
// expected to pass this value in AMIRO_ALLOWED_ORIGIN when it spawns the
// packaged sidecar; this test reproduces that by setting the same
// variable through backend.Env's override hook and checking the exact
// match, not the wildcard.
func TestWebview_PackagedOriginIsAllowedOnlyWhenAMIROAllowedOriginNamesIt(t *testing.T) {
	const packagedOrigin = "http://tauri.localhost"
	h := harness.New(t, harness.Tags("smoke"), harness.With(func(c *config.Config) {
		if c.Backend.Env == nil {
			c.Backend.Env = map[string]string{}
		}
		c.Backend.Env["AMIRO_ALLOWED_ORIGIN"] = packagedOrigin
	}))
	be := h.Backend()

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, be.URL+"/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	be.Authorize(req)
	req.Header.Set("Origin", packagedOrigin)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	defer resp.Body.Close()

	got := resp.Header.Get("Access-Control-Allow-Origin")
	if got != packagedOrigin {
		t.Fatalf("Access-Control-Allow-Origin = %q with AMIRO_ALLOWED_ORIGIN=%s, want it echoed back exactly",
			got, packagedOrigin)
	}
}

func TestWebview_DisallowedOriginGetsNoCORSHeader(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, be.URL+"/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	be.Authorize(req)
	req.Header.Set("Origin", "http://evil.example")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	defer resp.Body.Close()

	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q for an unrelated origin, want no header at all", got)
	}
}

// TestWebview_RealTauriWebviewLoadsTheDashboard is the part of this
// feature that needs a live webview -- WKWebView, WebView2 or WebKitGTK
// actually rendering the dashboard, not an HTTP client impersonating one.
// Not reachable without cargo.
func TestWebview_RealTauriWebviewLoadsTheDashboard(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	desktop.RequireToolchain(h, h.Config.Desktop.Enabled)
	h.Skip("reached only with cargo and the Tauri CLI present -- not implemented beyond the toolchain check, " +
		"since it was never runnable here")
}
