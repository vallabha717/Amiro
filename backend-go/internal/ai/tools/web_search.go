package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
)

const exaBaseURL = "https://api.exa.ai"

// exaSearchInput/exaContentsInput mirror exaSearchSchema/exaContentsSchema
// (lib/ai/tools/web/web-search.ts).
type exaSearchInput struct {
	Query              string   `json:"query"`
	NumResults         int      `json:"numResults"`
	Type               string   `json:"type"`
	Category           string   `json:"category"`
	IncludeDomains     []string `json:"includeDomains"`
	ExcludeDomains     []string `json:"excludeDomains"`
	StartPublishedDate string   `json:"startPublishedDate"`
	EndPublishedDate   string   `json:"endPublishedDate"`
	MaxCharacters      int      `json:"maxCharacters"`
}

type exaContentsInput struct {
	URLs          []string `json:"urls"`
	MaxCharacters int      `json:"maxCharacters"`
	Livecrawl     string   `json:"livecrawl"`
}

type exaContentsConfig struct {
	Text struct {
		MaxCharacters int `json:"maxCharacters,omitempty"`
	} `json:"text"`
	Livecrawl string `json:"livecrawl,omitempty"`
}

type exaSearchRequest struct {
	Query              string            `json:"query"`
	Type               string            `json:"type"`
	Category           string            `json:"category,omitempty"`
	IncludeDomains     []string          `json:"includeDomains,omitempty"`
	ExcludeDomains     []string          `json:"excludeDomains,omitempty"`
	StartPublishedDate string            `json:"startPublishedDate,omitempty"`
	EndPublishedDate   string            `json:"endPublishedDate,omitempty"`
	NumResults         int               `json:"numResults"`
	Contents           exaContentsConfig `json:"contents"`
}

type exaContentsRequest struct {
	IDs      []string          `json:"ids"`
	Contents exaContentsConfig `json:"contents"`
}

// exaToolError mirrors exaSearchTool/exaContentsTool's .ifFail return
// shape -- like http_fetch.go, a "failed" call still succeeds as a tool
// call and returns this as its output, matching TS's safe().ifFail().
type exaToolError struct {
	IsError  bool   `json:"isError"`
	Error    string `json:"error"`
	Solution string `json:"solution"`
}

// webSearchTools ports exaSearchTool and exaContentsTool (the non-workflow
// variants -- lib/ai/tools/web/web-search.ts:236,284). EXA_API_KEY is read
// per-call, matching the TS module-level `const API_KEY =
// process.env.EXA_API_KEY` read at import time closely enough: both fail
// the same way (a clear "not configured" tool error) when unset.
func webSearchTools() []Definition {
	return []Definition{
		{
			Name:    NameWebSearch,
			Toolkit: ToolkitWebSearch,
			Description: "Search the web using Exa AI - performs real-time web searches with semantic and " +
				"neural search capabilities. Returns high-quality, relevant results with full content extraction.",
			ParametersSchema: exaSearchSchema,
			Execute:          executeWebSearch,
			Risk:             RiskRead,
		},
		{
			Name:    NameWebContent,
			Toolkit: ToolkitWebSearch,
			Description: "Extract detailed content from specific URLs using Exa AI - retrieves full text " +
				"content, metadata, and structured information from web pages with live crawling capabilities.",
			ParametersSchema: exaContentsSchema,
			Execute:          executeWebContent,
			Risk:             RiskRead,
		},
	}
}

var exaSearchSchema = json.RawMessage(`{
	"type": "object",
	"properties": {
		"query": {"type": "string", "description": "Search query"},
		"numResults": {"type": "number", "description": "Number of search results to return", "default": 5, "minimum": 1, "maximum": 20},
		"type": {
			"type": "string",
			"enum": ["auto", "keyword", "neural"],
			"description": "Search type - auto lets Exa decide, keyword for exact matches, neural for semantic search",
			"default": "auto"
		},
		"category": {
			"type": "string",
			"enum": ["company", "research paper", "news", "linkedin profile", "github", "tweet", "movie", "song", "personal site", "pdf"],
			"description": "Category to focus the search on"
		},
		"includeDomains": {"type": "array", "items": {"type": "string"}, "description": "List of domains to specifically include in search results"},
		"excludeDomains": {"type": "array", "items": {"type": "string"}, "description": "List of domains to specifically exclude from search results"},
		"startPublishedDate": {"type": "string", "description": "Start date for published content (YYYY-MM-DD format)"},
		"endPublishedDate": {"type": "string", "description": "End date for published content (YYYY-MM-DD format)"},
		"maxCharacters": {"type": "number", "description": "Maximum characters to extract from each result", "default": 3000, "minimum": 100, "maximum": 10000}
	},
	"required": ["query"]
}`)

var exaContentsSchema = json.RawMessage(`{
	"type": "object",
	"properties": {
		"urls": {"type": "array", "items": {"type": "string"}, "description": "List of URLs to extract content from"},
		"maxCharacters": {"type": "number", "description": "Maximum characters to extract from each URL", "default": 3000, "minimum": 100, "maximum": 10000},
		"livecrawl": {
			"type": "string",
			"enum": ["always", "fallback", "preferred"],
			"description": "Live crawling preference - always forces live crawl, fallback uses cache first, preferred tries live first",
			"default": "preferred"
		}
	},
	"required": ["urls"]
}`)

func executeWebSearch(ctx context.Context, rawInput json.RawMessage) (any, error) {
	var in exaSearchInput
	if err := json.Unmarshal(rawInput, &in); err != nil {
		return exaToolError{IsError: true, Error: err.Error(), Solution: exaSolutionText("search")}, nil
	}
	if in.Type == "" {
		in.Type = "auto"
	}
	if in.NumResults == 0 {
		in.NumResults = 5
	}
	maxChars := in.MaxCharacters
	if maxChars == 0 {
		maxChars = 3000
	}

	req := exaSearchRequest{
		Query:              in.Query,
		Type:               in.Type,
		Category:           in.Category,
		IncludeDomains:     in.IncludeDomains,
		ExcludeDomains:     in.ExcludeDomains,
		StartPublishedDate: in.StartPublishedDate,
		EndPublishedDate:   in.EndPublishedDate,
		NumResults:         in.NumResults,
	}
	req.Contents.Text.MaxCharacters = maxChars
	req.Contents.Livecrawl = "preferred"

	result, err := fetchExa(ctx, "/search", req)
	if err != nil {
		return exaToolError{IsError: true, Error: err.Error(), Solution: exaSolutionText("search")}, nil
	}
	if resultMap, ok := result.(map[string]any); ok {
		resultMap["guide"] = "Use the search results to answer the user's question. Summarize the content " +
			"and ask if they have any additional questions about the topic."
		return resultMap, nil
	}
	return result, nil
}

func executeWebContent(ctx context.Context, rawInput json.RawMessage) (any, error) {
	var in exaContentsInput
	if err := json.Unmarshal(rawInput, &in); err != nil {
		return exaToolError{IsError: true, Error: err.Error(), Solution: exaSolutionText("content extraction")}, nil
	}
	maxChars := in.MaxCharacters
	if maxChars == 0 {
		maxChars = 3000
	}
	livecrawl := in.Livecrawl
	if livecrawl == "" {
		livecrawl = "preferred"
	}

	req := exaContentsRequest{IDs: in.URLs}
	req.Contents.Text.MaxCharacters = maxChars
	req.Contents.Livecrawl = livecrawl

	result, err := fetchExa(ctx, "/contents", req)
	if err != nil {
		return exaToolError{IsError: true, Error: err.Error(), Solution: exaSolutionText("content extraction")}, nil
	}
	return result, nil
}

func fetchExa(ctx context.Context, endpoint string, body any) (any, error) {
	apiKey := os.Getenv("EXA_API_KEY")
	if apiKey == "" {
		return nil, errors.New("EXA_API_KEY is not configured")
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

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, errors.New("Invalid EXA API key")
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, errors.New("Exa API usage limit exceeded")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Exa API error: %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	}

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var result any
	if err := json.Unmarshal(respBytes, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func exaSolutionText(kind string) string {
	return fmt.Sprintf("A web %s error occurred. First, explain to the user what caused this specific error "+
		"and how they can resolve it. Then provide helpful information based on your existing knowledge to "+
		"answer their question.", kind)
}
