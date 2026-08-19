package security_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"amiro/tests/harness"
)

// httpGet is a bare GET with explicit headers, used where the point IS the
// headers and harness/apiclient's automatic ones would defeat the test.
func httpGet(url string, headers map[string]string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return (&http.Client{Timeout: 30 * time.Second}).Do(req)
}

// TestSecurity_CORSHonoursAllowOriginFlagAndNothingElse is the phase
// document's "CORS enforcement, including with `--allow-origin` set".
//
// What Phase 6 already covers, and why this is not a duplicate.
// suites/desktop/webview/webview_test.go tests three things against the
// SIDECAR (cmd/server): the loopback wildcard allows Tauri's dev origin,
// AMIRO_ALLOWED_ORIGIN allows the packaged origin, and an unrelated origin
// gets no header. All three drive `cfg.AllowedOrigin`, the env-var input.
//
// `--allow-origin` is a different input to the same allowlist, reachable
// only from a different binary. backend-go/internal/httpserver/router.go
// builds the list as:
//
//	origins := append([]string{cfg.AllowedOrigin}, opts.AllowedOrigins...)
//
// `cfg.AllowedOrigin` is AMIRO_ALLOWED_ORIGIN (Phase 6's input);
// `opts.AllowedOrigins` comes from httpserver.Options, which cmd/server
// never populates and which only cmd/amiro's `--allow-origin` flag feeds,
// through client.EmbeddedOptions. So the flag is a genuinely untested
// path, on a binary no other suite drives, even though it converges on the
// same isAllowedOrigin comparison.
//
// It is also worth testing for a reason the env var is not: router.go
// hands that same `origins` slice to middleware.RequireTokenOrBrowser as
// well, so `--allow-origin` widens the cross-site browser-auth bypass at
// the same time as it widens CORS. An operator typing it is making two
// decisions, and only one of them is written on the flag.
//
// The control is the second server. Asserting "the named origin is
// echoed" alone would pass on a server that echoed every origin; the
// second `amiro serve`, identical but for the flag, is what proves the
// flag is what did it.
func TestSecurity_CORSHonoursAllowOriginFlagAndNothingElse(t *testing.T) {
	const named = "https://dashboard.example.test"
	const unnamed = "https://evil.example.test"

	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	withFlag := startServe(t, h, "with-allow-origin", "127.0.0.1", "--allow-origin", named)
	withoutFlag := startServe(t, h, "without-allow-origin", "127.0.0.1")

	corsHeaderFor := func(t *testing.T, s *servedBackend, origin string) string {
		t.Helper()
		resp, err := httpGet(s.URL+"/health", map[string]string{
			"X-Amiro-Token": s.Token,
			"Origin":        origin,
		})
		if err != nil {
			t.Fatalf("GET /health with Origin %s: %v", origin, err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET /health with Origin %s returned %d, want 200", origin, resp.StatusCode)
		}
		return resp.Header.Get("Access-Control-Allow-Origin")
	}

	t.Run("named_origin_is_allowed_when_the_flag_names_it", func(t *testing.T) {
		if got := corsHeaderFor(t, withFlag, named); got != named {
			t.Fatalf("Access-Control-Allow-Origin = %q with --allow-origin %s, want the origin echoed back exactly",
				got, named)
		}
	})

	// The control. Same binary, same flags, minus --allow-origin.
	t.Run("named_origin_is_refused_without_the_flag", func(t *testing.T) {
		if got := corsHeaderFor(t, withoutFlag, named); got != "" {
			t.Fatalf("Access-Control-Allow-Origin = %q for %s on a server started WITHOUT --allow-origin, "+
				"want no header at all. The flag is not what allowed it in the sibling subtest, so that "+
				"subtest proves nothing.", got, named)
		}
	})

	t.Run("an_unnamed_origin_is_refused_even_with_the_flag_set", func(t *testing.T) {
		if got := corsHeaderFor(t, withFlag, unnamed); got != "" {
			t.Fatalf("Access-Control-Allow-Origin = %q for %s, want no header at all -- --allow-origin "+
				"allowed one origin, not everything", got, unnamed)
		}
	})

	// isAllowedOrigin compares exact strings. A prefix or suffix match
	// would be the classic way to get this wrong, and both are cheap to
	// rule out.
	t.Run("origins_are_matched_exactly_not_by_prefix_or_suffix", func(t *testing.T) {
		for _, near := range []string{
			named + ".evil.test",
			named + ":8443",
			"https://evil.test/" + named,
			"http://dashboard.example.test", // same host, wrong scheme
		} {
			if got := corsHeaderFor(t, withFlag, near); got != "" {
				t.Errorf("Access-Control-Allow-Origin = %q for the near-miss origin %q, want no header",
					got, near)
			}
		}
	})

	// The other half of what --allow-origin widens: router.go passes the
	// same slice to RequireTokenOrBrowser. This build serves no UI, so
	// BrowserAuth is off and RequireToken is in force -- which means a
	// tokenless cross-site request must be refused regardless of the flag.
	// Asserting it here records the current, safe state of that coupling.
	t.Run("the_flag_does_not_admit_a_tokenless_request_on_a_no_ui_server", func(t *testing.T) {
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, withFlag.URL+"/api/thread", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", named)
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
		if err != nil {
			t.Fatalf("tokenless cross-site GET: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("a tokenless cross-site request from the --allow-origin origin got %d, want 401 "+
				"(this server runs --no-ui, so middleware.RequireToken is in force, not RequireTokenOrBrowser)",
				resp.StatusCode)
		}
	})
}
