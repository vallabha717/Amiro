package search_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestSearch_ActiveReachableByPlainUser verifies that any signed-in user can check active search.
func TestSearch_ActiveReachableByPlainUser(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	active, err := user.ActiveSearch(t.Context())
	if err != nil {
		t.Fatalf("ActiveSearch: %v", err)
	}
	if len(active) == 0 {
		t.Error("expected non-empty JSON from ActiveSearch")
	}
}

// TestSearch_AdminGatedEndpointsDenyPlainUsers asserts plain users receive 403 on admin-only search endpoints.
func TestSearch_AdminGatedEndpointsDenyPlainUsers(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	dummyID := "tavily"

	_, err := user.SearchCatalog(t.Context())
	if err == nil {
		t.Fatal("expected plain user SearchCatalog to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("plain user SearchCatalog status = %d, want 403", status)
	}

	_, err = user.ListSearchProviders(t.Context())
	if err == nil {
		t.Fatal("expected plain user ListSearchProviders to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("plain user ListSearchProviders status = %d, want 403", status)
	}

	_, err = user.SaveSearchProvider(t.Context(), map[string]any{"provider": "tavily", "apiKey": "test"})
	if err == nil {
		t.Fatal("expected plain user SaveSearchProvider to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("plain user SaveSearchProvider status = %d, want 403", status)
	}

	err = user.ActivateSearchProvider(t.Context(), dummyID)
	if err == nil {
		t.Fatal("expected plain user ActivateSearchProvider to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("plain user ActivateSearchProvider status = %d, want 403", status)
	}

	err = user.DeleteSearchProvider(t.Context(), dummyID)
	if err == nil {
		t.Fatal("expected plain user DeleteSearchProvider to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("plain user DeleteSearchProvider status = %d, want 403", status)
	}
}

// TestSearch_AdminLifecycle exercises admin catalog, listing, saving, activating, and deleting search providers.
func TestSearch_AdminLifecycle(t *testing.T) {
	h := harness.New(t)
	admin := h.As("admin")

	// Get catalog
	cat, err := admin.SearchCatalog(t.Context())
	if err != nil {
		t.Fatalf("SearchCatalog (admin): %v", err)
	}
	if len(cat) == 0 {
		t.Error("expected non-empty search catalog JSON")
	}

	// List statuses (initially empty)
	statuses, err := admin.ListSearchProviders(t.Context())
	if err != nil {
		t.Fatalf("ListSearchProviders (admin): %v", err)
	}
	if len(statuses) != 0 {
		t.Errorf("expected 0 configured search providers initially, got %d", len(statuses))
	}

	// Save provider config
	saved, err := admin.SaveSearchProvider(t.Context(), map[string]any{
		"provider": "tavily",
		"name":     "Tavily Search",
		"apiKey":   "tvly-test-api-key-12345",
	})
	if err != nil {
		t.Fatalf("SaveSearchProvider: %v", err)
	}
	if saved.ID == "" {
		t.Fatal("expected non-empty search provider ID")
	}

	// Activate provider
	if err := admin.ActivateSearchProvider(t.Context(), saved.ID); err != nil {
		t.Fatalf("ActivateSearchProvider: %v", err)
	}

	// Delete provider config
	if err := admin.DeleteSearchProvider(t.Context(), saved.ID); err != nil {
		t.Fatalf("DeleteSearchProvider: %v", err)
	}
}

// TestSearch_RequireSession verifies anonymous access is rejected with 401.
func TestSearch_RequireSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()

	_, err := anon.ActiveSearch(t.Context())
	if err == nil {
		t.Fatal("expected anonymous ActiveSearch to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous ActiveSearch status = %d, want 401", status)
	}
}
