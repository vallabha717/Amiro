package cassette

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// ModelCostRates defines prompt and completion pricing per 1M tokens in USD.
type ModelCostRates struct {
	PromptUSDPerMillion     float64
	CompletionUSDPerMillion float64
}

var defaultPricing = map[string]ModelCostRates{
	"gpt-4.1":           {PromptUSDPerMillion: 2.50, CompletionUSDPerMillion: 10.00},
	"gpt-4.1-mini":      {PromptUSDPerMillion: 0.15, CompletionUSDPerMillion: 0.60},
	"claude-sonnet-4-5": {PromptUSDPerMillion: 3.00, CompletionUSDPerMillion: 15.00},
	"claude-haiku-4-5":  {PromptUSDPerMillion: 0.80, CompletionUSDPerMillion: 4.00},
}

// CostReport is the schema written to providers/cost.json.
type CostReport struct {
	Mode             string  `json:"mode"`
	TotalTokens      int     `json:"totalTokens"`
	PromptTokens     int     `json:"promptTokens"`
	CompletionTokens int     `json:"completionTokens"`
	EstimatedCostUSD float64 `json:"estimatedCostUsd"`
}

// CostTracker accumulates token spend and writes cost.json reports.
type CostTracker struct {
	mu               sync.Mutex
	mode             string
	promptTokens     int
	completionTokens int
	totalTokens      int
	costUSD          float64
}

// NewCostTracker initializes a tracker for the given provider mode.
func NewCostTracker(mode string) *CostTracker {
	return &CostTracker{mode: mode}
}

// RecordUsage records tokens used by a model call.
func (c *CostTracker) RecordUsage(model string, promptTokens, completionTokens int) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.promptTokens += promptTokens
	c.completionTokens += completionTokens
	c.totalTokens += (promptTokens + completionTokens)

	if c.mode == "live" || c.mode == "record" {
		rates, ok := defaultPricing[model]
		if !ok {
			rates = ModelCostRates{PromptUSDPerMillion: 3.00, CompletionUSDPerMillion: 15.00}
		}
		c.costUSD += (float64(promptTokens) * rates.PromptUSDPerMillion / 1e6) +
			(float64(completionTokens) * rates.CompletionUSDPerMillion / 1e6)
	} else {
		// replay and fake are guaranteed 0.00 USD
		c.costUSD = 0.00
	}
}

// Report generates the current CostReport.
func (c *CostTracker) Report() CostReport {
	c.mu.Lock()
	defer c.mu.Unlock()

	return CostReport{
		Mode:             c.mode,
		TotalTokens:      c.totalTokens,
		PromptTokens:     c.promptTokens,
		CompletionTokens: c.completionTokens,
		EstimatedCostUSD: c.costUSD,
	}
}

// WriteJSON saves the cost report to targetPath (e.g. <dir>/providers/cost.json).
func (c *CostTracker) WriteJSON(targetPath string) error {
	rep := c.Report()
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(rep, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(targetPath, b, 0644)
}
