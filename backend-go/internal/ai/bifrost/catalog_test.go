package bifrostai

import (
	"context"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
)

// fakeConfig is one row of a fakeRepo -- the test-side stand-in for a
// repository.ProviderConfigData.
type fakeConfig struct {
	id       string
	provider string
	name     string
	apiKey   string
	baseURL  string
	models   []string
}

// fakeRepo implements both interfaces this package asks of a provider
// store: ProviderFetcher (catalog.go) for listing, and singleConfigFetcher
// (account.go) for resolving one connection's credentials by id.
type fakeRepo []fakeConfig

func (f fakeRepo) IterateConfigs(_ context.Context, cb func(id, provider, name, apiKey string, models []string)) error {
	for _, c := range f {
		cb(c.id, c.provider, c.name, c.apiKey, c.models)
	}
	return nil
}

func (f fakeRepo) GetProviderBaseURLAndKey(_ context.Context, id string) (string, string, string, error) {
	for _, c := range f {
		if c.id == id {
			return c.provider, c.baseURL, c.apiKey, nil
		}
	}
	return "", "", "", nil
}

func TestResolve_EmptyRequestFallsBackToTheCatalogDefault(t *testing.T) {
	got := Resolve("", "")
	if got.Provider != schemas.OpenAI || got.BifrostModel != "gpt-4.1" {
		t.Fatalf("got %+v, want the openai/gpt-4.1 fallback", got)
	}
}

// A chat request names a provider *connection* (a provider_config row id),
// not a provider type -- Resolve passes that id through as the Bifrost
// provider so account.GetConfigForProvider can look the row up. Two
// connections to the same vendor therefore stay distinct.
func TestResolve_ConfigIDIsPassedThroughAsTheBifrostProvider(t *testing.T) {
	got := Resolve("cfg-123", "z-ai/glm-5.2")
	if string(got.Provider) != "cfg-123" {
		t.Fatalf("Provider = %q, want the config id", got.Provider)
	}
	if got.BifrostModel != "z-ai/glm-5.2" {
		t.Fatalf("BifrostModel = %q, want the model sent verbatim", got.BifrostModel)
	}
}

func TestListModels_ReportsEachConfigsOwnModels(t *testing.T) {
	repo := fakeRepo{{
		id: "cfg-1", provider: "openai", name: "Tyson LiteLLM",
		apiKey: "sk-real", models: []string{"gpt-5.6-luna", "claude-opus-4-8"},
	}}

	info := ListModels(context.Background(), repo)
	if len(info) != 1 {
		t.Fatalf("got %d providers, want 1", len(info))
	}
	got := info[0]
	if got.Provider != "cfg-1" || got.ProviderName != "Tyson LiteLLM" || got.ProviderType != "openai" {
		t.Fatalf("identity = %+v, want the config id/name/type", got)
	}
	if !got.HasAPIKey {
		t.Fatalf("HasAPIKey = false, want true when a real key is stored")
	}
	if len(got.Models) != 2 || got.Models[0].Name != "gpt-5.6-luna" {
		t.Fatalf("Models = %+v, want the configured list in order", got.Models)
	}
}

// A connection saved before anyone synced or typed a model list still needs
// to offer something in the model selector.
func TestListModels_FallsBackToCatalogModelsWhenConfigListsNone(t *testing.T) {
	repo := fakeRepo{{id: "cfg-1", provider: "anthropic", name: "Anthropic", apiKey: "sk-real"}}

	info := ListModels(context.Background(), repo)
	if len(info) != 1 {
		t.Fatalf("got %d providers, want 1", len(info))
	}
	anthropic, _ := findProvider("anthropic")
	if len(info[0].Models) != len(anthropic.Models) {
		t.Fatalf("got %d models, want the %d catalog defaults", len(info[0].Models), len(anthropic.Models))
	}
}

func TestListModels_PlaceholderKeyDoesNotCountAsConfigured(t *testing.T) {
	repo := fakeRepo{{id: "cfg-1", provider: "openai", name: "OpenAI", apiKey: "****"}}

	info := ListModels(context.Background(), repo)
	if len(info) != 1 {
		t.Fatalf("got %d providers, want 1", len(info))
	}
	if info[0].HasAPIKey {
		t.Fatalf("a literal \"****\" placeholder key must not count as configured")
	}
}

func TestListModels_NoConfigsMeansNoProviders(t *testing.T) {
	if info := ListModels(context.Background(), fakeRepo{}); len(info) != 0 {
		t.Fatalf("got %d providers, want 0 -- nothing is offered until a connection is saved", len(info))
	}
	if info := ListModels(context.Background(), nil); len(info) != 0 {
		t.Fatalf("a nil repo must yield no providers, got %d", len(info))
	}
}

func TestNormalizeBaseURL_StripsTrailingSlashAndVersionSuffix(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"https://litellm.tyson.com/v1", "https://litellm.tyson.com"},
		{"https://litellm.tyson.com/v1/", "https://litellm.tyson.com"},
		{"https://example.com", "https://example.com"},
	} {
		if got := normalizeBaseURL(tc.in); got != tc.want {
			t.Fatalf("normalizeBaseURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
