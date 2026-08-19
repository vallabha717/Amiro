// Package security_test holds Phase 7 section 4's mechanical security
// checks: "Not a substitute for a real review; the mechanical checks that
// are cheap to automate and expensive to miss."
// (docs/testing/phases/phase-07-cross-surface.md §4)
//
// Exit criterion 6: "Security checks pass, including through the
// dashboard."
//
// "Through the dashboard" is a real, distinct code path in this codebase,
// not a rephrasing of the backend API. cmd/server passes
// `BrowserAuth: hasUI` (backend-go/cmd/server/main.go), and hasUI is true
// only in an `embedui` build. With it, the whole mux is wrapped in
// middleware.RequireTokenOrBrowser instead of middleware.RequireToken --
// which means a request carrying NO shared secret at all is admitted on
// the strength of its browser headers (Sec-Fetch-Site / Origin) alone.
// Every dashboard request is that shape, because the dashboard is served
// to a browser that was never told the secret and could not be told it
// privately.
//
// So a test "through the dashboard" here is: an embedui backend, and a
// client that sends no X-Amiro-Token, sends the headers a browser sends,
// and carries only the user's session bearer. That request reaches the
// handlers through a different guard than every other suite's client does,
// and the first test below proves that before any of the others rely on it.
package security_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"amiro/tests/harness/apiclient"
)

// dashboardClient is a request shaped the way the served dashboard's
// fetch() is shaped, and deliberately NOT the way harness/apiclient.Client
// is shaped.
//
// The difference is the whole point: apiclient.Client.authorize() puts
// X-Amiro-Token on every single request, which satisfies
// RequireTokenOrBrowser's first branch and never exercises the browser
// one. Reproducing the browser branch means dropping that header and
// sending what a browser actually sends instead.
type dashboardClient struct {
	baseURL string
	session string
	origin  string
	http    *http.Client
}

func newDashboardClient(baseURL, session string) *dashboardClient {
	return &dashboardClient{
		baseURL: baseURL,
		session: session,
		// A browser's Origin for a same-origin fetch from the served
		// dashboard is the server's own origin.
		origin: baseURL,
		http:   &http.Client{Timeout: 2 * time.Minute},
	}
}

// decorate applies the headers, and only the headers, a same-origin
// dashboard fetch carries.
func (d *dashboardClient) decorate(req *http.Request) {
	req.Header.Set("Origin", d.origin)
	// Sec-Fetch-Site is on the browser's forbidden-header list, so a page
	// cannot set it from JavaScript. That is exactly why
	// middleware.RequireTokenOrBrowser trusts it, and why sending it here
	// is a faithful reproduction rather than a cheat.
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Referer", d.origin+"/")
	if d.session != "" {
		req.Header.Set("Authorization", "Bearer "+d.session)
	}
}

func (d *dashboardClient) do(ctx context.Context, method, path string, body any) (*http.Response, []byte, error) {
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, nil, err
		}
		reader = bytes.NewReader(raw)
	}
	var req *http.Request
	var err error
	if reader != nil {
		req, err = http.NewRequestWithContext(ctx, method, d.baseURL+path, reader)
	} else {
		req, err = http.NewRequestWithContext(ctx, method, d.baseURL+path, nil)
	}
	if err != nil {
		return nil, nil, err
	}
	if reader != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	d.decorate(req)
	resp, err := d.http.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	raw := make([]byte, 0, 4096)
	buf := make([]byte, 4096)
	for {
		n, readErr := resp.Body.Read(buf)
		raw = append(raw, buf[:n]...)
		if readErr != nil {
			break
		}
		if len(raw) > 8<<20 {
			break
		}
	}
	return resp, raw, nil
}

// chatTurn runs a whole streamed chat turn through the dashboard-shaped
// request, decoding the UI message stream with the same reader every other
// suite uses.
func (d *dashboardClient) chatTurn(ctx context.Context, req apiclient.ChatRequest) (apiclient.Turn, error) {
	raw, err := json.Marshal(req)
	if err != nil {
		return apiclient.Turn{}, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, d.baseURL+"/api/chat", bytes.NewReader(raw))
	if err != nil {
		return apiclient.Turn{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	d.decorate(httpReq)

	resp, err := d.http.Do(httpReq)
	if err != nil {
		return apiclient.Turn{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return apiclient.Turn{}, fmt.Errorf("POST /api/chat through the dashboard: %d", resp.StatusCode)
	}
	stream := apiclient.NewStream(resp.Body, nil)
	defer stream.Close()
	return stream.Collect()
}

// assertBrowserGuardIsTheOneInPlay proves, before anything else relies on
// it, that these requests are admitted by the BROWSER branch of
// middleware.RequireTokenOrBrowser and not by a shared secret.
//
// Without this, every "through the dashboard" assertion below could be
// passing because the request happened to be indistinguishable from an
// ordinary API call, and the criterion would be satisfied vacuously.
func assertBrowserGuardIsTheOneInPlay(t *testing.T, ctx context.Context, baseURL, session string) {
	t.Helper()

	// 1. No token, browser headers, real session -> admitted.
	browser := newDashboardClient(baseURL, session)
	resp, _, err := browser.do(ctx, http.MethodGet, "/api/thread", nil)
	if err != nil {
		t.Fatalf("dashboard-shaped GET /api/thread: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("a dashboard-shaped request (no X-Amiro-Token, Sec-Fetch-Site: same-origin, session bearer) "+
			"got %d, want 200. Either this build is not an embedui build (so cmd/server used "+
			"RequireToken, not RequireTokenOrBrowser) or the browser branch changed shape.", resp.StatusCode)
	}

	// 2. No token, no browser headers, real session -> refused, which is
	//    what proves branch 1 above was the browser branch specifically and
	//    not "the token was never needed anyway".
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/thread", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+session)
	req.Header.Set("Origin", "http://an-unrelated-page.example")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	bare, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("cross-site probe: %v", err)
	}
	defer bare.Body.Close()
	if bare.StatusCode != http.StatusUnauthorized {
		t.Fatalf("a cross-site request from an unnamed origin, with no shared secret, got %d, want 401. "+
			"The browser guard is not discriminating, so the dashboard-shaped assertions below would "+
			"prove nothing about it.", bare.StatusCode)
	}
}
