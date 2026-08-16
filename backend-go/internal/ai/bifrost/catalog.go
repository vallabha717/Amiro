package bifrostai

import (
	"context"

	"github.com/maximhq/bifrost/core/schemas"
)

type modelEntry struct {
	OurID        string
	BifrostModel string
}

type providerEntry struct {
	Key              string
	Provider         schemas.ModelProvider
	Models           []modelEntry
	AlwaysConfigured bool
}

var catalog = []providerEntry{
	{
		Key:      "openai",
		Provider: schemas.OpenAI,
		Models: []modelEntry{
			{"gpt-4.1", "gpt-4.1"},
			{"gpt-4.1-mini", "gpt-4.1-mini"},
			{"o4-mini", "o4-mini"},
			{"o3", "o3"},
			{"gpt-5.1-chat", "gpt-5.1-chat-latest"},
			{"gpt-5.1", "gpt-5.1"},
			{"gpt-5.1-codex", "gpt-5.1-codex"},
			{"gpt-5.1-codex-mini", "gpt-5.1-codex-mini"},
		},
	},
	{
		Key:      "google",
		Provider: schemas.Gemini,
		Models: []modelEntry{
			{"gemini-2.5-flash-lite", "gemini-2.5-flash-lite"},
			{"gemini-2.5-flash", "gemini-2.5-flash"},
			{"gemini-3-pro", "gemini-3-pro-preview"},
			{"gemini-2.5-pro", "gemini-2.5-pro"},
		},
	},
	{
		Key:      "anthropic",
		Provider: schemas.Anthropic,
		Models: []modelEntry{
			{"sonnet-4.5", "claude-sonnet-4-5"},
			{"haiku-4.5", "claude-haiku-4-5"},
			{"opus-4.5", "claude-opus-4-5"},
		},
	},
	{
		Key:      "xai",
		Provider: schemas.XAI,
		Models: []modelEntry{
			{"grok-4-1-fast", "grok-4-1-fast-non-reasoning"},
			{"grok-4-1", "grok-4-1"},
			{"grok-3-mini", "grok-3-mini"},
		},
	},
	{
		Key:      "groq",
		Provider: schemas.Groq,
		Models: []modelEntry{
			{"kimi-k2-instruct", "moonshotai/kimi-k2-instruct"},
			{"llama-4-scout-17b", "meta-llama/llama-4-scout-17b-16e-instruct"},
			{"gpt-oss-20b", "openai/gpt-oss-20b"},
			{"gpt-oss-120b", "openai/gpt-oss-120b"},
			{"qwen3-32b", "qwen/qwen3-32b"},
		},
	},
	{
		Key:      "openRouter",
		Provider: schemas.OpenRouter,
		Models: []modelEntry{
			{"gpt-oss-20b:free", "openai/gpt-oss-20b:free"},
			{"qwen3-8b:free", "qwen/qwen3-8b:free"},
			{"qwen3-14b:free", "qwen/qwen3-14b:free"},
			{"qwen3-coder:free", "qwen/qwen3-coder:free"},
			{"deepseek-r1:free", "deepseek/deepseek-r1-0528:free"},
			{"deepseek-v3:free", "deepseek/deepseek-chat-v3-0324:free"},
			{"gemini-2.0-flash-exp:free", "google/gemini-2.0-flash-exp:free"},
		},
	},
}

const (
	fallbackProviderKey = "openai"
	fallbackModelID     = "gpt-4.1"
)

func findProvider(key string) (providerEntry, bool) {
	for _, p := range catalog {
		if p.Key == key {
			return p, true
		}
	}
	return providerEntry{}, false
}

func (p providerEntry) findModel(ourID string) (modelEntry, bool) {
	for _, m := range p.Models {
		if m.OurID == ourID {
			return m, true
		}
	}
	return modelEntry{}, false
}

type ResolvedModel struct {
	ProviderKey  string
	Provider     schemas.ModelProvider
	ModelID      string
	BifrostModel string
}

func Resolve(configID, modelID string) ResolvedModel {
	if configID == "" || modelID == "" {
		p, _ := findProvider(fallbackProviderKey)
		m, _ := p.findModel(fallbackModelID)
		return ResolvedModel{ProviderKey: p.Key, Provider: p.Provider, ModelID: m.OurID, BifrostModel: m.BifrostModel}
	}
	// We send configID directly to bifrost which will look it up dynamically via GetConfigForProvider
	return ResolvedModel{
		ProviderKey:  configID,
		Provider:     schemas.ModelProvider(configID),
		ModelID:      modelID,
		BifrostModel: modelID,
	}
}

type ModelInfo struct {
	Name string `json:"name"`
}

type ProviderModelsInfo struct {
	Provider     string      `json:"provider"`
	ProviderName string      `json:"providerName"`
	ProviderType string      `json:"providerType"`
	Models       []ModelInfo `json:"models"`
	HasAPIKey    bool        `json:"hasAPIKey"`
}

type ProviderFetcher interface {
	IterateConfigs(ctx context.Context, cb func(id, provider, name, apiKey string, models []string)) error
}

func ListModels(ctx context.Context, repo ProviderFetcher) []ProviderModelsInfo {
	var out []ProviderModelsInfo

	if repo == nil {
		return out
	}

	repo.IterateConfigs(ctx, func(id, provider, name, apiKey string, customModels []string) {
		models := make([]ModelInfo, 0, len(customModels))

		if len(customModels) > 0 {
			for _, m := range customModels {
				models = append(models, ModelInfo{Name: m})
			}
		} else {
			// Fallback to static models for this provider type if no custom models are set
			if p, ok := findProvider(provider); ok {
				for _, m := range p.Models {
					models = append(models, ModelInfo{Name: m.OurID})
				}
			}
		}

		hasKey := apiKey != "" && apiKey != "****"

		out = append(out, ProviderModelsInfo{
			Provider:     id,
			ProviderName: name,
			ProviderType: provider,
			Models:       models,
			HasAPIKey:    hasKey,
		})
	})

	return out
}

func normalizeBaseURL(baseURL string) string {
	if len(baseURL) > 0 && baseURL[len(baseURL)-1] == '/' {
		baseURL = baseURL[:len(baseURL)-1]
	}
	if len(baseURL) >= 3 && baseURL[len(baseURL)-3:] == "/v1" {
		baseURL = baseURL[:len(baseURL)-3]
	}
	return baseURL
}
