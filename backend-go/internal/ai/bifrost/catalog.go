// Package bifrostai wires Bifrost's embedded SDK (github.com/maximhq/bifrost/core)
// into a provider/model catalog and streaming client, per plan section 2 and
// Phase 0's spike (spike/bifrost/main.go, now ported here for Phase 3).
package bifrostai

import (
	"context"
	"os"

	"github.com/maximhq/bifrost/core/schemas"

	"betterchatbot/backend/internal/secrets"
)

// modelEntry is one selectable model under a provider. OurID is what the
// frontend/ChatMetadata sees (matches the TS static model map's key);
// BifrostModel is the ID actually sent to Bifrost -- identical to OurID for
// every model ported so far, but kept distinct since a few TS entries alias
// (e.g. "gpt-5.1-chat" -> "gpt-5.1-chat-latest").
type modelEntry struct {
	OurID        string
	BifrostModel string
}

// providerEntry is one provider row, mirroring one key of models.ts's
// staticModels object.
type providerEntry struct {
	// Key is both the catalog's provider identifier and the secrets.KeyStore
	// provider string -- chosen to match models.ts's provider keys exactly
	// ("openai", "google", ...) so it also satisfies env_store.go's
	// envVarForProvider mapping (including the "google" override) without a
	// second translation table.
	Key      string
	Provider schemas.ModelProvider
	Models   []modelEntry
	// AlwaysConfigured mirrors checkProviderAPIKey's `default: return true`
	// branch -- Ollama needs no API key, so it's always reported as
	// available regardless of what's in the KeyStore.
	AlwaysConfigured bool
	// IsCustom marks an OPENAI_COMPATIBLE_DATA-driven entry (openai_compatible.go)
	// rather than one of the 7 static catalog rows below. CustomBaseURL and
	// CustomAPIKey (the literal key value, not a KeyStore lookup -- these
	// providers never touch secrets.KeyStore, matching how AlwaysConfigured
	// already skips it in hasAPIKey/GetKeysForProvider) come from that env
	// var's JSON, not this file.
	IsCustom      bool
	CustomBaseURL string
	CustomAPIKey  string
}

// catalog ports models.ts's staticModels object (lines 32-80), plus
// (openai_compatible.go's init) OPENAI_COMPATIBLE_DATA-driven custom
// providers appended at startup -- see that file for why this was deferred
// through Phase 7 and what it does and doesn't port from
// create-openai-compatiable.ts.
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
		Key:              "ollama",
		Provider:         schemas.Ollama,
		AlwaysConfigured: true,
		Models: []modelEntry{
			{"gemma3:1b", "gemma3:1b"},
			{"gemma3:4b", "gemma3:4b"},
			{"gemma3:12b", "gemma3:12b"},
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

// fallbackProviderKey/fallbackModelID port models.ts:182's
// `fallbackModel = staticModels.openai["gpt-4.1"]`.
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

// ResolvedModel is what a chat/title/temporary request actually sends to
// Bifrost, plus the catalog identity used to save back onto ChatMetadata.
type ResolvedModel struct {
	ProviderKey  string
	Provider     schemas.ModelProvider
	ModelID      string
	BifrostModel string
}

// Resolve ports customModelProvider.getModel (models.ts:195): an
// unrecognized or empty provider/model falls back to openai/gpt-4.1 rather
// than erroring, matching `allModels[model.provider]?.[model.model] ||
// fallbackModel`.
func Resolve(providerKey, modelID string) ResolvedModel {
	if p, ok := findProvider(providerKey); ok {
		if m, ok := p.findModel(modelID); ok {
			return ResolvedModel{ProviderKey: p.Key, Provider: p.Provider, ModelID: m.OurID, BifrostModel: m.BifrostModel}
		}
	}
	p, _ := findProvider(fallbackProviderKey)
	m, _ := p.findModel(fallbackModelID)
	return ResolvedModel{ProviderKey: p.Key, Provider: p.Provider, ModelID: m.OurID, BifrostModel: m.BifrostModel}
}

// ModelInfo is one model row in the GET /api/chat/models response.
type ModelInfo struct {
	Name string `json:"name"`
}

// ProviderModelsInfo is one provider row in the GET /api/chat/models
// response, matching customModelProvider.modelsInfo's shape (models.ts:185)
// minus the tool-call/image-input/file-mime metadata -- that's a Phase
// 4/5/6 concern (tool calling, multimodal input) not wired up yet.
type ProviderModelsInfo struct {
	Provider  string      `json:"provider"`
	Models    []ModelInfo `json:"models"`
	HasAPIKey bool        `json:"hasAPIKey"`
}

// ListModels ports customModelProvider.modelsInfo, in catalog order (the
// GET /api/chat/models handler applies the hasAPIKey sort on top, matching
// models/route.ts:5-9's separate sort step).
func ListModels(ctx context.Context, store secrets.KeyStore) []ProviderModelsInfo {
	out := make([]ProviderModelsInfo, 0, len(catalog))
	for _, p := range catalog {
		models := make([]ModelInfo, 0, len(p.Models))
		for _, m := range p.Models {
			models = append(models, ModelInfo{Name: m.OurID})
		}
		out = append(out, ProviderModelsInfo{
			Provider:  p.Key,
			Models:    models,
			HasAPIKey: hasAPIKey(ctx, store, p),
		})
	}
	return out
}

func hasAPIKey(ctx context.Context, store secrets.KeyStore, p providerEntry) bool {
	if p.AlwaysConfigured {
		return true
	}
	key, ok, err := store.Get(ctx, p.Key)
	return err == nil && ok && key != "" && key != "****"
}

// ollamaBaseURL ports models.ts:24-26's default Ollama base URL.
func ollamaBaseURL() string {
	if v := os.Getenv("OLLAMA_BASE_URL"); v != "" {
		return v
	}
	return "http://localhost:11434/api"
}
