package web

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// bundle writes a directory shaped like a real `next build` export --
// out/'s actual layout, checked against it rather than invented: top-level
// "<route>.html" files (not "<route>/index.html"), nested routes as
// "<parent>/<child>.html", hashed assets under _next/static, and a
// 404.html the export always writes.
func bundle(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"index.html":                    "<html><head><title>Amiro</title></head><body>home</body></html>",
		"404.html":                      "<html><head></head><body>not found</body></html>",
		"admin.html":                    "<html><head></head><body>admin</body></html>",
		"admin/providers.html":          "<html><head></head><body>providers</body></html>",
		"sign-in.html":                  "<html><head></head><body>sign in</body></html>",
		"_next/static/chunk.abc123.js":  "console.log(1)",
		"_next/static/style.abc123.css": "body{}",
		"favicon.ico":                   "\x00\x00\x01\x00",
		"nested/index.html":             "<html><head></head><body>nested index</body></html>",
	}
	for name, body := range files {
		full := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", full, err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", full, err)
		}
	}
	return dir
}

func handler(t *testing.T) *Handler {
	t.Helper()
	h, ok := NewFromDir(bundle(t))
	if !ok {
		t.Fatal("NewFromDir reported no bundle for a directory that has one")
	}
	return h
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

// TestHandler_ResolvesEveryRouteShapeTheExportProduces is the deep-link
// contract. A Next.js static export writes /admin as "admin.html", so a
// handler that only looked for "admin/index.html" would 404 every route in
// the app on a hard refresh while working perfectly for client-side
// navigation -- the classic SPA bug, and the one thing serving the bundle
// from Go must not reintroduce.
func TestHandler_ResolvesEveryRouteShapeTheExportProduces(t *testing.T) {
	h := handler(t)

	for _, tc := range []struct{ path, want string }{
		{"/", "home"},
		{"/index.html", "home"},
		{"/admin", "admin"},
		{"/admin.html", "admin"},
		{"/admin/providers", "providers"},
		{"/sign-in", "sign in"},
		{"/nested", "nested index"},
		{"/_next/static/chunk.abc123.js", "console.log(1)"},
	} {
		rec := get(t, h, tc.path)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s: status = %d, want 200", tc.path, rec.Code)
			continue
		}
		if !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("GET %s: body does not contain %q", tc.path, tc.want)
		}
	}
}

// TestHandler_UnknownPathServesTheExports404WithA404Status guards against
// the tempting shortcut of answering 200 with index.html for everything.
// A SPA fallback that lies about the status breaks link checkers, caches,
// and anything that reasonably trusts a status code.
func TestHandler_UnknownPathServesTheExports404WithA404Status(t *testing.T) {
	rec := get(t, handler(t), "/no/such/route")

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
	if !strings.Contains(rec.Body.String(), "not found") {
		t.Fatalf("body = %q, want the export's own 404 page", rec.Body.String())
	}
}

// TestHandler_RefusesPathTraversal covers the shapes an attacker actually
// sends, not just the textbook one: a bare ../, a URL-encoded one (which
// net/http has already decoded by the time the handler sees it), and a
// Windows-style backslash separator.
func TestHandler_RefusesPathTraversal(t *testing.T) {
	dir := bundle(t)
	secret := filepath.Join(filepath.Dir(dir), "secret.txt")
	if err := os.WriteFile(secret, []byte("TOP SECRET"), 0o644); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	h, ok := NewFromDir(dir)
	if !ok {
		t.Fatal("NewFromDir reported no bundle")
	}

	for _, path := range []string{
		"/../secret.txt",
		"/../../secret.txt",
		"/admin/../../secret.txt",
		"/%2e%2e/secret.txt",
		"/..%2fsecret.txt",
		"/....//secret.txt",
		"/\\..\\secret.txt",
	} {
		rec := httptest.NewRecorder()
		req, err := http.NewRequest(http.MethodGet, "http://x"+path, nil)
		if err != nil {
			// A path so malformed net/http won't build a request from it
			// is refused before reaching us, which is the desired outcome.
			continue
		}
		h.ServeHTTP(rec, req)

		if strings.Contains(rec.Body.String(), "TOP SECRET") {
			t.Errorf("GET %s escaped the bundle and served a file outside it", path)
		}
	}
}

// TestHandler_InjectsTheSameOriginMarkerIntoHTMLOnly is the contract
// src/lib/backend/config.ts depends on: __BACKEND_ORIGIN__ set to "" tells
// the frontend the API is on this very origin, so it builds relative
// /api/... URLs instead of the absolute 127.0.0.1:<port> ones the Tauri
// webview needs. It has to land inside <head>, ahead of the bundle's own
// scripts -- the same ordering guarantee Rust gets from
// initialization_script.
func TestHandler_InjectsTheSameOriginMarkerIntoHTMLOnly(t *testing.T) {
	h := handler(t)

	page := get(t, h, "/").Body.String()
	if !strings.Contains(page, `window.__BACKEND_ORIGIN__=""`) {
		t.Fatalf("HTML response carries no same-origin marker:\n%s", page)
	}
	if strings.Index(page, "__BACKEND_ORIGIN__") > strings.Index(page, "</head>") {
		t.Fatal("same-origin marker must be injected inside <head>, before the bundle's own scripts")
	}

	asset := get(t, h, "/_next/static/chunk.abc123.js").Body.String()
	if strings.Contains(asset, "__BACKEND_ORIGIN__") {
		t.Fatalf("marker must not be injected into non-HTML assets, got %q", asset)
	}
}

func TestHandler_CachesHashedAssetsForeverAndHTMLNever(t *testing.T) {
	h := handler(t)

	if got := get(t, h, "/_next/static/chunk.abc123.js").Header().Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Errorf("hashed asset Cache-Control = %q, want it immutable", got)
	}
	// A cached HTML shell outlives the hashed chunks it references, and the
	// result is a blank page -- so the shell is never cached.
	if got := get(t, h, "/admin").Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("HTML Cache-Control = %q, want no-store", got)
	}
}

func TestHandler_SetsContentTypeAndNosniff(t *testing.T) {
	h := handler(t)

	for _, tc := range []struct{ path, wantType string }{
		{"/", "text/html"},
		{"/_next/static/chunk.abc123.js", "javascript"},
		{"/_next/static/style.abc123.css", "text/css"},
	} {
		rec := get(t, h, tc.path)
		if got := rec.Header().Get("Content-Type"); !strings.Contains(got, tc.wantType) {
			t.Errorf("GET %s: Content-Type = %q, want it to contain %q", tc.path, got, tc.wantType)
		}
		if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("GET %s: X-Content-Type-Options = %q, want nosniff", tc.path, got)
		}
	}
}

func TestHandler_RejectsNonReadMethods(t *testing.T) {
	rec := httptest.NewRecorder()
	handler(t).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /: status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandler_HeadReturnsHeadersWithoutABody(t *testing.T) {
	rec := httptest.NewRecorder()
	handler(t).ServeHTTP(rec, httptest.NewRequest(http.MethodHead, "/", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD returned a %d-byte body, want none", rec.Body.Len())
	}
}

// TestNewFromDir_ReportsNoBundleForADirectoryWithoutOne is what keeps the
// .gitkeep placeholder in internal/web/dist from reading as "the UI is
// available" -- a fresh clone has the directory but no export in it, and
// `amiro serve` must say so rather than serve an empty site.
func TestNewFromDir_ReportsNoBundleForADirectoryWithoutOne(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".gitkeep"), []byte("placeholder"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	if _, ok := NewFromDir(dir); ok {
		t.Fatal("NewFromDir reported a bundle for a directory holding only a placeholder")
	}
	if _, ok := NewFromDir(""); ok {
		t.Fatal("NewFromDir reported a bundle for an empty path")
	}
	if _, ok := NewFromDir(filepath.Join(dir, "does-not-exist")); ok {
		t.Fatal("NewFromDir reported a bundle for a missing directory")
	}
}

// TestHandler_BuildIDChangesWithTheBundle is what makes `amiro version`'s
// dashboard line worth printing: a stale embedded bundle is invisible from
// the outside, and the whole point of the id is telling two binaries apart.
func TestHandler_BuildIDChangesWithTheBundle(t *testing.T) {
	dir := bundle(t)
	first, _ := NewFromDir(dir)

	same, _ := NewFromDir(dir)
	if first.BuildID() != same.BuildID() {
		t.Fatal("BuildID is not stable across handlers over the same bundle")
	}

	if err := os.WriteFile(filepath.Join(dir, "admin.html"), []byte("<html><head></head><body>changed</body></html>"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	changed, _ := NewFromDir(dir)
	if changed.BuildID() == first.BuildID() {
		t.Fatal("BuildID did not change after a file's contents changed")
	}

	// A route dropped from the export with no surviving file edited is
	// still a different bundle, which is why names are hashed too.
	if err := os.Remove(filepath.Join(dir, "sign-in.html")); err != nil {
		t.Fatalf("remove: %v", err)
	}
	dropped, _ := NewFromDir(dir)
	if dropped.BuildID() == changed.BuildID() {
		t.Fatal("BuildID did not change after a file was removed")
	}
}
