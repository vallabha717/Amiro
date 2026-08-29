// Package sandboxapi exposes internal/agent/sandbox.Detect()'s result over
// HTTP: which backend (if any) run_shell calls are wrapped by. It answers a
// question every surface needs at launch -- the TUI status bar
// (docs/coding-agent-parity/03-sandboxed-execution.md's honesty contract),
// and eventually the web dashboard's own indicator -- without spawning a
// shell command just to find out; Detect() is already probed once at
// process start and cached, this just reads that cache.
package sandboxapi

import (
	"net/http"

	"amiro/backend/internal/agent/sandbox"
	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
)

type Handler struct{}

func NewHandler() *Handler { return &Handler{} }

type statusResponse struct {
	// Backend is "bubblewrap", "seatbelt", or "none" -- see
	// internal/agent/sandbox.Backend.Name.
	Backend string `json:"backend"`
	// Sandboxed mirrors internal/agent/sandbox.Result.Sandboxed: true only
	// for a real backend, false (never hidden, never softened) when
	// run_shell has no isolation available.
	Sandboxed bool `json:"sandboxed"`
}

// Status reports the process's detected sandbox backend, gated behind a
// session the same way every other status endpoint in this codebase is
// (router.go's `session := auth.RequireSession(h.Auth)` convention) -- it
// carries no per-user data, but there is no established unauthenticated
// route family here to join instead.
func (h *Handler) Status(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.UserFromContext(r.Context()); !ok {
		httpjson.Unauthorized(w)
		return
	}
	b := sandbox.Detect()
	httpjson.OK(w, statusResponse{Backend: b.Name(), Sandboxed: b.Sandboxed()})
}
