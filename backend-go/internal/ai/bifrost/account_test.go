package bifrostai

import (
	"context"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
)

func TestAccount_GetConfiguredProvidersListsEveryCatalogProvider(t *testing.T) {
	a := newAccount(fakeRepo{})
	providers, err := a.GetConfiguredProviders()
	if err != nil {
		t.Fatalf("GetConfiguredProviders: %v", err)
	}
	if len(providers) != len(catalog) {
		t.Fatalf("got %d providers, want %d (see account.go's doc comment)", len(providers), len(catalog))
	}
}

func TestAccount_GetKeysForProviderReturnsTheConnectionsStoredKey(t *testing.T) {
	a := newAccount(fakeRepo{{id: "cfg-1", provider: "openai", apiKey: "sk-real-key"}})

	keys, err := a.GetKeysForProvider(context.Background(), schemas.ModelProvider("cfg-1"))
	if err != nil {
		t.Fatalf("GetKeysForProvider: %v", err)
	}
	if len(keys) != 1 {
		t.Fatalf("got %d keys, want 1", len(keys))
	}
	if got := keys[0].Value.String(); got != "sk-real-key" {
		t.Fatalf("key value = %q, want %q", got, "sk-real-key")
	}
}

func TestAccount_GetKeysForProviderReturnsNothingForAnUnknownConnection(t *testing.T) {
	a := newAccount(fakeRepo{})

	keys, err := a.GetKeysForProvider(context.Background(), schemas.ModelProvider("missing"))
	if err != nil {
		t.Fatalf("GetKeysForProvider: %v", err)
	}
	if len(keys) != 0 {
		t.Fatalf("got %d keys, want 0 -- Bifrost should see \"no keys found\" rather than a placeholder", len(keys))
	}
}

// The base URL is what makes one OpenAI-compatible gateway different from
// another, and it is stored per connection -- so it has to come back keyed
// by connection id, normalized the way the provider expects.
func TestAccount_GetConfigForProviderAppliesTheConnectionsBaseURL(t *testing.T) {
	a := newAccount(fakeRepo{{
		id: "cfg-1", provider: "openai", apiKey: "sk-real",
		baseURL: "https://inference-api.nousresearch.com/v1",
	}})

	cfg, err := a.GetConfigForProvider(schemas.ModelProvider("cfg-1"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.NetworkConfig.BaseURL != "https://inference-api.nousresearch.com" {
		t.Fatalf("BaseURL = %q, want the /v1 suffix stripped", cfg.NetworkConfig.BaseURL)
	}
	if cfg.CustomProviderConfig == nil || cfg.CustomProviderConfig.BaseProviderType != schemas.OpenAI {
		t.Fatalf("BaseProviderType = %+v, want OpenAI for an openai-typed connection", cfg.CustomProviderConfig)
	}
}

func TestAccount_GetConfigForProviderLeavesBaseURLEmptyWhenUnset(t *testing.T) {
	a := newAccount(fakeRepo{{id: "cfg-1", provider: "anthropic", apiKey: "sk-real"}})

	cfg, err := a.GetConfigForProvider(schemas.ModelProvider("cfg-1"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.NetworkConfig.BaseURL != "" {
		t.Fatalf("BaseURL = %q, want empty so the provider's own default is used", cfg.NetworkConfig.BaseURL)
	}
	if cfg.CustomProviderConfig.BaseProviderType != schemas.Anthropic {
		t.Fatalf("BaseProviderType = %q, want Anthropic", cfg.CustomProviderConfig.BaseProviderType)
	}
}
