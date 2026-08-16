// Package image ports src/lib/ai/image/generate-image.ts's three
// server-side generators (OpenAI, xAI, and Google's "nano banana"), each
// pinned to the same model the TS code hardcodes.
//
// Where the TS version reaches for three different SDKs -- `@ai-sdk/openai`,
// `@ai-sdk/xai`, and a raw `@google/genai` client -- all three go through
// Bifrost's own ImageGenerationRequest here, which plan section 4's
// image/speech row explicitly allows ("or via Bifrost if it covers
// image/speech for the relevant providers"). Confirmed against the
// vendored source before relying on it: OpenAI, xAI, and Gemini all
// implement schemas.Provider.ImageGeneration for real (providers/openai,
// providers/xai, providers/gemini), none of them is a not-supported stub.
//
// Not ported: the TS multi-turn image path -- generateImageWithNanoBanana
// accepts prior `messages` (including previously generated images) so the
// model can *edit* or *composite* rather than only create. That's driven
// entirely by the chat tool-calling loop (lib/ai/tools/image/index.ts's
// nanoBananaTool/openaiImageTool), which Phase 3 deliberately left out of
// the chat handler and no phase has added since; Bifrost exposes a
// separate ImageEditRequest for it when that lands. Every call site that
// exists today without tool calling -- the profile-avatar generator in
// api/user/actions.ts -- is prompt-only, which is what this package
// covers.
package image

import (
	"context"
	"fmt"

	"github.com/maximhq/bifrost/core/schemas"

	bifrostai "amiro/backend/internal/ai/bifrost"
)

// Engine is the subset of *bifrostai.Client this package calls, narrowed
// to an interface so callers' tests can substitute a fake -- the same
// shape internal/api/chat.Engine and executor.Engine already use.
type Engine interface {
	GenerateImages(ctx context.Context, req bifrostai.ImageRequest) ([]bifrostai.GeneratedImage, error)
}

// generator pins one provider to the exact model and output media type the
// TS function of the same name hardcodes.
type generator struct {
	provider schemas.ModelProvider
	model    string
	mimeType string
}

// generators keys off the same provider strings api/user/actions.ts's
// switch accepts ("openai" / "xai" / "google", actions.ts:268-282).
var generators = map[string]generator{
	// generateImageWithOpenAI (generate-image.ts:38): openai.image("gpt-image-1-mini").
	"openai": {schemas.OpenAI, "gpt-image-1-mini", "image/png"},
	// generateImageWithXAI (generate-image.ts:58): xai.image("grok-2-image").
	"xai": {schemas.XAI, "grok-2-image", "image/jpeg"},
	// generateImageWithNanoBanana (generate-image.ts:75): "gemini-2.5-flash-image".
	"google": {schemas.Gemini, "gemini-2.5-flash-image", "image/png"},
}

// Providers lists the provider keys Generate accepts, in a stable order --
// used by callers that need to present the choice.
func Providers() []string {
	return []string{"openai", "xai", "google"}
}

// Generate runs prompt through the named provider's image model and
// returns every image it produced, base64-encoded.
func Generate(ctx context.Context, engine Engine, provider, prompt string) ([]bifrostai.GeneratedImage, error) {
	g, ok := generators[provider]
	if !ok {
		// Mirrors the TS switch's `default: return { success: false, error:
		// "Invalid provider" }` (actions.ts:283).
		return nil, fmt.Errorf("image: invalid provider %q", provider)
	}
	if prompt == "" {
		return nil, fmt.Errorf("image: prompt is required")
	}

	return engine.GenerateImages(ctx, bifrostai.ImageRequest{
		Provider: g.provider,
		Model:    g.model,
		Prompt:   prompt,
		MimeType: g.mimeType,
	})
}

// AvatarPrompt ports the avatar-specific prompt wrapper
// api/user/actions.ts:251 builds before calling any of the three
// generators. Kept here (not in the handler) so every avatar call site
// gets the identical wording the TS one produces.
func AvatarPrompt(userPrompt string) string {
	return fmt.Sprintf(`You are tasked with creating a professional profile picture for a user.

Requirements:
- Portrait style with centered face
- Clear, high-quality image suitable for profile/avatar use
- Friendly and approachable expression
- Professional yet personable appearance
- Clean background that doesn't distract from the subject
- Well-lit with good contrast

User's request:
"%s"

Generate a profile picture that fulfills the user's request while maintaining the professional portrait quality requirements above.`, userPrompt)
}
