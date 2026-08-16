package image

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"

	bifrostai "amiro/backend/internal/ai/bifrost"
)

type fakeEngine struct {
	got  bifrostai.ImageRequest
	out  []bifrostai.GeneratedImage
	fail error
}

func (f *fakeEngine) GenerateImages(_ context.Context, req bifrostai.ImageRequest) ([]bifrostai.GeneratedImage, error) {
	f.got = req
	if f.fail != nil {
		return nil, f.fail
	}
	return f.out, nil
}

func TestGenerate_MapsEachProviderToItsPinnedModel(t *testing.T) {
	cases := map[string]struct {
		provider schemas.ModelProvider
		model    string
	}{
		"openai": {schemas.OpenAI, "gpt-image-1-mini"},
		"xai":    {schemas.XAI, "grok-2-image"},
		"google": {schemas.Gemini, "gemini-2.5-flash-image"},
	}

	for key, want := range cases {
		engine := &fakeEngine{out: []bifrostai.GeneratedImage{{Base64: "abc"}}}
		if _, err := Generate(context.Background(), engine, key, "a cat"); err != nil {
			t.Fatalf("%s: Generate: %v", key, err)
		}
		if engine.got.Provider != want.provider || engine.got.Model != want.model {
			t.Fatalf("%s: got %s/%s, want %s/%s", key, engine.got.Provider, engine.got.Model, want.provider, want.model)
		}
		if engine.got.Prompt != "a cat" {
			t.Fatalf("%s: prompt = %q", key, engine.got.Prompt)
		}
	}
}

func TestGenerate_RejectsAnUnknownProvider(t *testing.T) {
	engine := &fakeEngine{}

	if _, err := Generate(context.Background(), engine, "midjourney", "a cat"); err == nil {
		t.Fatal("want an error for an unrecognized provider")
	}
	if engine.got.Model != "" {
		t.Fatal("an unknown provider still reached the engine")
	}
}

func TestGenerate_RejectsAnEmptyPrompt(t *testing.T) {
	engine := &fakeEngine{}

	if _, err := Generate(context.Background(), engine, "openai", ""); err == nil {
		t.Fatal("want an error for an empty prompt")
	}
}

func TestGenerate_PropagatesEngineFailures(t *testing.T) {
	engine := &fakeEngine{fail: errors.New("upstream is down")}

	if _, err := Generate(context.Background(), engine, "openai", "a cat"); err == nil {
		t.Fatal("want the engine error surfaced, not swallowed")
	}
}

// Each provider declares the media type its pinned model actually returns,
// since the b64_json payload doesn't state one.
func TestGenerate_TagsResultsWithTheProvidersMediaType(t *testing.T) {
	engine := &fakeEngine{out: []bifrostai.GeneratedImage{{Base64: "abc"}}}
	if _, err := Generate(context.Background(), engine, "xai", "a cat"); err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if engine.got.MimeType != "image/jpeg" {
		t.Fatalf("mimeType = %q, want image/jpeg", engine.got.MimeType)
	}
}

func TestProviders_ListsEveryGeneratorKey(t *testing.T) {
	for _, key := range Providers() {
		if _, ok := generators[key]; !ok {
			t.Fatalf("Providers() lists %q, which Generate would reject", key)
		}
	}
	if len(Providers()) != len(generators) {
		t.Fatalf("Providers() has %d entries, generators has %d", len(Providers()), len(generators))
	}
}

func TestAvatarPrompt_WrapsTheUserRequestVerbatim(t *testing.T) {
	prompt := AvatarPrompt(`a "friendly" robot`)

	if !strings.Contains(prompt, `"a "friendly" robot"`) {
		t.Fatalf("prompt does not embed the request unescaped:\n%s", prompt)
	}
	if !strings.Contains(prompt, "Portrait style with centered face") {
		t.Fatalf("prompt is missing the avatar requirements:\n%s", prompt)
	}
}
