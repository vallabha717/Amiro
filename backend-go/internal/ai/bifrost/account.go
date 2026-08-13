package bifrostai

import (
	"context"

	"github.com/maximhq/bifrost/core/schemas"

	"betterchatbot/backend/internal/secrets"
)

// account implements schemas.Account (the interface Phase 0's spike proved
// out) over a secrets.KeyStore instead of the spike's single hardcoded env
// var -- every catalog provider is registered, not just OpenAI.
//
// Every provider is always reported as "configured" (GetConfiguredProviders
// never filters on key presence), matching how models.ts always defines a
// LanguageModel for every static entry regardless of hasAPIKey and only
// fails at call time with a missing-key error. GetKeysForProvider returns
// an empty key list for a provider with nothing in the KeyStore; Bifrost
// surfaces that as "no keys found for provider" on the actual request
// rather than at Init.
type account struct {
	store secrets.KeyStore
}

func newAccount(store secrets.KeyStore) *account {
	return &account{store: store}
}

func (a *account) GetConfiguredProviders() ([]schemas.ModelProvider, error) {
	providers := make([]schemas.ModelProvider, 0, len(catalog))
	for _, p := range catalog {
		providers = append(providers, p.Provider)
	}
	return providers, nil
}

func (a *account) GetKeysForProvider(ctx context.Context, providerKey schemas.ModelProvider) ([]schemas.Key, error) {
	entry, ok := providerByBifrostKey(providerKey)
	if !ok {
		return nil, nil
	}

	if entry.IsCustom {
		// Never looked up via secrets.KeyStore -- the key (if any) came
		// straight from OPENAI_COMPATIBLE_DATA's own apiKey field
		// (openai_compatible.go). Same placeholder-key trick as Ollama's
		// AlwaysConfigured branch below when there isn't one, so Bifrost
		// routes to it instead of reporting "no keys found for provider".
		return []schemas.Key{{
			ID:     "custom-" + entry.Key,
			Name:   entry.Key,
			Value:  *schemas.NewSecretVar(entry.CustomAPIKey),
			Models: schemas.WhiteList{"*"},
			Weight: 1,
		}}, nil
	}

	key, found, err := a.store.Get(ctx, entry.Key)
	if err != nil && !entry.AlwaysConfigured {
		return nil, err
	}
	if err != nil || !found || key == "" {
		if entry.AlwaysConfigured {
			// Ollama needs no API key -- register one placeholder key so
			// Bifrost routes to it instead of reporting "no keys found".
			// A keyring/secret-service error (e.g. no D-Bus secret service
			// on a headless box) must not block this provider either: it
			// never needed the store in the first place.
			placeholder := schemas.Key{
				ID:     "local-" + entry.Key,
				Name:   entry.Key,
				Value:  *schemas.NewSecretVar(""),
				Models: schemas.WhiteList{"*"},
				Weight: 1,
			}
			if entry.Key == "ollama" {
				// Bifrost's key validator requires every Ollama key to carry
				// its own OllamaKeyConfig.URL (per-key routing/round-robin
				// across Ollama instances) and silently skips keys that omit
				// it -- without this, GetKeysForProvider's placeholder key
				// is always dropped and every Ollama chat request fails with
				// "no keys found that support model: <id>", regardless of
				// the keyring outcome above.
				placeholder.OllamaKeyConfig = &schemas.OllamaKeyConfig{URL: *schemas.NewSecretVar(ollamaBaseURL())}
			}
			return []schemas.Key{placeholder}, nil
		}
		return nil, nil
	}

	return []schemas.Key{{
		ID:     entry.Key + "-key",
		Name:   entry.Key,
		Value:  *schemas.NewSecretVar(key),
		Models: schemas.WhiteList{"*"},
		Weight: 1,
	}}, nil
}

func (a *account) GetConfigForProvider(providerKey schemas.ModelProvider) (*schemas.ProviderConfig, error) {
	entry, ok := providerByBifrostKey(providerKey)
	if ok && entry.Key == "ollama" {
		return &schemas.ProviderConfig{
			NetworkConfig: schemas.NetworkConfig{BaseURL: ollamaBaseURL()},
		}, nil
	}
	if ok && entry.IsCustom {
		// BaseProviderType: OpenAI -- every OPENAI_COMPATIBLE_DATA entry is,
		// by definition, an OpenAI-request/response-shaped API (the "Azure
		// OpenAI" TS special case isn't ported, see openai_compatible.go).
		// IsKeyLess mirrors whether the config actually supplied a key,
		// so Bifrost doesn't demand one for a genuinely keyless self-hosted
		// endpoint -- the placeholder key GetKeysForProvider still returns
		// either way is what actually carries the base URL's auth header
		// when CustomAPIKey is set.
		return &schemas.ProviderConfig{
			NetworkConfig: schemas.NetworkConfig{BaseURL: entry.CustomBaseURL},
			CustomProviderConfig: &schemas.CustomProviderConfig{
				BaseProviderType: schemas.OpenAI,
				IsKeyLess:        entry.CustomAPIKey == "",
			},
		}, nil
	}
	return &schemas.ProviderConfig{}, nil
}

func providerByBifrostKey(providerKey schemas.ModelProvider) (providerEntry, bool) {
	for _, p := range catalog {
		if p.Provider == providerKey {
			return p, true
		}
	}
	return providerEntry{}, false
}
