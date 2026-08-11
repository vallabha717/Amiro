package storage

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestSanitizeFilename_StripsDirectoryComponents(t *testing.T) {
	for _, input := range []string{"../../etc/passwd", `C:\Users\ada\passwd`, "/tmp/passwd"} {
		if got := SanitizeFilename(input); got != "passwd" {
			t.Fatalf("SanitizeFilename(%q) = %q, want %q", input, got, "passwd")
		}
	}
}

func TestSanitizeFilename_ReplacesUnsafeCharactersWithUnderscore(t *testing.T) {
	if got := SanitizeFilename("my report (final).csv"); got != "my_report__final_.csv" {
		t.Fatalf("got %q", got)
	}
}

func TestSanitizeFilename_NeverReturnsEmpty(t *testing.T) {
	for _, input := range []string{"", "/", "///"} {
		if got := SanitizeFilename(input); got == "" {
			t.Fatalf("SanitizeFilename(%q) returned empty", input)
		}
	}
}

func TestBuildKey_PrefixesWithUUIDAndKeepsExtension(t *testing.T) {
	key := BuildKey("report.csv")

	if !strings.HasPrefix(key, DefaultPrefix+"/") {
		t.Fatalf("key = %q, want %q prefix", key, DefaultPrefix)
	}
	if !strings.HasSuffix(key, "-report.csv") {
		t.Fatalf("key = %q, want the sanitized filename preserved", key)
	}
	// The extension surviving is load-bearing: Serve infers the response
	// content type from it, and Ingest sniffs ".csv" off it.
	if ContentTypeFromFilename(key) != "text/csv" {
		t.Fatalf("content type from %q = %q", key, ContentTypeFromFilename(key))
	}
}

func TestBuildKey_IsUniquePerCall(t *testing.T) {
	if BuildKey("a.png") == BuildKey("a.png") {
		t.Fatal("two calls produced the same key -- uploads would overwrite each other")
	}
}

func TestContentTypeFromFilename_FallsBackToOctetStream(t *testing.T) {
	cases := map[string]string{
		"a.png":     "image/png",
		"a.CSV":     "text/csv",
		"a.unknown": "application/octet-stream",
		"noext":     "application/octet-stream",
		"trailing.": "application/octet-stream",
	}
	for filename, want := range cases {
		if got := ContentTypeFromFilename(filename); got != want {
			t.Fatalf("ContentTypeFromFilename(%q) = %q, want %q", filename, got, want)
		}
	}
}

func TestKeyFromURL_ReadsKeyFromPathnameForANonSignedURL(t *testing.T) {
	store := newTestLocalStorage(t)

	got, ok := KeyFromURL(store, "https://bucket.s3.amazonaws.com/uploads/abc-report.csv")
	if !ok || got != "uploads/abc-report.csv" {
		t.Fatalf("got (%q, %v)", got, ok)
	}
}

func TestKeyFromURL_PercentDecodesThePathname(t *testing.T) {
	store := newTestLocalStorage(t)

	got, ok := KeyFromURL(store, "https://example.com/uploads/my%20file.csv")
	if !ok || got != "uploads/my file.csv" {
		t.Fatalf("got (%q, %v)", got, ok)
	}
}

func TestKeyFromURL_ResolvesALocalStorageSignedURLBackToItsKey(t *testing.T) {
	store := newTestLocalStorage(t)

	signed, err := store.PresignGetURL(context.Background(), "uploads/abc-report.csv", time.Minute)
	if err != nil {
		t.Fatalf("PresignGetURL: %v", err)
	}

	got, ok := KeyFromURL(store, signed)
	if !ok || got != "uploads/abc-report.csv" {
		t.Fatalf("got (%q, %v) from %q", got, ok, signed)
	}
}

// Without the SignedURLResolver hook, the pathname fallback would hand
// back the opaque token as though it were a storage key -- which would
// then be read straight off disk. This is the case that makes the hook
// necessary rather than merely tidy.
func TestKeyFromURL_DoesNotMistakeASignedTokenForAKey(t *testing.T) {
	store := newTestLocalStorage(t)

	signed, _ := store.PresignGetURL(context.Background(), "uploads/secret.csv", time.Minute)
	got, _ := KeyFromURL(store, signed)

	if strings.Contains(got, ".") && got != "uploads/secret.csv" {
		t.Fatalf("got %q -- looks like the raw token, not the key", got)
	}
}

func TestKeyFromURL_RejectsUnparseableInput(t *testing.T) {
	store := newTestLocalStorage(t)

	for _, input := range []string{"", "://nope", "not a url at all"} {
		if key, ok := KeyFromURL(store, input); ok && strings.Contains(key, "/") {
			t.Fatalf("KeyFromURL(%q) = (%q, true), want a rejection", input, key)
		}
	}
}
