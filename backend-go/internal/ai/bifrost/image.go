package bifrostai

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

// GeneratedImage is one image off an image-generation response, in the
// shape src/lib/ai/image/generate-image.ts's GeneratedImage already has
// (generate-image.ts:29): raw base64 bytes plus their media type.
type GeneratedImage struct {
	Base64   string `json:"base64"`
	MimeType string `json:"mimeType,omitempty"`
}

// ImageRequest is the provider-agnostic input internal/ai/image builds.
// Provider/Model are already resolved to Bifrost's own identifiers by the
// caller, matching how ResolvedModel works for the chat path.
type ImageRequest struct {
	Provider schemas.ModelProvider
	Model    string
	Prompt   string
	// MimeType is the media type reported back on every returned image.
	// Providers answering with b64_json don't state one, and the TS code
	// doesn't ask: it reads `mediaType` off the AI SDK's own decoded
	// result, which is derived from the same per-model constant this
	// field carries.
	MimeType string
}

// imageDownloadClient fetches images for providers that answer with a URL
// instead of inline base64. Ported from getBase64Data's Case 4
// (storage-utils.ts:235) -- the TS helper fetches an http(s) image and
// re-encodes it, which is the same fallback needed here whenever a
// provider ignores the b64_json response format.
var imageDownloadClient = &http.Client{Timeout: 60 * time.Second}

// GenerateImages calls Bifrost's ImageGenerationRequest and normalizes
// every returned image to base64, downloading any URL-only result.
func (c *Client) GenerateImages(ctx context.Context, req ImageRequest) ([]GeneratedImage, error) {
	bctx := schemas.NewBifrostContext(ctx, schemas.NoDeadline)
	responseFormat := "b64_json"

	resp, bErr := c.bf.ImageGenerationRequest(bctx, &schemas.BifrostImageGenerationRequest{
		Provider: req.Provider,
		Model:    req.Model,
		Input:    &schemas.ImageGenerationInput{Prompt: req.Prompt},
		Params:   &schemas.ImageGenerationParameters{ResponseFormat: &responseFormat},
	})
	if bErr != nil {
		return nil, toError(bErr)
	}
	if resp == nil {
		return nil, fmt.Errorf("bifrost: empty image generation response")
	}

	images := make([]GeneratedImage, 0, len(resp.Data))
	for _, data := range resp.Data {
		if data.B64JSON != "" {
			images = append(images, GeneratedImage{Base64: data.B64JSON, MimeType: req.MimeType})
			continue
		}
		if data.URL == "" {
			continue
		}
		encoded, err := downloadAsBase64(ctx, data.URL)
		if err != nil {
			return nil, err
		}
		images = append(images, GeneratedImage{Base64: encoded, MimeType: req.MimeType})
	}
	return images, nil
}

func downloadAsBase64(ctx context.Context, url string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := imageDownloadClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("bifrost: fetch generated image: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("bifrost: fetch generated image: unexpected status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("bifrost: read generated image: %w", err)
	}
	return base64.StdEncoding.EncodeToString(body), nil
}
