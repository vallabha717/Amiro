package bifrostai

import (
	"encoding/json"
	"log"
	"os"
	"strings"

	"github.com/maximhq/bifrost/core/schemas"
)

// Ports create-openai-compatiable.ts's OPENAI_COMPATIBLE_DATA-driven custom
// provider path -- explicitly deferred at Phase 3 (this file's own
// providerEntry.IsCustom doc comment used to say "not ported... stays open
// work") and never picked up through Phase 7. A user-configured custom
// OpenAI-compatible endpoint (e.g. a self-hosted model behind a base URL)
// was silently invisible to the Go rewrite until now -- found live, not
// assumed: the model didn't appear in the chat model picker at all.
//
// Deliberately not ported: the TS schema's "Azure OpenAI" special case
// (createAzureOpenAICompatible, per-model apiVersion, a different auth/URL
// shape entirely). An entry named "Azure OpenAI" is still parsed and
// registered as a generic OpenAI-compatible provider here -- it just won't
// actually authenticate correctly against a real Azure endpoint. Nobody
// has asked for Azure support in this rewrite; flagged rather than
// silently half-working.
type openAICompatibleModel struct {
	ApiName       string `json:"apiName"`
	UiName        string `json:"uiName"`
	SupportsTools bool   `json:"supportsTools"`
}

type openAICompatibleProvider struct {
	Provider string                  `json:"provider"`
	BaseUrl  string                  `json:"baseUrl"`
	ApiKey   string                  `json:"apiKey"`
	Models   []openAICompatibleModel `json:"models"`
}

// loadOpenAICompatibleProviders ports openaiCompatibleModelsSafeParse's
// try/parse-and-log-on-failure behavior (never a startup crash for
// malformed JSON in a deploy-time env var) plus createOpenAICompatibleModels'
// actual field usage -- note the TS Zod schema's own doc comment for
// `apiKey` claims it's "the name of the environment variable" holding the
// key, but the real code (create-openai-compatiable.ts) passes it straight
// through as the literal key value; this ports the real behavior, not the
// stale doc comment.
func loadOpenAICompatibleProviders() []providerEntry {
	raw := os.Getenv("OPENAI_COMPATIBLE_DATA")
	if raw == "" {
		return nil
	}

	var parsed []openAICompatibleProvider
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		log.Printf("OPENAI_COMPATIBLE_DATA: invalid JSON, ignoring custom providers: %v", err)
		return nil
	}

	entries := make([]providerEntry, 0, len(parsed))
	for _, p := range parsed {
		if p.Provider == "" || p.BaseUrl == "" || len(p.Models) == 0 {
			log.Printf("OPENAI_COMPATIBLE_DATA: skipping provider %q -- provider, baseUrl, and at least one model are required", p.Provider)
			continue
		}
		models := make([]modelEntry, 0, len(p.Models))
		for _, m := range p.Models {
			if m.ApiName == "" || m.UiName == "" {
				log.Printf("OPENAI_COMPATIBLE_DATA: skipping a model under provider %q -- apiName and uiName are both required", p.Provider)
				continue
			}
			models = append(models, modelEntry{OurID: m.UiName, BifrostModel: m.ApiName})
		}
		if len(models) == 0 {
			continue
		}
		entries = append(entries, providerEntry{
			Key:              p.Provider,
			Provider:         schemas.ModelProvider(p.Provider),
			Models:           models,
			AlwaysConfigured: true, // key (if any) comes from CustomAPIKey below, never secrets.KeyStore
			IsCustom:         true,
			CustomBaseURL:    normalizeBaseURL(p.BaseUrl),
			CustomAPIKey:     p.ApiKey,
		})
	}
	return entries
}

// normalizeBaseURL strips a trailing "/v1" (with or without a trailing
// slash) from a user-supplied base URL. Found live, not assumed: Bifrost's
// OpenAI-compatible provider always appends its own literal "/v1/chat/
// completions" to NetworkConfig.BaseURL (confirmed by reading
// buildRequestURL in the vendored core -- every OpenAI-provider request
// path is hardcoded "/v1/...", unconditionally concatenated onto BaseURL,
// no de-duplication). create-openai-compatiable.ts's own convention
// (mirroring the @ai-sdk/openai-compatible package, and every example in
// this repo's openai-compatible.config.ts) is to include the trailing
// "/v1" in baseUrl -- passing that straight through as
// NetworkConfig.BaseURL produces a real, reproduced-live "/v1/v1/chat/
// completions" double prefix that 404s ("route not found") against a real
// endpoint that only serves the single-"/v1" path.
func normalizeBaseURL(baseURL string) string {
	trimmed := strings.TrimSuffix(baseURL, "/")
	trimmed = strings.TrimSuffix(trimmed, "/v1")
	return trimmed
}

func init() {
	catalog = append(catalog, loadOpenAICompatibleProviders()...)
}
