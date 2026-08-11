// Package httpjson holds the JSON response helpers every Phase 6 handler
// package shares. internal/api/auth, /chat, /mcp, and /workflow each
// predate it and still define their own private copies -- new packages use
// this one rather than adding an eighth.
package httpjson

import (
	"encoding/json"
	"net/http"
)

// OK writes v as a 200 JSON body.
func OK(w http.ResponseWriter, v any) {
	Write(w, http.StatusOK, v)
}

// Write writes v as a JSON body with the given status.
func Write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Success writes the `{"success": true}` body the TS routes return from
// every mutation that has nothing else to say.
func Success(w http.ResponseWriter) {
	OK(w, map[string]bool{"success": true})
}

// Error writes a `{"error": msg}` body, the shape the TS routes use for
// every failure that isn't a bare `new Response("...", { status })`.
func Error(w http.ResponseWriter, status int, msg string) {
	Write(w, status, map[string]string{"error": msg})
}

// Unauthorized / Forbidden / NotFound / BadRequest / ServerError are the
// five statuses the ported routes actually return.
func Unauthorized(w http.ResponseWriter)         { Error(w, http.StatusUnauthorized, "Unauthorized") }
func Forbidden(w http.ResponseWriter)            { Error(w, http.StatusForbidden, "Forbidden") }
func NotFound(w http.ResponseWriter, msg string) { Error(w, http.StatusNotFound, msg) }
func BadRequest(w http.ResponseWriter, msg string) {
	Error(w, http.StatusBadRequest, msg)
}

// ServerError deliberately reports err.Error() rather than a generic
// message: this server is a loopback-only sidecar reachable solely by the
// app's own webview (plan section 1), so there is no untrusted caller to
// leak internals to, and a real message is what makes a desktop bug
// report actionable.
func ServerError(w http.ResponseWriter, err error) {
	Error(w, http.StatusInternalServerError, err.Error())
}

// Decode reads a JSON request body into dst, reporting a 400 and
// returning false when it can't.
func Decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		BadRequest(w, "Invalid JSON body")
		return false
	}
	return true
}
