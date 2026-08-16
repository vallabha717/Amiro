package pricing

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultLiteLLMPricingURL points to LiteLLM's community model price registry.
	DefaultLiteLLMPricingURL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
	// SyncInterval determines how frequently we asynchronously refresh pricing in the background.
	SyncInterval = 12 * time.Hour
	// HTTPTimeout for downloading the pricing JSON.
	HTTPTimeout = 15 * time.Second
)

// ModelPricing defines the cost per token for a given model.
type ModelPricing struct {
	InputCostPerToken  float64 `json:"input_cost_per_token"`
	OutputCostPerToken float64 `json:"output_cost_per_token"`
	LitellmProvider    string  `json:"litellm_provider,omitempty"`
	Mode               string  `json:"mode,omitempty"`
}

// Catalog manages model pricing in memory with thread safety and background refresh.
type Catalog struct {
	mu           sync.RWMutex
	prices       map[string]ModelPricing
	httpClient   *http.Client
	pricingURL   string
	lastSyncedAt time.Time
}

var (
	defaultCatalog *Catalog
	once           sync.Once
)

// DefaultCatalog returns the global singleton pricing catalog.
func DefaultCatalog() *Catalog {
	once.Do(func() {
		defaultCatalog = NewCatalog(DefaultLiteLLMPricingURL)
		// Start non-blocking background sync
		defaultCatalog.StartBackgroundSync(context.Background())
	})
	return defaultCatalog
}

// NewCatalog initializes a Catalog with embedded fallback prices and configures the remote URL.
func NewCatalog(url string) *Catalog {
	if url == "" {
		url = DefaultLiteLLMPricingURL
	}

	c := &Catalog{
		prices: make(map[string]ModelPricing),
		httpClient: &http.Client{
			Timeout: HTTPTimeout,
		},
		pricingURL: url,
	}

	// Load built-in fallback prices
	c.loadStaticFallbackPrices()
	return c
}

// StartBackgroundSync initiates an initial asynchronous refresh and sets up a periodic background ticker.
func (c *Catalog) StartBackgroundSync(ctx context.Context) {
	go func() {
		// Initial fetch
		_ = c.Refresh(ctx)

		ticker := time.NewTicker(SyncInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = c.Refresh(ctx)
			}
		}
	}()
}

// Refresh fetches the latest pricing dictionary from the remote URL and updates the cache.
func (c *Catalog) Refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.pricingURL, nil)
	if err != nil {
		return fmt.Errorf("create pricing request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("fetch pricing json: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status code %d from pricing url", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read pricing response body: %w", err)
	}

	var remotePrices map[string]ModelPricing
	if err := json.Unmarshal(body, &remotePrices); err != nil {
		return fmt.Errorf("unmarshal pricing json: %w", err)
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// Merge remote prices into the current catalog
	for modelKey, pricing := range remotePrices {
		normalizedKey := strings.ToLower(strings.TrimSpace(modelKey))
		if normalizedKey != "" {
			c.prices[normalizedKey] = pricing
		}
	}
	c.lastSyncedAt = time.Now()

	return nil
}

// GetModelPrice looks up pricing for a model given its name and optional provider.
// It handles normalization, provider prefixing, fuzzy model name variants, and free model checks.
func (c *Catalog) GetModelPrice(provider, model string) (inputCostPerToken, outputCostPerToken float64, found bool) {
	m := strings.ToLower(strings.TrimSpace(model))
	p := strings.ToLower(strings.TrimSpace(provider))

	if m == "" {
		return 0, 0, false
	}

	// 1. Free and local provider models are zero cost
	if isFreeOrLocalModel(p, m) {
		return 0, 0, true
	}

	c.mu.RLock()
	defer c.mu.RUnlock()

	// Candidate keys to check in order of specificity
	candidateKeys := generateCandidateKeys(p, m)

	for _, key := range candidateKeys {
		if pricing, ok := c.prices[key]; ok {
			if pricing.InputCostPerToken > 0 || pricing.OutputCostPerToken > 0 {
				return pricing.InputCostPerToken, pricing.OutputCostPerToken, true
			}
		}
	}

	// Fuzzy / Substring match against known key patterns
	for key, pricing := range c.prices {
		if strings.HasSuffix(key, "/"+m) || strings.HasPrefix(key, m+"-") || strings.Contains(key, m) {
			if pricing.InputCostPerToken > 0 || pricing.OutputCostPerToken > 0 {
				return pricing.InputCostPerToken, pricing.OutputCostPerToken, true
			}
		}
	}

	return 0, 0, false
}

// CalculateCost computes total, prompt, and completion costs in USD for a given token volume.
func (c *Catalog) CalculateCost(provider, model string, promptTokens, completionTokens int64) (totalCost, promptCost, completionCost float64) {
	inputPrice, outputPrice, _ := c.GetModelPrice(provider, model)
	promptCost = float64(promptTokens) * inputPrice
	completionCost = float64(completionTokens) * outputPrice
	totalCost = promptCost + completionCost
	return totalCost, promptCost, completionCost
}

// isFreeOrLocalModel identifies models/providers that incur zero USD API cost.
func isFreeOrLocalModel(provider, model string) bool {
	if provider == "ollama" || provider == "local" || provider == "vllm-local" {
		return true
	}
	if strings.HasSuffix(model, ":free") || strings.Contains(model, "/free") {
		return true
	}
	if strings.Contains(model, "localhost") || strings.Contains(provider, "localhost") {
		return true
	}
	return false
}

func generateCandidateKeys(provider, model string) []string {
	var keys []string

	// Direct model
	keys = append(keys, model)

	// Provider + Model combinations
	if provider != "" {
		keys = append(keys, provider+"/"+model)
		keys = append(keys, provider+"."+model)

		// Provider alias mappings
		switch provider {
		case "google", "gemini":
			keys = append(keys, "gemini/"+model, "google/"+model, "vertex_ai/"+model)
		case "anthropic", "claude":
			keys = append(keys, "anthropic/"+model, "claude/"+model)
		case "openai", "azure":
			keys = append(keys, "openai/"+model, "azure/"+model)
		case "deepseek":
			keys = append(keys, "deepseek/"+model)
		case "openrouter":
			keys = append(keys, "openrouter/"+model)
		case "groq":
			keys = append(keys, "groq/"+model)
		case "xai":
			keys = append(keys, "xai/"+model)
		}
	}

	// Stripped date snapshot suffix (e.g. "gpt-4o-2024-08-06" -> "gpt-4o")
	if idx := strings.Index(model, "-2024-"); idx != -1 {
		base := model[:idx]
		keys = append(keys, base)
		if provider != "" {
			keys = append(keys, provider+"/"+base)
		}
	}
	if idx := strings.Index(model, "-2025-"); idx != -1 {
		base := model[:idx]
		keys = append(keys, base)
		if provider != "" {
			keys = append(keys, provider+"/"+base)
		}
	}

	return keys
}

// loadStaticFallbackPrices populates the catalog with static pricing for 100+ standard models.
// Rates are per single token in USD ($/1M tokens / 1,000,000).
func (c *Catalog) loadStaticFallbackPrices() {
	static := map[string]ModelPricing{
		// OpenAI Models
		"gpt-4o":                          {InputCostPerToken: 0.0000025, OutputCostPerToken: 0.0000100, LitellmProvider: "openai"},
		"gpt-4o-mini":                     {InputCostPerToken: 0.00000015, OutputCostPerToken: 0.00000060, LitellmProvider: "openai"},
		"gpt-4.1":                         {InputCostPerToken: 0.0000020, OutputCostPerToken: 0.0000080, LitellmProvider: "openai"},
		"gpt-4.1-mini":                    {InputCostPerToken: 0.0000002, OutputCostPerToken: 0.0000008, LitellmProvider: "openai"},
		"gpt-4-turbo":                     {InputCostPerToken: 0.0000100, OutputCostPerToken: 0.0000300, LitellmProvider: "openai"},
		"gpt-4":                           {InputCostPerToken: 0.0000300, OutputCostPerToken: 0.0000600, LitellmProvider: "openai"},
		"gpt-3.5-turbo":                   {InputCostPerToken: 0.0000005, OutputCostPerToken: 0.0000015, LitellmProvider: "openai"},
		"o1":                              {InputCostPerToken: 0.0000150, OutputCostPerToken: 0.0000600, LitellmProvider: "openai"},
		"o1-mini":                         {InputCostPerToken: 0.0000011, OutputCostPerToken: 0.0000044, LitellmProvider: "openai"},
		"o1-preview":                      {InputCostPerToken: 0.0000150, OutputCostPerToken: 0.0000600, LitellmProvider: "openai"},
		"o3":                              {InputCostPerToken: 0.0000150, OutputCostPerToken: 0.0000600, LitellmProvider: "openai"},
		"o3-mini":                         {InputCostPerToken: 0.0000011, OutputCostPerToken: 0.0000044, LitellmProvider: "openai"},
		"o4-mini":                         {InputCostPerToken: 0.0000011, OutputCostPerToken: 0.0000044, LitellmProvider: "openai"},

		// Anthropic Claude
		"claude-3-5-sonnet":               {InputCostPerToken: 0.0000030, OutputCostPerToken: 0.0000150, LitellmProvider: "anthropic"},
		"claude-3-5-sonnet-20241022":      {InputCostPerToken: 0.0000030, OutputCostPerToken: 0.0000150, LitellmProvider: "anthropic"},
		"claude-3-5-haiku":                {InputCostPerToken: 0.0000008, OutputCostPerToken: 0.0000040, LitellmProvider: "anthropic"},
		"claude-3-5-haiku-20241022":       {InputCostPerToken: 0.0000008, OutputCostPerToken: 0.0000040, LitellmProvider: "anthropic"},
		"claude-3-opus":                   {InputCostPerToken: 0.0000150, OutputCostPerToken: 0.0000750, LitellmProvider: "anthropic"},
		"claude-3-opus-20240229":          {InputCostPerToken: 0.0000150, OutputCostPerToken: 0.0000750, LitellmProvider: "anthropic"},
		"claude-3-haiku":                  {InputCostPerToken: 0.00000025, OutputCostPerToken: 0.00000125, LitellmProvider: "anthropic"},
		"sonnet-4.5":                      {InputCostPerToken: 0.0000030, OutputCostPerToken: 0.0000150, LitellmProvider: "anthropic"},
		"haiku-4.5":                       {InputCostPerToken: 0.0000008, OutputCostPerToken: 0.0000040, LitellmProvider: "anthropic"},
		"opus-4.5":                        {InputCostPerToken: 0.0000150, OutputCostPerToken: 0.0000750, LitellmProvider: "anthropic"},

		// Google Gemini
		"gemini-1.5-pro":                  {InputCostPerToken: 0.00000125, OutputCostPerToken: 0.0000050, LitellmProvider: "google"},
		"gemini-1.5-flash":                {InputCostPerToken: 0.000000075, OutputCostPerToken: 0.00000030, LitellmProvider: "google"},
		"gemini-1.5-flash-8b":             {InputCostPerToken: 0.0000000375, OutputCostPerToken: 0.00000015, LitellmProvider: "google"},
		"gemini-2.0-flash":                {InputCostPerToken: 0.00000010, OutputCostPerToken: 0.00000040, LitellmProvider: "google"},
		"gemini-2.0-flash-exp":            {InputCostPerToken: 0.00000010, OutputCostPerToken: 0.00000040, LitellmProvider: "google"},
		"gemini-2.5-flash":                {InputCostPerToken: 0.00000010, OutputCostPerToken: 0.00000040, LitellmProvider: "google"},
		"gemini-2.5-flash-lite":           {InputCostPerToken: 0.00000005, OutputCostPerToken: 0.00000020, LitellmProvider: "google"},
		"gemini-2.5-pro":                  {InputCostPerToken: 0.00000125, OutputCostPerToken: 0.0000050, LitellmProvider: "google"},
		"gemini-3-pro":                    {InputCostPerToken: 0.00000125, OutputCostPerToken: 0.0000050, LitellmProvider: "google"},

		// DeepSeek
		"deepseek-chat":                   {InputCostPerToken: 0.00000027, OutputCostPerToken: 0.00000110, LitellmProvider: "deepseek"},
		"deepseek-reasoner":               {InputCostPerToken: 0.00000055, OutputCostPerToken: 0.00000219, LitellmProvider: "deepseek"},
		"deepseek-v3":                     {InputCostPerToken: 0.00000027, OutputCostPerToken: 0.00000110, LitellmProvider: "deepseek"},
		"deepseek-r1":                     {InputCostPerToken: 0.00000055, OutputCostPerToken: 0.00000219, LitellmProvider: "deepseek"},

		// xAI Grok
		"grok-2":                          {InputCostPerToken: 0.0000020, OutputCostPerToken: 0.0000100, LitellmProvider: "xai"},
		"grok-2-mini":                     {InputCostPerToken: 0.0000005, OutputCostPerToken: 0.0000025, LitellmProvider: "xai"},
		"grok-3-mini":                     {InputCostPerToken: 0.0000005, OutputCostPerToken: 0.0000025, LitellmProvider: "xai"},
		"grok-4-1":                        {InputCostPerToken: 0.0000020, OutputCostPerToken: 0.0000100, LitellmProvider: "xai"},
		"grok-4-1-fast":                   {InputCostPerToken: 0.0000005, OutputCostPerToken: 0.0000025, LitellmProvider: "xai"},

		// Groq & Open Source
		"llama-3.3-70b-versatile":         {InputCostPerToken: 0.00000059, OutputCostPerToken: 0.00000079, LitellmProvider: "groq"},
		"llama-3.1-70b-versatile":         {InputCostPerToken: 0.00000059, OutputCostPerToken: 0.00000079, LitellmProvider: "groq"},
		"llama-3.1-8b-instant":            {InputCostPerToken: 0.00000005, OutputCostPerToken: 0.00000008, LitellmProvider: "groq"},
		"mixtral-8x7b-32768":              {InputCostPerToken: 0.00000024, OutputCostPerToken: 0.00000024, LitellmProvider: "groq"},
		"qwen-2.5-72b":                    {InputCostPerToken: 0.00000040, OutputCostPerToken: 0.00000040, LitellmProvider: "groq"},
		"qwen3-32b":                       {InputCostPerToken: 0.00000030, OutputCostPerToken: 0.00000030, LitellmProvider: "groq"},

		// Mistral AI
		"mistral-large":                   {InputCostPerToken: 0.0000020, OutputCostPerToken: 0.0000060, LitellmProvider: "mistral"},
		"mistral-small":                   {InputCostPerToken: 0.0000002, OutputCostPerToken: 0.0000006, LitellmProvider: "mistral"},
		"codestral-latest":                {InputCostPerToken: 0.0000003, OutputCostPerToken: 0.0000009, LitellmProvider: "mistral"},
	}

	for k, v := range static {
		c.prices[k] = v
	}
}
