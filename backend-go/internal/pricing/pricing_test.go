package pricing

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPricing_GetModelPrice_StandardModels(t *testing.T) {
	c := NewCatalog("")

	tests := []struct {
		provider       string
		model          string
		wantInMin      float64
		wantOutMin     float64
		expectFound    bool
	}{
		{"openai", "gpt-4o", 0.000001, 0.000005, true},
		{"openai", "gpt-4o-mini", 0.00000005, 0.0000002, true},
		{"anthropic", "claude-3-5-sonnet", 0.000001, 0.00001, true},
		{"anthropic", "claude-3-5-haiku", 0.0000005, 0.000002, true},
		{"google", "gemini-1.5-flash", 0.00000001, 0.0000001, true},
		{"google", "gemini-2.0-flash", 0.00000005, 0.0000002, true},
		{"deepseek", "deepseek-chat", 0.0000001, 0.0000005, true},
		{"deepseek", "deepseek-r1", 0.0000002, 0.000001, true},
		{"groq", "llama-3.3-70b-versatile", 0.0000002, 0.0000004, true},
	}

	for _, tt := range tests {
		inPrice, outPrice, found := c.GetModelPrice(tt.provider, tt.model)
		if found != tt.expectFound {
			t.Errorf("GetModelPrice(%q, %q) found = %v, want %v", tt.provider, tt.model, found, tt.expectFound)
		}
		if inPrice < tt.wantInMin {
			t.Errorf("GetModelPrice(%q, %q) inPrice = %v, want >= %v", tt.provider, tt.model, inPrice, tt.wantInMin)
		}
		if outPrice < tt.wantOutMin {
			t.Errorf("GetModelPrice(%q, %q) outPrice = %v, want >= %v", tt.provider, tt.model, outPrice, tt.wantOutMin)
		}
	}
}

func TestPricing_FuzzyMatchingAndVariants(t *testing.T) {
	c := NewCatalog("")

	// Date snapshot variant
	inPrice, outPrice, found := c.GetModelPrice("openai", "gpt-4o-2024-08-06")
	if !found || inPrice == 0 || outPrice == 0 {
		t.Fatalf("expected gpt-4o-2024-08-06 to resolve to gpt-4o price, got in=%v out=%v found=%v", inPrice, outPrice, found)
	}

	// Provider prefix variant
	inPrice2, _, found2 := c.GetModelPrice("google", "gemini-1.5-pro")
	if !found2 || inPrice2 == 0 {
		t.Fatalf("expected gemini-1.5-pro to resolve, got in=%v found=%v", inPrice2, found2)
	}
}

func TestPricing_FreeAndOllamaModels(t *testing.T) {
	c := NewCatalog("")

	// Ollama model
	inPrice, outPrice, found := c.GetModelPrice("ollama", "llama3:latest")
	if !found || inPrice != 0 || outPrice != 0 {
		t.Errorf("expected ollama to be free (0.0), got in=%v, out=%v, found=%v", inPrice, outPrice, found)
	}

	// OpenRouter :free model
	inPrice2, outPrice2, found2 := c.GetModelPrice("openrouter", "deepseek/deepseek-r1:free")
	if !found2 || inPrice2 != 0 || outPrice2 != 0 {
		t.Errorf("expected :free model to be 0.0, got in=%v, out=%v, found=%v", inPrice2, outPrice2, found2)
	}
}

func TestPricing_CalculateCost(t *testing.T) {
	c := NewCatalog("")

	// 1,000,000 input tokens + 1,000,000 output tokens on gpt-4o
	// gpt-4o: $2.50 / 1M input, $10.00 / 1M output
	totalCost, promptCost, completionCost := c.CalculateCost("openai", "gpt-4o", 1_000_000, 1_000_000)

	expectedPrompt := 2.50
	expectedCompletion := 10.00
	expectedTotal := 12.50

	diff := func(a, b float64) float64 {
		if a > b {
			return a - b
		}
		return b - a
	}

	if diff(promptCost, expectedPrompt) > 0.001 {
		t.Errorf("promptCost = %v, want %v", promptCost, expectedPrompt)
	}
	if diff(completionCost, expectedCompletion) > 0.001 {
		t.Errorf("completionCost = %v, want %v", completionCost, expectedCompletion)
	}
	if diff(totalCost, expectedTotal) > 0.001 {
		t.Errorf("totalCost = %v, want %v", totalCost, expectedTotal)
	}
}

func TestPricing_RefreshFromRemote(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{
			"custom-mock-model": {
				"input_cost_per_token": 0.000005,
				"output_cost_per_token": 0.000020,
				"litellm_provider": "custom"
			}
		}`))
	}))
	defer ts.Close()

	c := NewCatalog(ts.URL)
	err := c.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh failed: %v", err)
	}

	inPrice, outPrice, found := c.GetModelPrice("custom", "custom-mock-model")
	if !found {
		t.Fatalf("expected custom-mock-model to be found after refresh")
	}
	if inPrice != 0.000005 || outPrice != 0.000020 {
		t.Errorf("got in=%v out=%v, want 0.000005 and 0.000020", inPrice, outPrice)
	}
}
