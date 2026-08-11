package storage

import (
	"net/url"
	"os"
	"path"
	"strings"

	"github.com/google/uuid"
)

// DefaultPrefix mirrors resolveStoragePrefix's fallback
// (storage-utils.ts:70): FILE_STORAGE_PREFIX, or "uploads".
const DefaultPrefix = "uploads"

// signedPathPrefix is the URL path LocalStorage's presigned URLs use.
const signedPathPrefix = "/storage/"

// Prefix ports resolveStoragePrefix (storage-utils.ts:70), including its
// stripping of leading/trailing slashes and dots.
func Prefix() string {
	raw := os.Getenv("BETTERCHATBOT_STORAGE_PREFIX")
	if raw == "" {
		raw = DefaultPrefix
	}
	return strings.Trim(strings.TrimSpace(raw), "/.")
}

// SanitizeFilename ports sanitizeFilename (storage-utils.ts:6): take the
// basename, replace anything outside [A-Za-z0-9._-] with "_", and never
// return an empty string.
func SanitizeFilename(filename string) string {
	base := filename
	if idx := strings.LastIndexAny(base, `/\`); idx >= 0 {
		base = base[idx+1:]
	}
	if base == "" {
		return "file"
	}

	var b strings.Builder
	for _, r := range base {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	if b.Len() == 0 {
		return "file"
	}
	return b.String()
}

// BuildKey ports buildKey (s3-file-storage.ts:32):
// "<prefix>/<uuid>-<sanitized filename>". Both storage backends use the
// same layout so a key produced on desktop reads identically on a web
// deploy (and vice versa) -- it's also what makes KeyFromURL's pathname
// fallback correct for real S3 URLs.
func BuildKey(filename string) string {
	safeName := SanitizeFilename(filename)
	if filename == "" {
		safeName = "file"
	}
	name := uuid.NewString() + "-" + safeName
	if prefix := Prefix(); prefix != "" {
		return path.Join(prefix, name)
	}
	return name
}

// SignedURLResolver is implemented by a backend whose presigned URLs don't
// carry the storage key in their path. LocalStorage's do not -- the whole
// point of its signed token is that the key isn't guessable or forgeable
// from the URL -- so it needs a way to answer "which key did I issue this
// URL for?" that KeyFromURL below can use.
type SignedURLResolver interface {
	KeyFromSignedURL(rawURL string) (string, bool)
}

// KeyFromURL ports storageKeyFromUrl (storage-utils.ts:76) -- decode the
// URL's pathname and drop the leading slash -- with one addition the TS
// version doesn't need: a LocalStorage presigned URL carries an opaque
// signed token in that position rather than the key, so the backend gets
// first refusal on resolving it. Returns false for anything unparseable,
// matching the TS `catch { return null }`.
func KeyFromURL(s Storage, rawURL string) (string, bool) {
	if resolver, ok := s.(SignedURLResolver); ok {
		if key, ok := resolver.KeyFromSignedURL(rawURL); ok {
			return key, true
		}
	}

	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Path == "" {
		return "", false
	}
	key, err := url.PathUnescape(strings.TrimPrefix(parsed.Path, "/"))
	if err != nil {
		return "", false
	}
	if key == "" {
		return "", false
	}
	return key, true
}

// contentTypes ports getContentTypeFromFilename's lookup table
// (storage-utils.ts:15).
var contentTypes = map[string]string{
	"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
	"gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml",
	"ico": "image/x-icon",

	"pdf":  "application/pdf",
	"doc":  "application/msword",
	"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"xls":  "application/vnd.ms-excel",
	"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"ppt":  "application/vnd.ms-powerpoint",
	"pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",

	"txt": "text/plain", "html": "text/html", "css": "text/css",
	"js": "text/javascript", "json": "application/json", "xml": "application/xml",
	"csv": "text/csv", "md": "text/markdown",

	"mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "m4a": "audio/mp4",

	"mp4": "video/mp4", "webm": "video/webm", "avi": "video/x-msvideo",
	"mov": "video/quicktime",

	"zip": "application/zip", "rar": "application/x-rar-compressed",
	"7z": "application/x-7z-compressed", "tar": "application/x-tar",
	"gz": "application/gzip",
}

// ContentTypeFromFilename ports getContentTypeFromFilename
// (storage-utils.ts:15).
func ContentTypeFromFilename(filename string) string {
	idx := strings.LastIndex(filename, ".")
	if idx < 0 || idx == len(filename)-1 {
		return "application/octet-stream"
	}
	if ct, ok := contentTypes[strings.ToLower(filename[idx+1:])]; ok {
		return ct
	}
	return "application/octet-stream"
}
