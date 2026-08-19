package search

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
)

const (
	tavilySearchURL  = "https://api.tavily.com/search"
	tavilyExtractURL = "https://api.tavily.com/extract"
	tavilyMaxResults = 20
	// The extract endpoint's documented per-request URL ceiling.
	tavilyMaxExtractURLs = 20
)

// TavilyProvider searches and extracts via the Tavily API.
//
// Tavily is built for exactly this caller: it returns cleaned, readable page
// text alongside each hit rather than a snippet meant for a human scanning a
// results page. It implements ContentExtractor as well as Provider, which
// makes it the one free-tier option that covers *both* agent tools --
// web_search and web_content -- without an Exa key.
type TavilyProvider struct {
	client *http.Client
	apiKey string
}

func NewTavilyProvider(apiKey string) *TavilyProvider {
	return &TavilyProvider{client: newClient(), apiKey: apiKey}
}

func (p *TavilyProvider) Name() string { return "tavily" }

func (p *TavilyProvider) Search(ctx context.Context, query string, numResults int) ([]Result, error) {
	if p.apiKey == "" {
		return nil, ErrNotConfigured
	}

	body := map[string]any{
		"query":          query,
		"max_results":    clamp(numResults, 1, tavilyMaxResults),
		"search_depth":   "basic",
		"include_answer": false,
	}

	var out struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := p.post(ctx, tavilySearchURL, body, &out); err != nil {
		return nil, err
	}

	results := make([]Result, 0, len(out.Results))
	for _, r := range out.Results {
		results = append(results, Result{Title: r.Title, URL: r.URL, Snippet: r.Content})
	}
	return results, nil
}

func (p *TavilyProvider) Extract(ctx context.Context, urls []string, maxCharacters int) ([]Page, error) {
	if p.apiKey == "" {
		return nil, ErrNotConfigured
	}
	if len(urls) > tavilyMaxExtractURLs {
		urls = urls[:tavilyMaxExtractURLs]
	}

	var out struct {
		Results []struct {
			URL        string `json:"url"`
			RawContent string `json:"raw_content"`
		} `json:"results"`
		// Tavily reports per-URL failures alongside successes rather than
		// failing the batch. Surfaced below so a page that could not be
		// fetched is visible as such instead of silently missing.
		Failed []struct {
			URL   string `json:"url"`
			Error string `json:"error"`
		} `json:"failed_results"`
	}
	if err := p.post(ctx, tavilyExtractURL, map[string]any{"urls": urls}, &out); err != nil {
		return nil, err
	}

	pages := make([]Page, 0, len(out.Results)+len(out.Failed))
	for _, r := range out.Results {
		pages = append(pages, Page{URL: r.URL, Text: truncate(r.RawContent, maxCharacters)})
	}
	for _, f := range out.Failed {
		pages = append(pages, Page{URL: f.URL, Text: "could not be fetched: " + f.Error})
	}
	return pages, nil
}

func (p *TavilyProvider) post(ctx context.Context, url string, body any, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	// Bearer, not the legacy `api_key` body field: Tavily still accepts the
	// latter but its own docs moved to the header, and a key in the body is
	// a key that lands in any request log that records payloads.
	req.Header.Set("Authorization", "Bearer "+p.apiKey)

	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return httpError("Tavily", resp)
	}
	if err := requireJSON("Tavily", resp); err != nil {
		return err
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
