package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"

	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/search"
)

// webSearchInput/webContentInput are the tool argument shapes.
type webSearchInput struct {
	Query      string `json:"query"`
	NumResults int    `json:"numResults"`
}

type webContentInput struct {
	URLs          []string `json:"urls"`
	MaxCharacters int      `json:"maxCharacters"`
}

// webToolError is returned as a *successful* tool call carrying an error
// payload, matching http_fetch.go and the TS `safe().ifFail()` shape: the
// model gets to read what went wrong and tell the user, rather than the turn
// failing with a message only the logs will ever show.
type webToolError struct {
	IsError  bool   `json:"isError"`
	Error    string `json:"error"`
	Solution string `json:"solution"`
}

// webSearchTools builds web_search and web_content against whichever
// provider is currently active.
//
// The provider is resolved per call rather than captured at construction:
// these Definitions are built once per request, but a user can switch the
// active provider in the admin UI mid-conversation, and a tool holding a
// provider chosen at startup would keep searching with the old one until the
// process restarted.
func webSearchTools(searchRepo *repository.SearchProviderRepository) []Definition {
	return []Definition{
		{
			Name:    NameWebSearch,
			Toolkit: ToolkitWebSearch,
			Description: "Search the web for current information. Returns titles, URLs and snippets from " +
				"the configured search provider. Use this when the answer depends on information that may " +
				"have changed, or that you do not already know.",
			ParametersSchema: webSearchSchema,
			Execute: func(ctx context.Context, input json.RawMessage) (any, error) {
				return executeWebSearch(ctx, input, searchRepo)
			},
			Risk: RiskRead,
		},
		{
			Name:    NameWebContent,
			Toolkit: ToolkitWebSearch,
			Description: "Extract the readable text of specific URLs. Use this after web_search when a " +
				"snippet is not enough and you need what the page actually says.",
			ParametersSchema: webContentSchema,
			Execute: func(ctx context.Context, input json.RawMessage) (any, error) {
				return executeWebContent(ctx, input, searchRepo)
			},
			Risk: RiskRead,
		},
	}
}

var webSearchSchema = json.RawMessage(`{
	"type": "object",
	"properties": {
		"query": {"type": "string", "description": "Search query"},
		"numResults": {"type": "number", "description": "Number of results to return", "default": 5, "minimum": 1, "maximum": 20}
	},
	"required": ["query"],
	"additionalProperties": false
}`)

var webContentSchema = json.RawMessage(`{
	"type": "object",
	"properties": {
		"urls": {"type": "array", "items": {"type": "string"}, "description": "URLs to extract content from"},
		"maxCharacters": {"type": "number", "description": "Maximum characters to extract from each URL", "default": 3000, "minimum": 100, "maximum": 10000}
	},
	"required": ["urls"],
	"additionalProperties": false
}`)

// noProviderMessage is what the user sees when nothing is configured.
//
// It names the screen to go to. "Web search is not configured" without that
// is a dead end for anyone who has not already been told where the setting
// lives.
const noProviderMessage = "no web search provider is active -- add one under Settings > Search Providers and activate it"

// activeProvider resolves the configured provider, or explains why it could not.
//
// A repository error is returned, never swallowed. The previous version
// discarded it and fell through to a default engine, so a database problem
// presented as searches quietly going somewhere else -- the failure mode
// where everything looks like it is working and the results are just
// mysteriously worse.
func activeProvider(ctx context.Context, repo *repository.SearchProviderRepository) (search.Provider, string, error) {
	if repo == nil {
		return nil, "", errors.New(noProviderMessage)
	}
	cfg, err := repo.GetActive(ctx)
	if err != nil {
		// Logged as well as returned: the model relays the message to the
		// user, but the underlying DB error is an operator's problem and
		// belongs somewhere an operator will look.
		log.Printf("search: reading active provider: %v", err)
		return nil, "", errors.New("could not read the search provider configuration")
	}
	if cfg == nil {
		return nil, "", errors.New(noProviderMessage)
	}

	provider, err := search.New(cfg.Provider, cfg.APIKey)
	if err != nil {
		return nil, cfg.Provider, err
	}
	return provider, cfg.Provider, nil
}

func executeWebSearch(ctx context.Context, rawInput json.RawMessage, repo *repository.SearchProviderRepository) (any, error) {
	var in webSearchInput
	if err := json.Unmarshal(rawInput, &in); err != nil {
		return toolError(err, "search"), nil
	}
	if in.NumResults == 0 {
		in.NumResults = 5
	}

	provider, kind, err := activeProvider(ctx, repo)
	if err != nil {
		return toolError(err, "search"), nil
	}

	results, err := provider.Search(ctx, in.Query, in.NumResults)
	if err != nil {
		if errors.Is(err, search.ErrNotConfigured) {
			err = fmt.Errorf("the active provider (%s) has no API key set -- add one under Settings > Search Providers", kind)
		}
		return toolError(err, "search"), nil
	}

	// An empty result set is reported as such rather than as an error. "No
	// pages matched" is a real answer to a search, and dressing it up as a
	// failure invites the model to retry the same query.
	return map[string]any{
		"provider": kind,
		"results":  results,
		"guide": "Use these results to answer the user's question, citing the URLs you relied on. " +
			"If a snippet is not enough, call web_content on the specific URLs.",
	}, nil
}

func executeWebContent(ctx context.Context, rawInput json.RawMessage, repo *repository.SearchProviderRepository) (any, error) {
	var in webContentInput
	if err := json.Unmarshal(rawInput, &in); err != nil {
		return toolError(err, "content extraction"), nil
	}
	if len(in.URLs) == 0 {
		return toolError(errors.New("no urls given"), "content extraction"), nil
	}
	if in.MaxCharacters == 0 {
		in.MaxCharacters = 3000
	}

	provider, kind, err := activeProvider(ctx, repo)
	if err != nil {
		return toolError(err, "content extraction"), nil
	}

	// The bug this replaces: this tool used to call Exa unconditionally,
	// taking whatever key the active provider happened to hold. With a
	// non-Exa provider active that meant sending its key to Exa and
	// reporting "EXA_API_KEY is not configured" -- so on any setup that did
	// not happen to use Exa, web_content was simply dead.
	//
	// Capability is now asked for rather than assumed, and a provider that
	// cannot extract says so and names the tool that can do the job
	// instead. http_fetch is in every toolkit this one is, so the advice is
	// always actionable.
	extractor, ok := provider.(search.ContentExtractor)
	if !ok {
		return toolError(
			fmt.Errorf("the active search provider (%s) returns links only and cannot extract page content", kind),
			"content extraction",
			"Use the http_fetch tool to retrieve these URLs directly, or switch to a provider that extracts content (Tavily or Exa) under Settings > Search Providers.",
		), nil
	}

	pages, err := extractor.Extract(ctx, in.URLs, in.MaxCharacters)
	if err != nil {
		if errors.Is(err, search.ErrNotConfigured) {
			err = fmt.Errorf("the active provider (%s) has no API key set -- add one under Settings > Search Providers", kind)
		}
		return toolError(err, "content extraction"), nil
	}

	return map[string]any{"provider": kind, "pages": pages}, nil
}

// toolError builds the error payload, with an optional caller-supplied
// remedy in place of the generic one.
func toolError(err error, kind string, solution ...string) webToolError {
	remedy := fmt.Sprintf("A web %s error occurred. Explain to the user what caused it and how to resolve it, "+
		"then answer their question from your existing knowledge if you can.", kind)
	if len(solution) > 0 && solution[0] != "" {
		remedy = solution[0]
	}
	return webToolError{IsError: true, Error: err.Error(), Solution: remedy}
}
