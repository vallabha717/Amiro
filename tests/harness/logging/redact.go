// Package logging writes the run's structured artifacts: the per-surface
// NDJSON files, the merged events.ndjson timeline, and the raw stdio logs
// of every spawned process.
//
// Two properties matter more than anything else here.
//
// Redaction happens at WRITE TIME, never as a later pass. A secret that
// reaches disk once has leaked, and a cleanup step that runs afterwards is
// a cleanup step that does not run when the process crashes.
//
// Writes are streamed, never buffered until exit. A hung backend is exactly
// the case where its log matters most, and a logger that only flushes on a
// clean shutdown produces an empty file in precisely that case.
package logging

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"

	"amiro/tests/harness/config"
)

// Redactor replaces secrets with stable fingerprints.
//
// It works two ways at once, because neither alone is enough:
//
//   - by VALUE: any configured secret's literal text, wherever it appears.
//     This catches a key echoed into a stack trace or a URL.
//   - by FIELD NAME: the value of any header or JSON field named in
//     providers.redact, whatever it contains. This catches a session token
//     the harness never saw configured.
type Redactor struct {
	// mu guards secrets only. fields is set once in NewRedactor and never
	// mutated afterward, so concurrent reads of it need no lock.
	//
	// secrets DOES mutate after construction -- Add is called by every
	// concurrently-started backend.Start with that test's own generated
	// token -- and is read on every single log write (String/Bytes/JSON),
	// from a Logger shared by every Harness in the process. Two tests
	// started in parallel (exactly what suites/meta's own
	// TestBackends_StartedConcurrentlyDoNotCollide exists to allow) race
	// on this slice without a lock; found by running that guard under
	// -race, which is the whole reason it -- and this comment -- exist.
	mu      sync.RWMutex
	secrets []string
	fields  map[string]bool
}

// NewRedactor builds a redactor from the resolved configuration.
func NewRedactor(cfg *config.Config) *Redactor {
	fields := map[string]bool{}
	for _, f := range cfg.RedactFieldNames() {
		if f != "" {
			fields[f] = true
		}
	}
	return &Redactor{secrets: cfg.Secrets(), fields: fields}
}

// Add registers a runtime secret -- a generated auth token, a session
// bearer -- that was not in the config file. Called by harness/backend for
// every per-test AMIRO_AUTH_TOKEN it mints.
func (r *Redactor) Add(secret string) {
	if len(strings.TrimSpace(secret)) < 6 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.secrets {
		if s == secret {
			return
		}
	}
	// Prepended rather than appended so the newest, and in practice the
	// longest-lived, secret is matched first; String() relies on longer
	// secrets being replaced before any shorter prefix of them.
	r.secrets = append([]string{secret}, r.secrets...)
	sortByLengthDesc(r.secrets)
}

// Secrets returns the current secret set, for suites/meta's leak guard.
func (r *Redactor) Secrets() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return append([]string(nil), r.secrets...)
}

// String replaces every known secret value in s.
func (r *Redactor) String(s string) string {
	if s == "" {
		return s
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, secret := range r.secrets {
		if strings.Contains(s, secret) {
			s = strings.ReplaceAll(s, secret, config.Fingerprint(secret))
		}
	}
	return s
}

// Bytes is String for a byte slice, avoiding the round trip when nothing
// matches -- which is the overwhelmingly common case on a stdout stream.
func (r *Redactor) Bytes(b []byte) []byte {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, secret := range r.secrets {
		if bytes.Contains(b, []byte(secret)) {
			b = bytes.ReplaceAll(b, []byte(secret), []byte(config.Fingerprint(secret)))
		}
	}
	return b
}

// Header redacts one header value, by name and then by value.
func (r *Redactor) Header(name, value string) string {
	if r.fields[strings.ToLower(name)] {
		return config.Fingerprint(value)
	}
	return r.String(value)
}

// JSON redacts a JSON document by field name, recursively, then by value.
//
// Non-JSON input is passed through String() rather than rejected: a body
// logged as JSON that turns out to be an HTML error page still needs its
// secrets removed, and failing to log it at all would lose the evidence.
func (r *Redactor) JSON(raw []byte) []byte {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return r.Bytes(raw)
	}
	cleaned := r.value(v)
	out, err := marshal(cleaned)
	if err != nil {
		return r.Bytes(raw)
	}
	return out
}

func (r *Redactor) value(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, child := range t {
			if r.fields[strings.ToLower(k)] {
				if s, ok := child.(string); ok {
					out[k] = config.Fingerprint(s)
					continue
				}
				// A redacted field holding a non-string (an object of
				// per-provider keys, say) is replaced wholesale rather than
				// walked -- the field name already said not to look inside.
				out[k] = "<redacted>"
				continue
			}
			out[k] = r.value(child)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, child := range t {
			out[i] = r.value(child)
		}
		return out
	case string:
		return r.String(t)
	default:
		return v
	}
}

func sortByLengthDesc(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && len(s[j]) > len(s[j-1]); j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
