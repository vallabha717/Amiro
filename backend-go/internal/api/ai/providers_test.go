package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestListProviderModels_ReadsAnOpenAICompatibleCatalog(t *testing.T) {
	var gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"data":[{"id":"gpt-5.6-luna"},{"id":"claude-opus-4-8"}]}`))
	}))
	defer srv.Close()

	models, err := listProviderModels(context.Background(), "openai", "sk-test", srv.URL+"/v1")
	if err != nil {
		t.Fatalf("listProviderModels: %v", err)
	}
	if gotPath != "/v1/models" {
		t.Fatalf("path = %q, want the base URL with /models appended", gotPath)
	}
	if gotAuth != "Bearer sk-test" {
		t.Fatalf("Authorization = %q, want a bearer token", gotAuth)
	}
	// Sorted so the editor's list is stable across syncs.
	if len(models) != 2 || models[0] != "claude-opus-4-8" || models[1] != "gpt-5.6-luna" {
		t.Fatalf("models = %v, want both ids sorted", models)
	}
}

// A LiteLLM virtual key with no model list configured answers /v1/models
// with this one placeholder. Letting it through would overwrite a working,
// hand-entered model list with an id that routes nowhere.
func TestListProviderModels_DropsLiteLLMsNoDefaultModelsPlaceholder(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"no-default-models"}]}`))
	}))
	defer srv.Close()

	models, err := listProviderModels(context.Background(), "openai", "sk-test", srv.URL+"/v1")
	if err != nil {
		t.Fatalf("listProviderModels: %v", err)
	}
	if len(models) != 0 {
		t.Fatalf("models = %v, want none so the caller keeps what it already had", models)
	}
}

func TestListProviderModels_TrailingSlashOnTheBaseURLDoesNotDoubleUp(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"data":[{"id":"a"}]}`))
	}))
	defer srv.Close()

	if _, err := listProviderModels(context.Background(), "openai", "k", srv.URL+"/v1/"); err != nil {
		t.Fatalf("listProviderModels: %v", err)
	}
	if gotPath != "/v1/models" {
		t.Fatalf("path = %q, want /v1/models", gotPath)
	}
}

func TestListProviderModels_SurfacesAnUpstreamFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	_, err := listProviderModels(context.Background(), "openai", "bad-key", srv.URL+"/v1")
	if err == nil {
		t.Fatalf("want an error when the provider rejects the key")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("error = %q, want it to name the upstream status", err)
	}
}

// An unknown provider type with no base URL has nowhere to ask, and saying
// so beats silently probing api.openai.com with someone else's key.
func TestListProviderModels_UnknownProviderWithoutABaseURLIsAnError(t *testing.T) {
	_, err := listProviderModels(context.Background(), "custom-gateway", "k", "")
	if err == nil {
		t.Fatalf("want an error when neither a base URL nor a known default exists")
	}
}

func TestRedactURL_StripsTheQueryStringThatCarriesGooglesKey(t *testing.T) {
	got := redactURL("https://generativelanguage.googleapis.com/v1beta/models?key=secret")
	if strings.Contains(got, "secret") {
		t.Fatalf("redactURL leaked the key: %q", got)
	}
}

func TestProbeToolSchemaIsValidJSON(t *testing.T) {
	var schema map[string]any
	if err := json.Unmarshal(probeToolSchema, &schema); err != nil {
		t.Fatalf("probe tool schema is not valid JSON: %v", err)
	}
	if schema["type"] != "object" {
		t.Fatalf("probe tool schema type = %v, want object", schema["type"])
	}
}
