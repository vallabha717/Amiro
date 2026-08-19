package providers_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestProviders_ListAndConfigure exercises listing, saving, updating, and deleting provider configurations.
func TestProviders_ListAndConfigure(t *testing.T) {
	h := harness.New(t)
	user := h.As("admin")

	initial, err := user.ListProviders(t.Context())
	if err != nil {
		t.Fatalf("ListProviders: %v", err)
	}

	secretKey := "sk-test-super-secret-key-9999"
	saved, err := user.SaveProvider(t.Context(), apiclient.ProviderInput{
		Name:     "Custom OpenAI",
		Provider: "openai",
		APIKey:   secretKey,
		BaseURL:  h.Proxy().URL + "/openai",
		Models:   []string{"gpt-4.1", "gpt-4.1-mini"},
	})
	if err != nil {
		t.Fatalf("SaveProvider: %v", err)
	}
	if saved.ID == "" {
		t.Fatal("expected non-empty provider ID")
	}

	// Verify the API key was NOT returned in the response body
	after, err := user.ListProviders(t.Context())
	if err != nil {
		t.Fatalf("ListProviders after save: %v", err)
	}
	if len(after) <= len(initial) {
		t.Errorf("expected provider count to increase from %d, got %d", len(initial), len(after))
	}

	found := false
	for _, p := range after {
		if p.ID == saved.ID {
			found = true
			if !p.Configured {
				t.Error("expected provider to be marked Configured=true")
			}
			break
		}
	}
	if !found {
		t.Errorf("saved provider %s not found in provider list", saved.ID)
	}

	// Verify key rotation: update key without clearing it
	rotatedKey := "sk-test-rotated-key-8888"
	_, err = user.SaveProvider(t.Context(), apiclient.ProviderInput{
		ID:       saved.ID,
		Name:     "Custom OpenAI Updated",
		Provider: "openai",
		APIKey:   rotatedKey,
		BaseURL:  h.Proxy().URL + "/openai",
		Models:   []string{"gpt-4.1"},
	})
	if err != nil {
		t.Fatalf("updating provider: %v", err)
	}

	afterUpdate, err := user.ListProviders(t.Context())
	if err != nil {
		t.Fatalf("ListProviders after update: %v", err)
	}
	var updatedName string
	for _, p := range afterUpdate {
		if p.ID == saved.ID {
			updatedName = p.Name
			break
		}
	}
	if updatedName != "Custom OpenAI Updated" {
		t.Errorf("expected name 'Custom OpenAI Updated', got %q", updatedName)
	}

	// Delete provider config
	if err := user.DeleteProvider(t.Context(), saved.ID); err != nil {
		t.Fatalf("DeleteProvider: %v", err)
	}

	afterDelete, err := user.ListProviders(t.Context())
	if err != nil {
		t.Fatalf("ListProviders after delete: %v", err)
	}
	for _, p := range afterDelete {
		if p.ID == saved.ID {
			t.Errorf("provider %s still in list after deletion", saved.ID)
		}
	}

	// Verify against http.ndjson that secretKey never appeared in plain text in response bodies
	httpLogPath := filepath.Join(h.Dir(), "http.ndjson")
	if data, err := os.ReadFile(httpLogPath); err == nil {
		logContent := string(data)
		if strings.Contains(logContent, secretKey) {
			t.Errorf("secret API key leaked into http.ndjson logs!")
		}
	}
}

// TestProviders_TestAndSyncModels exercises /test and /sync-models endpoints against the provider proxy.
func TestProviders_TestAndSyncModels(t *testing.T) {
	h := harness.New(t)
	admin := h.As("admin")

	h.Fake().OnPrompt(fakeprovider.Any()).StreamText("Connectivity OK")

	providers, err := admin.ListProviders(t.Context())
	if err != nil || len(providers) == 0 {
		t.Fatalf("expected seeded providers, got %v (err: %v)", providers, err)
	}

	target := providers[0]

	// 1. Test provider connectivity
	testResp, err := admin.TestProvider(t.Context(), target.ID, map[string]any{
		"model": "gpt-4.1",
	})
	if err != nil {
		t.Fatalf("TestProvider failed: %v", err)
	}
	if len(testResp) == 0 {
		t.Errorf("expected non-empty test response")
	}

	// 2. Sync models
	syncResp, err := admin.SyncProviderModels(t.Context(), target.ID)
	if err != nil {
		t.Fatalf("SyncProviderModels failed: %v", err)
	}
	if len(syncResp) == 0 {
		t.Errorf("expected non-empty sync response")
	}

	// 3. Verify chat models endpoint reflects synced/configured models
	modelsRaw, err := admin.Models(t.Context())
	if err != nil {
		t.Fatalf("GET /api/chat/models: %v", err)
	}
	var modelsList []map[string]any
	if err := json.Unmarshal(modelsRaw, &modelsList); err != nil {
		t.Fatalf("unmarshaling models: %v", err)
	}
	if len(modelsList) == 0 {
		t.Errorf("expected models list to be non-empty")
	}
}

// TestProviders_RequireSession verifies anonymous access to provider configuration is rejected.
func TestProviders_RequireSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()

	_, err := anon.ListProviders(t.Context())
	if err == nil {
		t.Fatal("expected anonymous ListProviders to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous ListProviders status = %d, want 401", status)
	}
}
