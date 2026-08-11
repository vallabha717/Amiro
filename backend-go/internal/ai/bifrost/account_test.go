package bifrostai

import (
	"context"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
)

func TestAccount_GetConfiguredProvidersListsEveryCatalogProviderRegardlessOfKeys(t *testing.T) {
	a := newAccount(fakeStore{})
	providers, err := a.GetConfiguredProviders()
	if err != nil {
		t.Fatalf("GetConfiguredProviders: %v", err)
	}
	if len(providers) != len(catalog) {
		t.Fatalf("got %d providers, want %d (every provider is always \"configured\" -- see account.go's doc comment)", len(providers), len(catalog))
	}
}

func TestAccount_GetKeysForProviderReturnsTheStoredKey(t *testing.T) {
	a := newAccount(fakeStore{"anthropic": "sk-real-key"})
	keys, err := a.GetKeysForProvider(context.Background(), schemas.Anthropic)
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

func TestAccount_GetKeysForProviderReturnsEmptyWhenNoKeyIsSet(t *testing.T) {
	a := newAccount(fakeStore{})
	keys, err := a.GetKeysForProvider(context.Background(), schemas.Anthropic)
	if err != nil {
		t.Fatalf("GetKeysForProvider: %v", err)
	}
	if len(keys) != 0 {
		t.Fatalf("got %d keys, want 0 -- Bifrost should see \"no keys found\" rather than a placeholder", len(keys))
	}
}

func TestAccount_GetKeysForProviderReturnsAPlaceholderKeyForOllamaWithNoKeySet(t *testing.T) {
	a := newAccount(fakeStore{})
	keys, err := a.GetKeysForProvider(context.Background(), schemas.Ollama)
	if err != nil {
		t.Fatalf("GetKeysForProvider: %v", err)
	}
	if len(keys) != 1 {
		t.Fatalf("got %d keys, want 1 -- ollama needs no real API key but still needs a registered key so Bifrost routes to it", len(keys))
	}
}

func TestAccount_GetConfigForProviderSetsOllamaBaseURL(t *testing.T) {
	t.Setenv("OLLAMA_BASE_URL", "http://example.invalid:1234/api")
	a := newAccount(fakeStore{})
	cfg, err := a.GetConfigForProvider(schemas.Ollama)
	if err != nil {
		t.Fatalf("GetConfigForProvider: %v", err)
	}
	if cfg.NetworkConfig.BaseURL != "http://example.invalid:1234/api" {
		t.Fatalf("BaseURL = %q, want the OLLAMA_BASE_URL override", cfg.NetworkConfig.BaseURL)
	}
}

func TestAccount_GetConfigForProviderLeavesOtherProvidersAtDefault(t *testing.T) {
	a := newAccount(fakeStore{})
	cfg, err := a.GetConfigForProvider(schemas.OpenAI)
	if err != nil {
		t.Fatalf("GetConfigForProvider: %v", err)
	}
	if cfg.NetworkConfig.BaseURL != "" {
		t.Fatalf("BaseURL = %q, want empty (no override) for a non-ollama provider", cfg.NetworkConfig.BaseURL)
	}
}
