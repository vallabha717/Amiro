package bifrostai

import (
	"context"

	"github.com/maximhq/bifrost/core/schemas"
)

type account struct {
	repo ProviderFetcher
}

func newAccount(repo ProviderFetcher) *account {
	return &account{repo: repo}
}

func (a *account) GetConfiguredProviders() ([]schemas.ModelProvider, error) {
	// Returning nil tells Bifrost that all provider routing is dynamic via DB
	// (GetConfigForProvider and GetKeysForProvider), preventing it from freezing
	// static base URLs against an empty database at startup.
	return nil, nil
}

func (a *account) GetKeysForProvider(ctx context.Context, providerKey schemas.ModelProvider) ([]schemas.Key, error) {
	id := string(providerKey)

	if fetcher, ok := a.repo.(singleConfigFetcher); ok {
		_, _, key, err := fetcher.GetProviderBaseURLAndKey(ctx, id)
		if err == nil && key != "" {
			return []schemas.Key{{
				ID:     id + "-key",
				Name:   id,
				Value:  *schemas.NewSecretVar(key),
				Models: schemas.WhiteList{"*"},
				Weight: 1,
			}}, nil
		}
	}
	return nil, nil
}

// Helper interface to get config by ID
type singleConfigFetcher interface {
	GetProviderBaseURLAndKey(ctx context.Context, id string) (provider string, baseURL string, apiKey string, err error)
}

func (a *account) GetConfigForProvider(providerKey schemas.ModelProvider) (*schemas.ProviderConfig, error) {
	id := string(providerKey)
	baseURL := ""
	var baseProviderType schemas.ModelProvider = schemas.OpenAI

	if a.repo != nil {
		if fetcher, ok := a.repo.(singleConfigFetcher); ok {
			if provider, url, _, err := fetcher.GetProviderBaseURLAndKey(context.Background(), id); err == nil {
				if url != "" {
					baseURL = normalizeBaseURL(url)
				}
				if p, found := findProvider(provider); found {
					baseProviderType = p.Provider
				}
			}
		}
	}

	cfg := &schemas.ProviderConfig{
		NetworkConfig: schemas.NetworkConfig{BaseURL: baseURL, AllowPrivateNetwork: true},
	}

	// Wrap in CustomProviderConfig to tell Bifrost core which protocol to use
	cfg.CustomProviderConfig = &schemas.CustomProviderConfig{
		BaseProviderType: baseProviderType,
	}

	return cfg, nil
}
