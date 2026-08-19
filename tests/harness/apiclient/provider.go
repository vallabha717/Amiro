package apiclient

import (
	"context"
	"encoding/json"
)

// Provider is one configured LLM provider, as GET /api/ai/providers returns
// it. The key itself is never returned -- Configured is how the API says
// "there is a key", which is exactly the shape a test should assert on.
type Provider struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Provider   string   `json:"provider"`
	Configured bool     `json:"configured"`
	BaseURL    string   `json:"baseUrl,omitempty"`
	Models     []string `json:"models,omitempty"`
}

// ProviderInput is the create/update body.
//
// The API key travels through THIS route rather than through the process
// environment, and that is a deliberate choice of the test plan
// (docs/testing/02-config.md): Amiro stores provider keys via
// internal/secrets, and injecting OPENAI_API_KEY into the environment would
// exercise EnvStore -- the web-deployment path -- instead of the desktop
// path most users are on. Seeding through the real endpoint tests the real
// storage.
type ProviderInput struct {
	ID       string   `json:"id,omitempty"`
	Name     string   `json:"name"`
	Provider string   `json:"provider"`
	APIKey   string   `json:"apiKey"`
	BaseURL  string   `json:"baseUrl,omitempty"`
	Models   []string `json:"models,omitempty"`
}

func (c *Client) ListProviders(ctx context.Context) ([]Provider, error) {
	var out []Provider
	err := c.Get(ctx, "/api/ai/providers", &out)
	return out, err
}

func (c *Client) SaveProvider(ctx context.Context, in ProviderInput) (Provider, error) {
	var out Provider
	err := c.Post(ctx, "/api/ai/providers", in, &out)
	return out, err
}

func (c *Client) DeleteProvider(ctx context.Context, id string) error {
	return c.Delete(ctx, join("/api/ai/providers", id), nil)
}

// ProviderModels lists what a provider advertises, given a key.
func (c *Client) ProviderModels(ctx context.Context, body any) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Post(ctx, "/api/ai/providers/models", body, &out)
	return out, err
}

func (c *Client) SyncProviderModels(ctx context.Context, id string) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Post(ctx, join("/api/ai/providers", id)+"/sync-models", nil, &out)
	return out, err
}

// TestProvider is the "does this key work?" route. It makes a real
// outbound call, so it is cassette-backed in replay mode.
func (c *Client) TestProvider(ctx context.Context, id string, body any) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Post(ctx, join("/api/ai/providers", id)+"/test", body, &out)
	return out, err
}

// SearchProvider is one configured web-search provider.
type SearchProvider struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Provider   string `json:"provider"`
	Configured bool   `json:"configured"`
	APIKeyHint string `json:"apiKeyHint,omitempty"`
	IsActive   bool   `json:"isActive"`
}

func (c *Client) ListSearchProviders(ctx context.Context) ([]SearchProvider, error) {
	var out []SearchProvider
	err := c.Get(ctx, "/api/search/providers", &out)
	return out, err
}

func (c *Client) SaveSearchProvider(ctx context.Context, body any) (SearchProvider, error) {
	var out SearchProvider
	err := c.Post(ctx, "/api/search/providers", body, &out)
	return out, err
}

func (c *Client) DeleteSearchProvider(ctx context.Context, id string) error {
	return c.Delete(ctx, join("/api/search/providers", id), nil)
}

func (c *Client) ActivateSearchProvider(ctx context.Context, id string) error {
	return c.Post(ctx, join("/api/search/providers", id)+"/activate", nil, nil)
}

func (c *Client) TestSearchProvider(ctx context.Context, id string, body any) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Post(ctx, join("/api/search/providers", id)+"/test", body, &out)
	return out, err
}

func (c *Client) ActiveSearch(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Get(ctx, "/api/search/active", &out)
	return out, err
}

func (c *Client) SearchCatalog(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Get(ctx, "/api/search/catalog", &out)
	return out, err
}
