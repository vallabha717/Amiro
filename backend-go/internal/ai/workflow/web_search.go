package workflow

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// exaAPIKey/exaBaseURL port web-search.ts's API_KEY/BASE_URL module
// constants (src/lib/ai/tools/web/web-search.ts:151).
const exaBaseURL = "https://api.exa.ai"

func exaAPIKey() string {
	return os.Getenv("EXA_API_KEY")
}

// exaSearchParams/exaContentsParams are the Tool node's app-tool parameter
// shapes for AppDefaultToolkit.WebSearch's two tools (DefaultToolName.WebSearch
// / WebContent), decoded from the LLM-generated tool-call arguments.
type exaSearchParams struct {
	Query              string   `json:"query"`
	NumResults         int      `json:"numResults"`
	Type               string   `json:"type"`
	Category           string   `json:"category,omitempty"`
	IncludeDomains     []string `json:"includeDomains,omitempty"`
	ExcludeDomains     []string `json:"excludeDomains,omitempty"`
	StartPublishedDate string   `json:"startPublishedDate,omitempty"`
	EndPublishedDate   string   `json:"endPublishedDate,omitempty"`
	MaxCharacters      int      `json:"maxCharacters,omitempty"`
}

type exaContentsParams struct {
	URLs          []string `json:"urls"`
	MaxCharacters int      `json:"maxCharacters,omitempty"`
	Livecrawl     string   `json:"livecrawl,omitempty"`
}

// fetchExa ports fetchExa (web-search.ts:157).
func fetchExa(ctx context.Context, endpoint string, body interface{}) (json.RawMessage, error) {
	apiKey := exaAPIKey()
	if apiKey == "" {
		return nil, fmt.Errorf("EXA_API_KEY is not configured")
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, exaBaseURL+endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("invalid EXA API key")
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, fmt.Errorf("Exa API usage limit exceeded")
	}
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Exa API error: %d %s", resp.StatusCode, resp.Status)
	}
	return json.RawMessage(respBody), nil
}

// ExaSearchForWorkflow ports exaSearchToolForWorkflow.execute (web-search.ts:184).
func ExaSearchForWorkflow(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
	var params exaSearchParams
	if len(args) > 0 {
		if err := json.Unmarshal(args, &params); err != nil {
			return nil, err
		}
	}
	numResults := params.NumResults
	if numResults == 0 {
		numResults = 5
	}
	searchType := params.Type
	if searchType == "" {
		searchType = "auto"
	}
	maxChars := params.MaxCharacters
	if maxChars == 0 {
		maxChars = 3000
	}

	request := map[string]interface{}{
		"query":      params.Query,
		"type":       searchType,
		"numResults": numResults,
		"contents": map[string]interface{}{
			"text":      map[string]interface{}{"maxCharacters": maxChars},
			"livecrawl": "preferred",
		},
	}
	if params.Category != "" {
		request["category"] = params.Category
	}
	if len(params.IncludeDomains) > 0 {
		request["includeDomains"] = params.IncludeDomains
	}
	if len(params.ExcludeDomains) > 0 {
		request["excludeDomains"] = params.ExcludeDomains
	}
	if params.StartPublishedDate != "" {
		request["startPublishedDate"] = params.StartPublishedDate
	}
	if params.EndPublishedDate != "" {
		request["endPublishedDate"] = params.EndPublishedDate
	}

	return fetchExa(ctx, "/search", request)
}

// ExaContentsForWorkflow ports exaContentsToolForWorkflow.execute (web-search.ts:217).
func ExaContentsForWorkflow(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
	var params exaContentsParams
	if len(args) > 0 {
		if err := json.Unmarshal(args, &params); err != nil {
			return nil, err
		}
	}
	maxChars := params.MaxCharacters
	if maxChars == 0 {
		maxChars = 3000
	}
	livecrawl := params.Livecrawl
	if livecrawl == "" {
		livecrawl = "preferred"
	}

	request := map[string]interface{}{
		"ids": params.URLs,
		"contents": map[string]interface{}{
			"text":      map[string]interface{}{"maxCharacters": maxChars},
			"livecrawl": livecrawl,
		},
	}
	return fetchExa(ctx, "/contents", request)
}
