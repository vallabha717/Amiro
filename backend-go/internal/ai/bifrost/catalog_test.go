package bifrostai

import (
	"context"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
)

type fakeStore map[string]string

func (f fakeStore) Get(_ context.Context, provider string) (string, bool, error) {
	v, ok := f[provider]
	return v, ok, nil
}
func (f fakeStore) Set(_ context.Context, provider, key string) error {
	f[provider] = key
	return nil
}
func (f fakeStore) Delete(_ context.Context, provider string) error {
	delete(f, provider)
	return nil
}

func TestResolve_KnownProviderAndModelReturnsExactMatch(t *testing.T) {
	got := Resolve("anthropic", "sonnet-4.5")
	if got.Provider != schemas.Anthropic || got.BifrostModel != "claude-sonnet-4-5" {
		t.Fatalf("got %+v", got)
	}
}

func TestResolve_UnknownProviderFallsBackToOpenAIGPT41(t *testing.T) {
	got := Resolve("not-a-real-provider", "not-a-real-model")
	if got.ProviderKey != "openai" || got.BifrostModel != "gpt-4.1" {
		t.Fatalf("got %+v, want the openai/gpt-4.1 fallback", got)
	}
}

func TestResolve_KnownProviderUnknownModelFallsBackToOpenAIGPT41(t *testing.T) {
	got := Resolve("anthropic", "not-a-real-model")
	if got.ProviderKey != "openai" || got.BifrostModel != "gpt-4.1" {
		t.Fatalf("got %+v, want the openai/gpt-4.1 fallback", got)
	}
}

func TestResolve_EmptyProviderAndModelFallsBackToOpenAIGPT41(t *testing.T) {
	got := Resolve("", "")
	if got.ProviderKey != "openai" || got.BifrostModel != "gpt-4.1" {
		t.Fatalf("got %+v, want the openai/gpt-4.1 fallback", got)
	}
}

func TestListModels_OllamaIsAlwaysConfiguredWithNoKeySet(t *testing.T) {
	info := ListModels(context.Background(), fakeStore{})
	for _, p := range info {
		if p.Provider == "ollama" && !p.HasAPIKey {
			t.Fatalf("ollama should always report hasAPIKey=true, got %+v", p)
		}
	}
}

func TestListModels_ProviderWithConfiguredKeyReportsHasAPIKey(t *testing.T) {
	store := fakeStore{"anthropic": "sk-real-key"}
	info := ListModels(context.Background(), store)
	for _, p := range info {
		if p.Provider == "anthropic" && !p.HasAPIKey {
			t.Fatalf("anthropic should report hasAPIKey=true once a key is set, got %+v", p)
		}
		if p.Provider == "openai" && p.HasAPIKey {
			t.Fatalf("openai should report hasAPIKey=false when unset, got %+v", p)
		}
	}
}

func TestListModels_PlaceholderKeyDoesNotCountAsConfigured(t *testing.T) {
	store := fakeStore{"openai": "****"}
	info := ListModels(context.Background(), store)
	for _, p := range info {
		if p.Provider == "openai" && p.HasAPIKey {
			t.Fatalf("a literal \"****\" placeholder key must not count as configured")
		}
	}
}

func TestListModels_EveryCatalogProviderIsListedWithItsModels(t *testing.T) {
	info := ListModels(context.Background(), fakeStore{})
	want := map[string]int{
		"openai": 8, "google": 4, "anthropic": 3, "xai": 3, "ollama": 3, "groq": 5, "openRouter": 7,
	}
	if len(info) != len(want) {
		t.Fatalf("got %d providers, want %d", len(info), len(want))
	}
	for _, p := range info {
		n, ok := want[p.Provider]
		if !ok {
			t.Fatalf("unexpected provider %q", p.Provider)
		}
		if len(p.Models) != n {
			t.Fatalf("provider %q: got %d models, want %d", p.Provider, len(p.Models), n)
		}
	}
}
