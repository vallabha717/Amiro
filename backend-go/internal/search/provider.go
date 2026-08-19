// Package search adapts third-party web-search APIs to one interface the
// agent tools can call without knowing which service answered.
//
// # Only real APIs, never scraping
//
// Every provider here talks to a documented JSON API with an API key. That
// is a deliberate constraint, arrived at the expensive way: this package
// previously shipped a DuckDuckGo HTML scraper and a SearxNG client aimed at
// public instances, and both are gone because both are unworkable from a
// server.
//
// A data-center IP is exactly what those endpoints exist to stop.
// html.duckduckgo.com answers 202 with a CAPTCHA; the public SearxNG
// instances answer 200 with an HTML "Verifying your browser..." interstitial
// or 429. The second failure mode is the instructive one -- a challenge page
// is a *success* status carrying HTML, so a client that only checks the
// status code sails past it and dies in the JSON decoder, reporting
// "invalid character '<'" to a user whose actual problem is that they are
// being blocked. Scraping does not fail cleanly, it fails confusingly, and
// each fix invites the next block.
//
// So: keys, not scrapers. `ErrNotConfigured` is how a provider says the key
// is missing, which is a state the UI can explain and a user can fix.
package search

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// Result is one search hit, in the shape the agent tools emit.
type Result struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

// Page is one URL's extracted content, for the web_content tool.
type Page struct {
	URL     string `json:"url"`
	Title   string `json:"title,omitempty"`
	Text    string `json:"text"`
	Author  string `json:"author,omitempty"`
	Publish string `json:"publishedDate,omitempty"`
}

// Provider is a web-search backend.
type Provider interface {
	Search(ctx context.Context, query string, numResults int) ([]Result, error)
	Name() string
}

// ContentExtractor is the optional second half: fetching a specific URL's
// readable text rather than searching for it.
//
// Optional because it genuinely is. Exa and Tavily extract content; Brave
// and Serper return links and snippets and nothing else. Modelling that as a
// separate interface rather than a method on Provider that some
// implementations stub out is what lets web_content tell the user "this
// provider cannot do that, here is one that can" instead of returning an
// empty result that looks like the page was blank.
type ContentExtractor interface {
	Extract(ctx context.Context, urls []string, maxCharacters int) ([]Page, error)
}

// ErrNotConfigured is returned when a provider has no key (or no base URL).
// Distinct from a request failure: nothing was attempted, and the fix is a
// setting rather than a retry.
var ErrNotConfigured = errors.New("search provider is not configured")

// requestTimeout bounds one call to a provider.
//
// Set on the client rather than left to the caller's context. A search is a
// step inside an agent turn whose context may legitimately live for minutes,
// and a provider that accepts the connection and then stalls would hold the
// whole turn open with no output -- the failure that looks like the app
// hanging rather than like a search timing out.
const requestTimeout = 20 * time.Second

func newClient() *http.Client {
	return &http.Client{Timeout: requestTimeout}
}

// httpError turns a non-2xx response into a message that says what to do.
//
// 401 and 429 are called out by name because they are the two a user can act
// on -- one is a wrong key, the other is a quota -- and "Brave API error:
// 401 Unauthorized" buries that under a status line.
func httpError(provider string, resp *http.Response) error {
	switch resp.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%s rejected the API key -- check it in Search Providers", provider)
	case http.StatusTooManyRequests:
		return fmt.Errorf("%s rate limit or quota exceeded -- wait, or check your plan's remaining credits", provider)
	}
	return fmt.Errorf("%s API error: %d %s", provider, resp.StatusCode, http.StatusText(resp.StatusCode))
}

// clamp keeps a requested result count inside what the APIs accept.
//
// Every provider here rejects or silently truncates counts outside its own
// range, and the model picks this number. One rule applied before the
// request beats four different remote error messages after it.
func clamp(n, min, max int) int {
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}
