package search

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// withServer points a provider at a stub instead of the real API.
//
// The adapters hold an unexported baseURL only for Exa/Tavily, so the stub
// is injected by rewriting the package-level endpoint constants' values via
// the client's Transport instead: every request, whatever its URL, is
// answered by the handler. That keeps the adapters free of a test-only
// "base URL" parameter whose only production value is the constant.
type rewriteTransport struct {
	target string
	seen   *http.Request
	body   string
}

func (t *rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Body != nil {
		raw, _ := io.ReadAll(req.Body)
		t.body = string(raw)
	}
	t.seen = req

	stub, err := http.NewRequest(req.Method, t.target+req.URL.RequestURI(), strings.NewReader(t.body))
	if err != nil {
		return nil, err
	}
	stub.Header = req.Header
	return http.DefaultTransport.RoundTrip(stub)
}

func stub(t *testing.T, status int, contentType, body string) (*httptest.Server, *rewriteTransport) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &rewriteTransport{target: srv.URL}
}

/* ---------------------------------------------------------------- */
/* The bug class this package was rebuilt around                     */
/* ---------------------------------------------------------------- */

// A bot challenge is HTTP 200 carrying HTML. The old SearxNG client checked
// only the status, sailed past it, and died in the JSON decoder reporting
// "invalid character '<'" -- which sent whoever read it looking for a parser
// bug rather than at the fact that they were being blocked.
func TestHTMLChallengeIsReportedAsABlock(t *testing.T) {
	srv, tr := stub(t, http.StatusOK, "text/html; charset=utf-8",
		"<!doctype html><html><head><title>Verifying your browser…</title></head></html>")
	_ = srv

	p := NewBraveProvider("key")
	p.client.Transport = tr

	_, err := p.Search(context.Background(), "anything", 3)
	if err == nil {
		t.Fatal("a 200 carrying an HTML challenge page must not be treated as a result set")
	}
	if !strings.Contains(err.Error(), "HTML page instead of JSON") {
		t.Fatalf("error should name the real problem, got: %v", err)
	}
	if strings.Contains(err.Error(), "invalid character") {
		t.Fatalf("JSON decoder error leaked to the user: %v", err)
	}
}

func TestMissingKeyIsNotConfigured(t *testing.T) {
	for _, p := range []Provider{
		NewBraveProvider(""), NewTavilyProvider(""), NewExaProvider(""), NewSerperProvider(""),
	} {
		if _, err := p.Search(context.Background(), "q", 1); !errors.Is(err, ErrNotConfigured) {
			t.Errorf("%s with no key: got %v, want ErrNotConfigured", p.Name(), err)
		}
	}
}

func TestAuthAndQuotaErrorsAreActionable(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   string
	}{
		{http.StatusUnauthorized, "rejected the API key"},
		{http.StatusForbidden, "rejected the API key"},
		{http.StatusTooManyRequests, "rate limit or quota"},
	} {
		srv, tr := stub(t, tc.status, "application/json", `{}`)
		_ = srv
		p := NewBraveProvider("key")
		p.client.Transport = tr

		_, err := p.Search(context.Background(), "q", 1)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("status %d: got %v, want a message containing %q", tc.status, err, tc.want)
		}
	}
}

/* ---------------------------------------------------------------- */
/* Per-provider response shapes                                      */
/* ---------------------------------------------------------------- */

func TestBraveParsesResultsAndStripsMarkup(t *testing.T) {
	srv, tr := stub(t, http.StatusOK, "application/json", `{
		"web": {"results": [
			{"title": "Go", "url": "https://go.dev", "description": "The <strong>Go</strong> language &amp; tools"}
		]}
	}`)
	_ = srv
	p := NewBraveProvider("key")
	p.client.Transport = tr

	results, err := p.Search(context.Background(), "go", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
	// Markup left in reaches the model, which repeats it verbatim into its
	// answer to the user.
	if results[0].Snippet != "The Go language & tools" {
		t.Fatalf("snippet = %q, want tags stripped and entities decoded", results[0].Snippet)
	}
}

// Brave omits `web` entirely when it has only non-web verticals to offer.
func TestBraveHandlesMissingWebSection(t *testing.T) {
	srv, tr := stub(t, http.StatusOK, "application/json", `{"query": {"original": "x"}}`)
	_ = srv
	p := NewBraveProvider("key")
	p.client.Transport = tr

	results, err := p.Search(context.Background(), "x", 5)
	if err != nil {
		t.Fatalf("a response with no web section is empty, not an error: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("got %d results, want 0", len(results))
	}
}

func TestSerperUsesOrganicResultsOnly(t *testing.T) {
	srv, tr := stub(t, http.StatusOK, "application/json", `{
		"answerBox": {"answer": "42", "title": "Answer"},
		"organic": [{"title": "Real page", "link": "https://example.com", "snippet": "text"}]
	}`)
	_ = srv
	p := NewSerperProvider("key")
	p.client.Transport = tr

	results, err := p.Search(context.Background(), "q", 5)
	if err != nil {
		t.Fatal(err)
	}
	// An answer box is Google's summary of a page, not a page. Passed off as
	// a hit it gives the model a claim with no URL behind it to cite.
	if len(results) != 1 || results[0].URL != "https://example.com" {
		t.Fatalf("got %+v, want only the organic result", results)
	}
}

func TestTavilyExtractSurfacesPerURLFailures(t *testing.T) {
	srv, tr := stub(t, http.StatusOK, "application/json", `{
		"results": [{"url": "https://ok.example", "raw_content": "hello"}],
		"failed_results": [{"url": "https://bad.example", "error": "timed out"}]
	}`)
	_ = srv
	p := NewTavilyProvider("key")
	p.client.Transport = tr

	pages, err := p.Extract(context.Background(), []string{"https://ok.example", "https://bad.example"}, 100)
	if err != nil {
		t.Fatal(err)
	}
	// A URL that could not be fetched has to come back saying so. Dropped,
	// it is indistinguishable from a page that was genuinely empty.
	if len(pages) != 2 {
		t.Fatalf("got %d pages, want 2 (one fetched, one reported failed)", len(pages))
	}
	if !strings.Contains(pages[1].Text, "timed out") {
		t.Fatalf("failed URL should carry its reason, got %q", pages[1].Text)
	}
}

func TestSearchCountIsClampedToProviderLimits(t *testing.T) {
	srv, tr := stub(t, http.StatusOK, "application/json", `{"web":{"results":[]}}`)
	_ = srv
	p := NewBraveProvider("key")
	p.client.Transport = tr

	if _, err := p.Search(context.Background(), "q", 5000); err != nil {
		t.Fatal(err)
	}
	if got := tr.seen.URL.Query().Get("count"); got != "20" {
		t.Fatalf("count = %q, want it clamped to Brave's max of 20", got)
	}
}

/* ---------------------------------------------------------------- */
/* Registry                                                          */
/* ---------------------------------------------------------------- */

// The removed scrapers must not resolve to anything. Before, the switch
// ended in `default:` returning DuckDuckGo, so a stale row -- or a typo --
// silently searched with an engine other than the one named on screen.
func TestUnknownProviderIsAnError(t *testing.T) {
	for _, kind := range []string{"duckduckgo", "searxng", "", "brav"} {
		if _, err := New(kind, "key"); err == nil {
			t.Errorf("New(%q) returned a provider; unknown providers must error", kind)
		}
	}
}

func TestEveryCatalogEntryConstructs(t *testing.T) {
	for _, spec := range Specs {
		p, err := New(string(spec.Kind), "key")
		if err != nil {
			t.Fatalf("catalog lists %q but New rejects it: %v", spec.Kind, err)
		}
		if p.Name() != string(spec.Kind) {
			t.Errorf("%s: Name() = %q, want it to match its catalog kind", spec.Kind, p.Name())
		}
		// The UI shows this badge to explain whether web_content will keep
		// working; a wrong value there is advice that breaks a tool.
		_, extracts := p.(ContentExtractor)
		if extracts != spec.Extracts {
			t.Errorf("%s: implements ContentExtractor = %v, catalog says %v", spec.Kind, extracts, spec.Extracts)
		}
	}
}

func TestCatalogIsSerialisableForTheAdminUI(t *testing.T) {
	raw, err := json.Marshal(Specs)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"extracts"`) {
		t.Fatal("catalog JSON must carry the extracts flag the editor renders")
	}
}

func TestTruncateCutsOnRuneBoundaries(t *testing.T) {
	// Slicing bytes mid-rune yields invalid UTF-8, which survives Go's
	// string type and then fails at the JSON encoder -- losing the whole
	// tool call to one multi-byte character landing on the limit.
	got := truncate("héllo wörld", 4)
	if !json.Valid(mustJSON(t, got)) {
		t.Fatalf("truncate produced invalid UTF-8: %q", got)
	}
	if len([]rune(got)) != 4 {
		t.Fatalf("got %d runes, want 4", len([]rune(got)))
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
