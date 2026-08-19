package models_test

import (
	"encoding/json"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestModels_CatalogShapeReflectsConfiguredProviders verifies that GET /api/chat/models
// returns an empty list initially and reflects configured providers once added.
func TestModels_CatalogShapeReflectsConfiguredProviders(t *testing.T) {
	h := harness.New(t, harness.NoSeed())
	session, err := h.Client().Register(t.Context(), "admin", "admin@example.com", "Password123!")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	user := h.Client().As("admin", session.Token)

	initial, err := user.Models(t.Context())
	if err != nil {
		t.Fatalf("Models: %v", err)
	}

	var initialList []any
	if err := json.Unmarshal(initial, &initialList); err != nil {
		t.Fatalf("unmarshaling models list: %v", err)
	}
	if len(initialList) != 0 {
		t.Errorf("expected 0 configured provider models initially, got %d", len(initialList))
	}

	// Configure an AI provider
	saved, err := user.SaveProvider(t.Context(), apiclient.ProviderInput{
		Name:     "Anthropic",
		Provider: "anthropic",
		APIKey:   "sk-ant-test-key",
		Models:   []string{"claude-3-5-sonnet-20241022"},
	})
	if err != nil {
		t.Fatalf("SaveProvider: %v", err)
	}

	after, err := user.Models(t.Context())
	if err != nil {
		t.Fatalf("Models after save: %v", err)
	}

	var afterList []map[string]any
	if err := json.Unmarshal(after, &afterList); err != nil {
		t.Fatalf("unmarshaling models list: %v", err)
	}
	if len(afterList) == 0 {
		t.Error("expected configured provider models to appear in /api/chat/models")
	}

	// Clean up
	_ = user.DeleteProvider(t.Context(), saved.ID)
}

// TestModels_EndpointReachableWithoutSession verifies /api/chat/models is accessible anonymously.
func TestModels_EndpointReachableWithoutSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()

	modelsRaw, err := anon.Models(t.Context())
	if err != nil {
		t.Fatalf("anonymous Models: %v", err)
	}
	if len(modelsRaw) == 0 {
		t.Error("expected non-empty JSON response from /api/chat/models")
	}
}
