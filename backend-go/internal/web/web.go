// Package web serves the exported Next.js dashboard bundle out of the Go
// binary, so `amiro serve` can hand a browser the same UI the desktop app
// shows without a Node runtime anywhere in the picture.
//
// The bundle is produced by `next build` with output: "export"
// (next.config.ts) and copied into internal/web/dist by
// scripts/build-ui.sh. It is compiled in only under the `embedui` build
// tag -- see embed_on.go/embed_off.go for why: a plain `go build ./...` in
// a checkout that has never run `pnpm build` must still work, and it does,
// producing a binary that reports no bundle rather than failing to
// compile.
//
// The resolution rules below are not generic static-file serving. A
// Next.js static export writes /admin as "admin.html", not
// "admin/index.html", and route groups like (chat)/(auth) do not appear in
// the URL at all -- so a deep link only survives a hard refresh if the
// handler tries the ".html" sibling before giving up. scripts/serve-out.mjs
// (the Node equivalent used during Phase 7 development) documents the same
// ladder; this is its Go counterpart and the two must stay in step.
package web

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// notFoundPage is the export's own 404 route. Served with a real 404
// status -- a SPA fallback that answers 200 for every unknown path breaks
// link checkers, caches, and any client that reasonably believes a status
// code.
const notFoundPage = "404.html"

// immutablePrefix is the one directory whose filenames carry a content
// hash, so its contents can be cached forever. Everything else is served
// no-store: the HTML shells are small, and a stale shell pointing at a
// deleted chunk is a blank page for the user.
const immutablePrefix = "_next/static/"

// bootstrapScript tells the frontend it is being served by the Go binary
// itself, on the same origin as the API. src/lib/backend/config.ts reads
// __BACKEND_ORIGIN__ before anything else and, seeing an empty string,
// builds relative /api/... URLs instead of the absolute
// http://127.0.0.1:<port> ones the Tauri webview needs.
//
// Injected into every HTML response rather than baked into the bundle at
// build time, because the same bundle is served three ways -- Tauri
// webview, `amiro serve`, and `next dev` -- and only this one is
// same-origin.
const bootstrapScript = `<script>window.__BACKEND_ORIGIN__="";</script>`

// Handler serves a built dashboard bundle.
type Handler struct {
	fsys    fs.FS
	buildID string
}

// New returns a Handler over the embedded bundle. ok is false when the
// binary was built without one (no `embedui` tag, or an empty dist/), in
// which case callers should fall back to serving the API alone.
func New() (*Handler, bool) {
	fsys, ok := embedded()
	if !ok {
		return nil, false
	}
	return newHandler(fsys)
}

// NewFromDir serves a bundle from a directory on disk instead of the
// embedded one -- `amiro serve --ui-dir ../out`. It exists for two real
// cases: iterating on the frontend without rebuilding the Go binary, and
// the test suite, which needs a bundle it controls rather than whatever
// happened to be compiled in.
func NewFromDir(dir string) (*Handler, bool) {
	if dir == "" {
		return nil, false
	}
	return newHandler(os.DirFS(dir))
}

func newHandler(fsys fs.FS) (*Handler, bool) {
	// An index.html is the minimum that makes a directory a bundle rather
	// than an empty placeholder -- dist/ exists in the repo as a .gitkeep
	// so go:embed has something to point at, and that must not read as
	// "the UI is available".
	if _, err := fs.Stat(fsys, "index.html"); err != nil {
		return nil, false
	}
	return &Handler{fsys: fsys, buildID: computeBuildID(fsys)}, true
}

// BuildID is a stable fingerprint of the bundle's contents, reported by
// `amiro version`. Without it there is no way to tell a binary carrying
// today's UI from one carrying a bundle built three weeks ago, which is
// exactly the confusion a stale `out/` produces.
func (h *Handler) BuildID() string { return h.buildID }

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	name, ok := resolvePath(r.URL.Path)
	if !ok {
		h.serveFile(w, r, notFoundPage, http.StatusNotFound)
		return
	}

	for _, candidate := range candidates(name) {
		if isFile(h.fsys, candidate) {
			h.serveFile(w, r, candidate, http.StatusOK)
			return
		}
	}

	h.serveFile(w, r, notFoundPage, http.StatusNotFound)
}

// candidates is the resolution ladder, in order. "/admin" is tried as the
// literal file, then as "admin.html" (what the export actually writes),
// then as "admin/index.html" (what a trailing-slash export would write).
func candidates(name string) []string {
	if name == "" {
		return []string{"index.html"}
	}
	return []string{
		name,
		name + ".html",
		path.Join(name, "index.html"),
	}
}

// resolvePath turns a request path into an fs.FS-valid name, or reports
// that it could never be one. path.Clean collapses "." and ".." before the
// leading slash is stripped, so "/../../etc/passwd" cleans to "/etc/passwd"
// and lands harmlessly inside the bundle; fs.ValidPath is the belt to that
// braces, rejecting anything Clean somehow left traversing. Backslashes
// are rejected outright rather than translated -- on Windows they are a
// separator, and an fs.FS name must use forward slashes only.
func resolvePath(urlPath string) (string, bool) {
	if strings.ContainsAny(urlPath, "\\\x00") {
		return "", false
	}
	cleaned := path.Clean("/" + urlPath)
	name := strings.TrimPrefix(cleaned, "/")
	if name == "" {
		return "", true
	}
	if !fs.ValidPath(name) {
		return "", false
	}
	return name, true
}

func isFile(fsys fs.FS, name string) bool {
	info, err := fs.Stat(fsys, name)
	return err == nil && !info.IsDir()
}

func (h *Handler) serveFile(w http.ResponseWriter, r *http.Request, name string, status int) {
	body, err := fs.ReadFile(h.fsys, name)
	if err != nil {
		// Only reachable when the bundle has no 404.html, which a real
		// `next build` always writes. Answer plainly rather than 500 --
		// the request genuinely did not match anything.
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	isHTML := strings.HasSuffix(name, ".html")
	if isHTML {
		body = injectBootstrap(body)
	}

	w.Header().Set("Content-Type", contentType(name))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if strings.HasPrefix(name, immutablePrefix) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}

	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.Copy(w, bytes.NewReader(body))
}

// injectBootstrap places the same-origin marker as the last thing in
// <head>, so it runs before any of the bundle's own scripts and before
// React hydrates -- the same guarantee Tauri gets from
// initialization_script (src-tauri/src/lib.rs). A document with no </head>
// is left alone rather than guessed at.
func injectBootstrap(body []byte) []byte {
	marker := []byte("</head>")
	i := bytes.Index(body, marker)
	if i < 0 {
		return body
	}
	out := make([]byte, 0, len(body)+len(bootstrapScript))
	out = append(out, body[:i]...)
	out = append(out, bootstrapScript...)
	out = append(out, body[i:]...)
	return out
}

func contentType(name string) string {
	if ct := mime.TypeByExtension(filepath.Ext(name)); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// computeBuildID hashes every file's name and contents in a stable order.
// Name as well as contents: a bundle that dropped a route but changed no
// surviving file is a different bundle.
func computeBuildID(fsys fs.FS) string {
	var names []string
	_ = fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		names = append(names, p)
		return nil
	})
	sort.Strings(names)

	sum := sha256.New()
	for _, n := range names {
		sum.Write([]byte(n))
		if data, err := fs.ReadFile(fsys, n); err == nil {
			sum.Write(data)
		}
	}
	return hex.EncodeToString(sum.Sum(nil))[:12]
}
