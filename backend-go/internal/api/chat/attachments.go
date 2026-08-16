// attachments.go resolves a Message's Attachments (uiMessage.toEngineMessages'
// filePart handling in shared.go) into base64 data URLs before they ever
// reach internal/ai/bifrost: better-chatbot's only storage backends (S3,
// Vercel Blob) hand back a genuinely public URL a cloud model provider can
// fetch directly, but this backend's own local storage
// (internal/storage.LocalStorage) serves files off 127.0.0.1:<port> --
// unreachable by design from outside this machine, let alone from a
// provider's own servers. Found live, not assumed: without this step, a
// vision request against an uploaded image silently degrades to text-only
// (the provider either 404s fetching the URL or, for some providers,
// rejects the request outright).
package chat

import (
	"context"
	"encoding/base64"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	bifrostai "amiro/backend/internal/ai/bifrost"
)

// maxAttachmentFetchBytes mirrors internal/api/storage's own multipart
// upload cap (handler.go's maxUploadMemory) -- an attachment already had to
// fit under that limit to exist in local storage in the first place.
const maxAttachmentFetchBytes = 32 << 20

var attachmentHTTPClient = &http.Client{Timeout: 15 * time.Second}

// resolveAttachmentURLs rewrites every Message's Attachments in place,
// replacing each URL with a `data:<mediaType>;base64,...` URL fetched from
// wherever it currently points. A URL that's already a data: URL (nothing
// produces one yet, but a future caller might) is left untouched. A fetch
// that fails (unreachable, too large, non-2xx) drops that one attachment
// rather than failing the whole chat turn -- graceful degradation matching
// resolveAgent's own silent-ignore-on-error precedent elsewhere in this
// package: the model still gets the user's text, just not that file.
func resolveAttachmentURLs(ctx context.Context, messages []bifrostai.Message) []bifrostai.Message {
	for i := range messages {
		if len(messages[i].Attachments) == 0 {
			continue
		}
		resolved := make([]bifrostai.Attachment, 0, len(messages[i].Attachments))
		for _, a := range messages[i].Attachments {
			if dataURL, ok := fetchAsDataURL(ctx, a); ok {
				a.URL = dataURL
				resolved = append(resolved, a)
			}
		}
		messages[i].Attachments = resolved
	}
	return messages
}

func fetchAsDataURL(ctx context.Context, a bifrostai.Attachment) (string, bool) {
	if strings.HasPrefix(a.URL, "data:") {
		return a.URL, true
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.URL, nil)
	if err != nil {
		log.Printf("chat: attachment %q: building request: %v", a.Filename, err)
		return "", false
	}
	resp, err := attachmentHTTPClient.Do(req)
	if err != nil {
		log.Printf("chat: attachment %q: fetching %s: %v", a.Filename, a.URL, err)
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("chat: attachment %q: fetching %s: status %d", a.Filename, a.URL, resp.StatusCode)
		return "", false
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxAttachmentFetchBytes+1))
	if err != nil {
		log.Printf("chat: attachment %q: reading body: %v", a.Filename, err)
		return "", false
	}
	if len(body) > maxAttachmentFetchBytes {
		log.Printf("chat: attachment %q: exceeds %d byte fetch cap, dropping", a.Filename, maxAttachmentFetchBytes)
		return "", false
	}

	mediaType := a.MediaType
	if mediaType == "" {
		mediaType = resp.Header.Get("Content-Type")
	}
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}

	return "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(body), true
}
