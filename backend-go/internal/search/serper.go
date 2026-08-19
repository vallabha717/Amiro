package search

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
)

const (
	serperSearchURL  = "https://google.serper.dev/search"
	serperMaxResults = 100
)

// SerperProvider searches Google via the Serper API.
//
// The reason to carry a fourth provider: Brave, Tavily and Exa all run their
// own indexes or their own crawlers, so all three can miss a page that is
// trivially findable on Google. Serper is the escape hatch for "the search
// engine everyone else is actually using". Like Brave it returns links and
// snippets only, so no ContentExtractor.
type SerperProvider struct {
	client *http.Client
	apiKey string
}

func NewSerperProvider(apiKey string) *SerperProvider {
	return &SerperProvider{client: newClient(), apiKey: apiKey}
}

func (p *SerperProvider) Name() string { return "serper" }

func (p *SerperProvider) Search(ctx context.Context, query string, numResults int) ([]Result, error) {
	if p.apiKey == "" {
		return nil, ErrNotConfigured
	}

	payload, err := json.Marshal(map[string]any{
		"q":   query,
		"num": clamp(numResults, 1, serperMaxResults),
	})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, serperSearchURL, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-KEY", p.apiKey)

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, httpError("Serper", resp)
	}
	if err := requireJSON("Serper", resp); err != nil {
		return nil, err
	}

	var body struct {
		Organic []struct {
			Title   string `json:"title"`
			Link    string `json:"link"`
			Snippet string `json:"snippet"`
		} `json:"organic"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}

	// Organic results only. Serper also returns answer boxes, knowledge
	// panels and "people also ask" -- all of which are Google's own
	// summaries of pages rather than pages, and passing them off as search
	// hits gives the model a URL-less claim it will cite as a source.
	results := make([]Result, 0, len(body.Organic))
	for _, r := range body.Organic {
		results = append(results, Result{Title: r.Title, URL: r.Link, Snippet: r.Snippet})
	}
	return results, nil
}
