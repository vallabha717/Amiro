package bifrostai

import (
	"context"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
)

func TestLoadOpenAICompatibleProviders_EmptyEnvReturnsNil(t *testing.T) {
	t.Setenv("OPENAI_COMPATIBLE_DATA", "")
	if got := loadOpenAICompatibleProviders(); got != nil {
		t.Fatalf("got %+v, want nil", got)
	}
}

func TestLoadOpenAICompatibleProviders_InvalidJSONReturnsNil(t *testing.T) {
	t.Setenv("OPENAI_COMPATIBLE_DATA", "not valid json")
	if got := loadOpenAICompatibleProviders(); got != nil {
		t.Fatalf("got %+v, want nil", got)
	}
}

func TestLoadOpenAICompatibleProviders_ValidEntryParsesIntoProviderEntry(t *testing.T) {
	t.Setenv("OPENAI_COMPATIBLE_DATA", `[{
		"provider": "Modal",
		"baseUrl": "https://example.modal.direct/v1",
		"models": [{"apiName": "org/Model-Name", "uiName": "Model Name", "supportsTools": true}]
	}]`)

	got := loadOpenAICompatibleProviders()
	if len(got) != 1 {
		t.Fatalf("got %d entries, want 1: %+v", len(got), got)
	}
	entry := got[0]
	if entry.Key != "Modal" || entry.Provider != schemas.ModelProvider("Modal") {
		t.Fatalf("got Key=%q Provider=%q", entry.Key, entry.Provider)
	}
	if !entry.IsCustom || !entry.AlwaysConfigured {
		t.Fatalf("got IsCustom=%v AlwaysConfigured=%v, want both true", entry.IsCustom, entry.AlwaysConfigured)
	}
	if entry.CustomBaseURL != "https://example.modal.direct" {
		t.Fatalf("got CustomBaseURL=%q, want the /v1 suffix normalized away", entry.CustomBaseURL)
	}
	if entry.CustomAPIKey != "" {
		t.Fatalf("got CustomAPIKey=%q, want empty (no apiKey field in input)", entry.CustomAPIKey)
	}
	if len(entry.Models) != 1 || entry.Models[0].OurID != "Model Name" || entry.Models[0].BifrostModel != "org/Model-Name" {
		t.Fatalf("got Models=%+v", entry.Models)
	}
}

func TestLoadOpenAICompatibleProviders_StripsTrailingV1FromBaseURL(t *testing.T) {
	t.Setenv("OPENAI_COMPATIBLE_DATA", `[{
		"provider": "Modal",
		"baseUrl": "https://example.modal.direct/v1",
		"models": [{"apiName": "a", "uiName": "A", "supportsTools": true}]
	}]`)

	got := loadOpenAICompatibleProviders()
	if len(got) != 1 || got[0].CustomBaseURL != "https://example.modal.direct" {
		t.Fatalf("got CustomBaseURL=%q, want the /v1 suffix stripped (Bifrost's OpenAI provider always appends its own /v1/chat/completions)", got[0].CustomBaseURL)
	}
}

func TestLoadOpenAICompatibleProviders_LeavesBaseURLWithoutV1SuffixUnchanged(t *testing.T) {
	t.Setenv("OPENAI_COMPATIBLE_DATA", `[{
		"provider": "Modal",
		"baseUrl": "https://example.modal.direct",
		"models": [{"apiName": "a", "uiName": "A", "supportsTools": true}]
	}]`)

	got := loadOpenAICompatibleProviders()
	if len(got) != 1 || got[0].CustomBaseURL != "https://example.modal.direct" {
		t.Fatalf("got CustomBaseURL=%q, want unchanged", got[0].CustomBaseURL)
	}
}

func TestLoadOpenAICompatibleProviders_ApiKeyFieldIsUsedAsLiteralKeyValue(t *testing.T) {
	t.Setenv("OPENAI_COMPATIBLE_DATA", `[{
		"provider": "Groq",
		"baseUrl": "https://api.groq.com/openai/v1",
		"apiKey": "gsk_literal_value",
		"models": [{"apiName": "llama3-8b-8192", "uiName": "Llama 3 8B", "supportsTools": true}]
	}]`)

	got := loadOpenAICompatibleProviders()
	if len(got) != 1 || got[0].CustomAPIKey != "gsk_literal_value" {
		t.Fatalf("got %+v, want CustomAPIKey=gsk_literal_value", got)
	}
}

func TestLoadOpenAICompatibleProviders_SkipsProviderMissingBaseURL(t *testing.T) {
	t.Setenv("OPENAI_COMPATIBLE_DATA", `[{
		"provider": "Incomplete",
		"models": [{"apiName": "a", "uiName": "A", "supportsTools": false}]
	}]`)

	if got := loadOpenAICompatibleProviders(); len(got) != 0 {
		t.Fatalf("got %+v, want none (missing baseUrl)", got)
	}
}

func TestLoadOpenAICompatibleProviders_SkipsProviderWithNoModels(t *testing.T) {
	t.Setenv("OPENAI_COMPATIBLE_DATA", `[{"provider": "Empty", "baseUrl": "https://example.com/v1", "models": []}]`)

	if got := loadOpenAICompatibleProviders(); len(got) != 0 {
		t.Fatalf("got %+v, want none (no models)", got)
	}
}

func TestLoadOpenAICompatibleProviders_SkipsIndividualModelMissingRequiredFields(t *testing.T) {
	t.Setenv("OPENAI_COMPATIBLE_DATA", `[{
		"provider": "Mixed",
		"baseUrl": "https://example.com/v1",
		"models": [
			{"apiName": "", "uiName": "Bad", "supportsTools": true},
			{"apiName": "good-model", "uiName": "Good", "supportsTools": true}
		]
	}]`)

	got := loadOpenAICompatibleProviders()
	if len(got) != 1 || len(got[0].Models) != 1 || got[0].Models[0].OurID != "Good" {
		t.Fatalf("got %+v, want only the valid model to survive", got)
	}
}

// withTempCatalogEntry appends entry to the package-level catalog for the
// duration of the test, restoring the original slice afterward -- catalog
// is normally only ever appended to once, at init() time.
func withTempCatalogEntry(t *testing.T, entry providerEntry) {
	t.Helper()
	original := catalog
	catalog = append(append([]providerEntry{}, catalog...), entry)
	t.Cleanup(func() { catalog = original })
}

func TestAccount_GetConfigForProvider_CustomKeylessEntryReturnsBaseURLAndIsKeyLess(t *testing.T) {
	withTempCatalogEntry(t, providerEntry{
		Key: "Modal", Provider: schemas.ModelProvider("Modal"),
		IsCustom: true, AlwaysConfigured: true, CustomBaseURL: "https://example.modal.direct/v1",
	})

	a := newAccount(fakeStore{})
	cfg, err := a.GetConfigForProvider(schemas.ModelProvider("Modal"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.NetworkConfig.BaseURL != "https://example.modal.direct/v1" {
		t.Fatalf("got BaseURL=%q", cfg.NetworkConfig.BaseURL)
	}
	if cfg.CustomProviderConfig == nil || cfg.CustomProviderConfig.BaseProviderType != schemas.OpenAI {
		t.Fatalf("got CustomProviderConfig=%+v, want BaseProviderType=OpenAI", cfg.CustomProviderConfig)
	}
	if !cfg.CustomProviderConfig.IsKeyLess {
		t.Fatalf("got IsKeyLess=false, want true (no apiKey configured)")
	}
}

func TestAccount_GetConfigForProvider_CustomEntryWithAPIKeyIsNotKeyLess(t *testing.T) {
	withTempCatalogEntry(t, providerEntry{
		Key: "Groq2", Provider: schemas.ModelProvider("Groq2"),
		IsCustom: true, AlwaysConfigured: true, CustomBaseURL: "https://api.groq.com/openai/v1", CustomAPIKey: "gsk_x",
	})

	a := newAccount(fakeStore{})
	cfg, err := a.GetConfigForProvider(schemas.ModelProvider("Groq2"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.CustomProviderConfig.IsKeyLess {
		t.Fatalf("got IsKeyLess=true, want false (apiKey was configured)")
	}
}

func TestAccount_GetKeysForProvider_CustomEntryReturnsConfiguredKeyValue(t *testing.T) {
	withTempCatalogEntry(t, providerEntry{
		Key: "Groq3", Provider: schemas.ModelProvider("Groq3"),
		IsCustom: true, AlwaysConfigured: true, CustomBaseURL: "https://api.groq.com/openai/v1", CustomAPIKey: "gsk_x",
	})

	a := newAccount(fakeStore{})
	keys, err := a.GetKeysForProvider(context.Background(), schemas.ModelProvider("Groq3"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(keys) != 1 || keys[0].Value.String() != "gsk_x" {
		t.Fatalf("got %+v, want one key with value gsk_x", keys)
	}
}

func TestAccount_GetKeysForProvider_CustomEntryNeverConsultsKeyStore(t *testing.T) {
	withTempCatalogEntry(t, providerEntry{
		Key: "Modal2", Provider: schemas.ModelProvider("Modal2"),
		IsCustom: true, AlwaysConfigured: true, CustomBaseURL: "https://example.modal.direct/v1",
	})

	// A KeyStore that errors on any Get call -- if GetKeysForProvider ever
	// touched it for a custom entry, this test would fail with that error.
	a := newAccount(erroringStore{})
	if _, err := a.GetKeysForProvider(context.Background(), schemas.ModelProvider("Modal2")); err != nil {
		t.Fatalf("unexpected error (custom entry should never call KeyStore.Get): %v", err)
	}
}

type erroringStore struct{}

func (erroringStore) Get(context.Context, string) (string, bool, error) {
	return "", false, errStoreShouldNotBeCalled
}
func (erroringStore) Set(context.Context, string, string) error { return nil }
func (erroringStore) Delete(context.Context, string) error      { return nil }

var errStoreShouldNotBeCalled = &storeCalledError{}

type storeCalledError struct{}

func (*storeCalledError) Error() string { return "KeyStore.Get should not have been called" }
