package search

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
)

const (
	exaBaseURL     = "https://api.exa.ai"
	exaMaxResults  = 100
	exaMaxContents = 100
)

// ExaProvider searches and extracts via the Exa API.
//
// Exa is the semantic option: it embeds the query rather than matching
// keywords, which is what makes it good at "find me pages that argue X" and
// worse than Brave or Serper at "find the docs page for this exact flag".
// It implements ContentExtractor via /contents.
type ExaProvider struct {
	client *http.Client
	apiKey string
}

func NewExaProvider(apiKey string) *ExaProvider {
	return &ExaProvider{client: newClient(), apiKey: apiKey}
}

func (p *ExaProvider) Name() string { return "exa" }

func (p *ExaProvider) Search(ctx context.Context, query string, numResults int) ([]Result, error) {
	if p.apiKey == "" {
		return nil, ErrNotConfigured
	}

	body := map[string]any{
		"query":      query,
		"numResults": clamp(numResults, 1, exaMaxResults),
		"contents": map[string]any{
			"text":      map[string]any{"maxCharacters": 3000},
			"livecrawl": "preferred",
		},
	}

	var out struct {
		Results []struct {
			Title string `json:"title"`
			URL   string `json:"url"`
			Text  string `json:"text"`
		} `json:"results"`
	}
	if err := p.post(ctx, "/search", body, &out); err != nil {
		return nil, err
	}

	results := make([]Result, 0, len(out.Results))
	for _, r := range out.Results {
		results = append(results, Result{Title: r.Title, URL: r.URL, Snippet: r.Text})
	}
	return results, nil
}

func (p *ExaProvider) Extract(ctx context.Context, urls []string, maxCharacters int) ([]Page, error) {
	if p.apiKey == "" {
		return nil, ErrNotConfigured
	}
	if len(urls) > exaMaxContents {
		urls = urls[:exaMaxContents]
	}

	body := map[string]any{
		"urls": urls,
		"text": map[string]any{"maxCharacters": maxCharacters},
	}

	var out struct {
		Results []struct {
			URL           string `json:"url"`
			Title         string `json:"title"`
			Text          string `json:"text"`
			Author        string `json:"author"`
			PublishedDate string `json:"publishedDate"`
		} `json:"results"`
	}
	if err := p.post(ctx, "/contents", body, &out); err != nil {
		return nil, err
	}

	pages := make([]Page, 0, len(out.Results))
	for _, r := range out.Results {
		pages = append(pages, Page{
			URL:     r.URL,
			Title:   r.Title,
			Text:    truncate(r.Text, maxCharacters),
			Author:  r.Author,
			Publish: r.PublishedDate,
		})
	}
	return pages, nil
}

func (p *ExaProvider) post(ctx context.Context, endpoint string, body any, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, exaBaseURL+endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", p.apiKey)

	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return httpError("Exa", resp)
	}
	if err := requireJSON("Exa", resp); err != nil {
		return err
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
