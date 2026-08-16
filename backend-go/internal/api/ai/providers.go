package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
)

// ProviderConfigDTO defines the payload for setting provider keys.
//
// An empty APIKey on an update means "leave the stored key alone" (see
// repository.ProviderRepository.Set) -- it never clears a saved key.
type ProviderConfigDTO struct {
	ID       string   `json:"id,omitempty"`
	Name     string   `json:"name"`
	Provider string   `json:"provider"`
	APIKey   string   `json:"apiKey"`
	BaseURL  string   `json:"baseUrl"`
	Models   []string `json:"models"`
}

// ProviderStatusDTO represents the connected status of a provider config.
//
// APIKey is returned in the clear. That is deliberate and is the whole point
// of this screen: a provider connection is editable the same way an MCP
// server config is, and a key the user can't read back is a key they can't
// verify or fix. The endpoint is session-gated like every other admin route.
type ProviderStatusDTO struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Provider   string   `json:"provider"`
	Configured bool     `json:"configured"` // true if has api key
	APIKey     string   `json:"apiKey,omitempty"`
	BaseURL    string   `json:"baseUrl,omitempty"`
	Models     []string `json:"models,omitempty"`
}

// SetProviderKey stores a BYOK API key plus the connection's base URL and
// permitted model list.
func (h *Handler) SetProviderKey(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}

	if h.providerRepo == nil {
		httpjson.ServerError(w, nil)
		return
	}

	var req ProviderConfigDTO
	if !httpjson.Decode(w, r, &req) {
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	req.Provider = strings.TrimSpace(req.Provider)
	req.BaseURL = strings.TrimSpace(req.BaseURL)
	req.APIKey = strings.TrimSpace(req.APIKey)

	if req.Provider == "" || req.Name == "" {
		httpjson.BadRequest(w, "provider and name are required")
		return
	}

	// A brand-new connection with no key would be saved as permanently
	// unusable -- the model selector hides it and every call 401s -- so
	// reject it here instead of letting it look like it worked.
	if req.ID == "" && req.APIKey == "" {
		httpjson.BadRequest(w, "apiKey is required for a new provider")
		return
	}

	id, err := h.providerRepo.Set(r.Context(), req.ID, req.Provider, req.Name, req.BaseURL, req.APIKey, req.Models)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"id": id})
}

// DeleteProviderConfig removes a provider config and its key.
func (h *Handler) DeleteProviderConfig(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httpjson.BadRequest(w, "id required")
		return
	}

	if err := h.providerRepo.Delete(r.Context(), id); err != nil {
		httpjson.ServerError(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// GetProviderStatuses returns every configured provider connection for the
// admin UI.
func (h *Handler) GetProviderStatuses(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}

	if h.providerRepo == nil {
		httpjson.ServerError(w, nil)
		return
	}

	configs, err := h.providerRepo.List(r.Context())
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	statuses := make([]ProviderStatusDTO, 0, len(configs))
	for _, c := range configs {
		statuses = append(statuses, ProviderStatusDTO{
			ID:         c.ID,
			Name:       c.Name,
			Provider:   c.Provider,
			Configured: c.APIKey != "",
			APIKey:     c.APIKey,
			BaseURL:    c.BaseURL,
			Models:     c.Models,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(statuses)
}

// FetchModelsReq defines the payload for listing a provider's models.
//
// ID is optional: when set, any field left blank falls back to what that
// config already has stored. That's what lets the providers card sync models
// without the browser ever having to round-trip the key back to us.
type FetchModelsReq struct {
	ID       string `json:"id"`
	Provider string `json:"provider"`
	APIKey   string `json:"apiKey"`
	BaseURL  string `json:"baseUrl"`
}

// FetchProviderModels lists the models a provider advertises, without
// persisting anything -- the editor's "sync" button while composing a config
// that may not be saved yet.
func (h *Handler) FetchProviderModels(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req FetchModelsReq
	if !httpjson.Decode(w, r, &req) {
		return
	}

	if err := h.fillFromStoredConfig(r.Context(), &req); err != nil {
		httpjson.ServerError(w, err)
		return
	}

	models, err := listProviderModels(r.Context(), req.Provider, req.APIKey, req.BaseURL)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"models": models})
}

// SyncProviderModels re-lists a saved connection's models and persists the
// result, so the card's model list reflects the provider without a trip
// through the editor form.
func (h *Handler) SyncProviderModels(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httpjson.BadRequest(w, "id required")
		return
	}

	cfg, err := h.providerRepo.Get(r.Context(), id)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if cfg == nil {
		httpjson.NotFound(w, "provider config not found")
		return
	}

	models, err := listProviderModels(r.Context(), cfg.Provider, cfg.APIKey, cfg.BaseURL)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if len(models) == 0 {
		// Keep whatever is already stored: a gateway that lists nothing is
		// not the same as a gateway that serves nothing, and the models the
		// user typed in by hand may well still work.
		httpjson.BadRequest(w, "This provider did not advertise any models, so the existing list was kept. Add model IDs manually if the provider does not publish a catalog.")
		return
	}

	if err := h.providerRepo.SetModels(r.Context(), id, models); err != nil {
		httpjson.ServerError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"models": models})
}

// TestModelReq is the body of a model test.
type TestModelReq struct {
	Model string `json:"model"`
}

// ToolCallProbe reports whether the model actually emitted a tool call when
// handed one -- the thing that decides if a model is usable for this app's
// MCP/workflow/app-default tools at all, and the reason the test does more
// than echo a string.
type ToolCallProbe struct {
	Supported bool   `json:"supported"`
	Name      string `json:"name,omitempty"`
	Arguments string `json:"arguments,omitempty"`
	Error     string `json:"error,omitempty"`
}

// TestModelResult is the response of a model test.
type TestModelResult struct {
	OK        bool             `json:"ok"`
	Model     string           `json:"model"`
	Provider  string           `json:"provider"`
	LatencyMs int64            `json:"latencyMs"`
	Text      string           `json:"text"`
	Usage     *bifrostai.Usage `json:"usage,omitempty"`
	ToolCall  *ToolCallProbe   `json:"toolCall,omitempty"`
	Note      string           `json:"note,omitempty"`
	Error     string           `json:"error,omitempty"`
}

// probeToolSchema is the parameter schema of the throwaway tool the tool-call
// probe offers. Deliberately one required string: a model that can call tools
// at all will fill it, and one that can't will answer in prose instead.
var probeToolSchema = json.RawMessage(`{
	"type": "object",
	"properties": {
		"city": {"type": "string", "description": "The city to get weather for"}
	},
	"required": ["city"],
	"additionalProperties": false
}`)

// TestProviderModel runs a real round trip against one model of a saved
// connection: a streamed text completion (proving the key, base URL and model
// id all line up) followed by a tool-call probe.
func (h *Handler) TestProviderModel(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httpjson.BadRequest(w, "id required")
		return
	}

	var req TestModelReq
	if !httpjson.Decode(w, r, &req) {
		return
	}
	req.Model = strings.TrimSpace(req.Model)
	if req.Model == "" {
		httpjson.BadRequest(w, "model is required")
		return
	}

	cfg, err := h.providerRepo.Get(r.Context(), id)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if cfg == nil {
		httpjson.NotFound(w, "provider config not found")
		return
	}
	if cfg.APIKey == "" {
		httpjson.BadRequest(w, "this provider has no API key configured")
		return
	}

	// A model test is a user waiting on a spinner, not a chat turn: cap it
	// so an unreachable base URL fails the card instead of hanging it.
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	resolved := bifrostai.Resolve(id, req.Model)
	result := TestModelResult{Model: req.Model, Provider: cfg.Name}

	started := time.Now()
	step, err := h.engine.TestStep(
		ctx, resolved,
		"You are a connectivity test. Answer with as few words as possible.",
		[]bifrostai.Message{{Role: bifrostai.RoleUser, Text: `Reply with exactly this word and nothing else: OK`}},
		nil,
	)
	result.LatencyMs = time.Since(started).Milliseconds()

	if err != nil {
		result.Error = err.Error()
		writeJSON(w, result)
		return
	}

	// A reasoning model can spend the whole output cap thinking and return
	// no visible text. The round trip still proved the key, base URL and
	// model id line up, so this is a pass with a note -- not a failure.
	result.OK = true
	result.Text = strings.TrimSpace(step.Text)
	if result.Text == "" {
		result.Note = "Connected, but the model returned no visible text within the test's output limit -- typical of a reasoning model. It should still work in chat."
	}
	result.Usage = step.Usage
	result.ToolCall = h.probeToolCalling(ctx, resolved)

	writeJSON(w, result)
}

// probeToolCalling offers the model a single tool and a prompt that can only
// be answered by calling it.
func (h *Handler) probeToolCalling(ctx context.Context, resolved bifrostai.ResolvedModel) *ToolCallProbe {
	step, err := h.engine.TestStep(
		ctx, resolved,
		"You are a helpful assistant with access to tools. Use a tool when one fits.",
		[]bifrostai.Message{{Role: bifrostai.RoleUser, Text: "What is the weather in Tokyo right now?"}},
		[]bifrostai.ToolSpec{{
			Name:             "get_weather",
			Description:      "Get the current weather for a city.",
			ParametersSchema: probeToolSchema,
		}},
	)
	if err != nil {
		return &ToolCallProbe{Supported: false, Error: err.Error()}
	}
	if len(step.ToolCalls) == 0 {
		return &ToolCallProbe{
			Supported: false,
			Error:     "model answered without calling the offered tool",
		}
	}
	return &ToolCallProbe{
		Supported: true,
		Name:      step.ToolCalls[0].Name,
		Arguments: step.ToolCalls[0].Arguments,
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// fillFromStoredConfig backfills a models request from the saved config named
// by req.ID, for every field the caller left blank.
func (h *Handler) fillFromStoredConfig(ctx context.Context, req *FetchModelsReq) error {
	if req.ID == "" || h.providerRepo == nil {
		return nil
	}
	cfg, err := h.providerRepo.Get(ctx, req.ID)
	if err != nil || cfg == nil {
		return err
	}
	if req.APIKey == "" {
		req.APIKey = cfg.APIKey
	}
	if req.BaseURL == "" {
		req.BaseURL = cfg.BaseURL
	}
	if req.Provider == "" {
		req.Provider = cfg.Provider
	}
	return nil
}

// defaultBaseURL is each known provider type's own OpenAI-compatible model
// listing root. A type absent from this map (including "custom") has no
// default at all -- it only works with an explicit base URL, which is the
// honest answer for a gateway we know nothing about.
var defaultBaseURL = map[string]string{
	"openai":     "https://api.openai.com/v1",
	"groq":       "https://api.groq.com/openai/v1",
	"xai":        "https://api.x.ai/v1",
	"openRouter": "https://openrouter.ai/api/v1",
	"mistral":    "https://api.mistral.ai/v1",
	"ollama":     "http://localhost:11434/v1",
}

// listProviderModels asks a provider what models it serves. Anthropic and
// Google are special-cased because neither speaks the OpenAI /v1/models
// shape; everything else -- including every custom OpenAI-compatible gateway,
// which is the case that matters most here -- goes through the one path.
func listProviderModels(ctx context.Context, provider, apiKey, baseURL string) ([]string, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")

	if baseURL == "" {
		switch provider {
		case "anthropic":
			return listAnthropicModels(ctx, apiKey)
		case "google":
			return listGoogleModels(ctx, apiKey)
		}
		if def, ok := defaultBaseURL[provider]; ok {
			baseURL = def
		}
	}
	if baseURL == "" {
		return nil, fmt.Errorf("a base URL is required to list models for provider %q", provider)
	}

	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := getJSON(ctx, baseURL+"/models", map[string]string{
		"Authorization": "Bearer " + apiKey,
	}, &result); err != nil {
		return nil, err
	}

	models := make([]string, 0, len(result.Data))
	for _, m := range result.Data {
		// A LiteLLM virtual key with no model list configured answers
		// /v1/models with this single placeholder rather than an empty set.
		// Passing it through would let a sync overwrite a hand-entered,
		// working model list with one entry that routes nowhere.
		if m.ID == "" || m.ID == "no-default-models" {
			continue
		}
		models = append(models, m.ID)
	}
	sort.Strings(models)
	return models, nil
}

func listAnthropicModels(ctx context.Context, apiKey string) ([]string, error) {
	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := getJSON(ctx, "https://api.anthropic.com/v1/models?limit=100", map[string]string{
		"x-api-key":         apiKey,
		"anthropic-version": "2023-06-01",
	}, &result); err != nil {
		return nil, err
	}
	models := make([]string, 0, len(result.Data))
	for _, m := range result.Data {
		if m.ID != "" {
			models = append(models, m.ID)
		}
	}
	sort.Strings(models)
	return models, nil
}

func listGoogleModels(ctx context.Context, apiKey string) ([]string, error) {
	var result struct {
		Models []struct {
			Name                       string   `json:"name"`
			SupportedGenerationMethods []string `json:"supportedGenerationMethods"`
		} `json:"models"`
	}
	url := "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=" + apiKey
	if err := getJSON(ctx, url, nil, &result); err != nil {
		return nil, err
	}
	models := make([]string, 0, len(result.Models))
	for _, m := range result.Models {
		// The catalog also carries embedding/vision-only entries that would
		// 400 the moment someone picked one in the model selector.
		if !slicesContains(m.SupportedGenerationMethods, "generateContent") {
			continue
		}
		models = append(models, strings.TrimPrefix(m.Name, "models/"))
	}
	sort.Strings(models)
	return models, nil
}

func slicesContains(haystack []string, needle string) bool {
	for _, v := range haystack {
		if v == needle {
			return true
		}
	}
	return false
}

func getJSON(ctx context.Context, url string, headers map[string]string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	for k, v := range headers {
		if v != "" && !strings.HasSuffix(v, " ") {
			req.Header.Set(k, v)
		}
	}

	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("could not reach provider: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("provider returned %s for %s", resp.Status, redactURL(url))
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("provider returned a response we could not parse: %w", err)
	}
	return nil
}

// redactURL strips a query string before an upstream URL reaches an error
// message -- Google's model listing carries the API key there.
func redactURL(url string) string {
	if i := strings.IndexByte(url, '?'); i >= 0 {
		return url[:i]
	}
	return url
}
