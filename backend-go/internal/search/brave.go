package search

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
)

const braveBaseURL = "https://api.search.brave.com/res/v1/web/search"

// braveMaxResults is the API's own per-request ceiling.
const braveMaxResults = 20

// BraveProvider searches via the Brave Search API.
//
// Brave is the general-purpose default: an independent index (not a Google
// or Bing reseller), a documented JSON API, and a free tier that needs only
// a card-free signup. It returns links and snippets -- no page text -- so it
// deliberately does not implement ContentExtractor.
type BraveProvider struct {
	client *http.Client
	apiKey string
}

func NewBraveProvider(apiKey string) *BraveProvider {
	return &BraveProvider{client: newClient(), apiKey: apiKey}
}

func (p *BraveProvider) Name() string { return "brave" }

func (p *BraveProvider) Search(ctx context.Context, query string, numResults int) ([]Result, error) {
	if p.apiKey == "" {
		return nil, ErrNotConfigured
	}

	q := url.Values{}
	q.Set("q", query)
	q.Set("count", strconv.Itoa(clamp(numResults, 1, braveMaxResults)))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, braveBaseURL+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("X-Subscription-Token", p.apiKey)

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, httpError("Brave", resp)
	}
	if err := requireJSON("Brave", resp); err != nil {
		return nil, err
	}

	// `web` is absent, not empty, when Brave has only non-web verticals to
	// offer (news, videos). Decoding into a nested struct rather than
	// indexing a map keeps that case as "no results" instead of a panic.
	var body struct {
		Web struct {
			Results []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
			} `json:"results"`
		} `json:"web"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}

	results := make([]Result, 0, len(body.Web.Results))
	for _, r := range body.Web.Results {
		results = append(results, Result{
			Title: r.Title,
			URL:   r.URL,
			// Brave marks query terms in descriptions with <strong> tags.
			// Left in, they reach the model as literal markup it then
			// repeats back in its answer.
			Snippet: stripTags(r.Description),
		})
	}
	return results, nil
}
