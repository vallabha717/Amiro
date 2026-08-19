package config

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
)

// Fingerprint is what a secret becomes once redacted.
//
// The short hash is the point: it lets an assertion say "the same key was
// used in both requests" without any log, cassette or HAR file ever holding
// the key itself. Two different secrets produce two different markers, and
// the same secret produces the same marker across processes and runs.
func Fingerprint(secret string) string {
	if secret == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(secret))
	return "<redacted:sha256:" + hex.EncodeToString(sum[:])[:8] + ">"
}

// Secrets returns every literal value in the configuration that must never
// reach disk in the clear.
//
// This is the input to two things: harness/logging's write-time redactor,
// and suites/meta/secret_leak_test.go, which greps the entire produced log
// tree for each of these and fails if one appears. That second use is why
// account passwords are included even though they are only test passwords
// -- the redactor is being tested here, not the secrecy of a fixture.
//
// Short values are excluded. A one- or two-character "secret" would match
// half the bytes in the log tree and turn every run into a false positive;
// anything that short is not a credential in the first place.
func (c *Config) Secrets() []string {
	seen := map[string]bool{}
	add := func(s string) {
		s = strings.TrimSpace(s)
		if len(s) >= 6 {
			seen[s] = true
		}
	}
	for _, p := range c.Providers.LLM {
		add(p.APIKey)
	}
	for _, p := range c.Providers.Search {
		add(p.APIKey)
	}
	add(c.Accounts.Admin.Password)
	add(c.Accounts.User.Password)
	add(c.Accounts.Other.Password)
	for _, v := range c.Backend.Env {
		// Anything the user chose to inject into the backend's environment
		// is treated as sensitive. Over-redacting an innocuous value costs
		// nothing; under-redacting a real one is a leak.
		if looksSecret(v) {
			add(v)
		}
	}
	out := make([]string, 0, len(seen))
	for s := range seen {
		out = append(out, s)
	}
	// Longest first, so redacting "sk-abc123" before "sk-abc" cannot leave
	// a fragment of the longer secret behind.
	sort.Slice(out, func(i, j int) bool {
		if len(out[i]) != len(out[j]) {
			return len(out[i]) > len(out[j])
		}
		return out[i] < out[j]
	})
	return out
}

// looksSecret is a heuristic for backend.env values only. Everywhere else
// the schema says what is a secret; here the user supplies arbitrary keys.
func looksSecret(v string) bool {
	if len(v) < 16 {
		return false
	}
	return strings.HasPrefix(v, "sk-") || strings.HasPrefix(v, "sk_") ||
		strings.HasPrefix(v, "xai-") || strings.HasPrefix(v, "gsk_") ||
		strings.HasPrefix(v, "tvly-") || strings.HasPrefix(v, "AIza")
}

// RedactFieldNames returns the header and JSON field names whose values are
// replaced regardless of what they contain, lowercased for matching.
func (c *Config) RedactFieldNames() []string {
	out := make([]string, 0, len(c.Providers.Redact))
	for _, f := range c.Providers.Redact {
		out = append(out, strings.ToLower(strings.TrimSpace(f)))
	}
	return out
}

// Redacted returns a deep copy safe to serialise into run.json.
//
// Every secret becomes its fingerprint rather than being dropped, so
// run.json still answers "was a key configured for anthropic, and was it
// the same key as last run?" -- the two questions anyone actually asks of
// it -- without answering "what is the key".
func (c *Config) Redacted() Config {
	out := *c

	out.Providers.LLM = make([]LLMProvider, len(c.Providers.LLM))
	for i, p := range c.Providers.LLM {
		p.APIKey = Fingerprint(p.APIKey)
		p.Models = append([]string(nil), p.Models...)
		out.Providers.LLM[i] = p
	}
	out.Providers.Search = make([]SearchProvider, len(c.Providers.Search))
	for i, p := range c.Providers.Search {
		p.APIKey = Fingerprint(p.APIKey)
		out.Providers.Search[i] = p
	}
	out.Providers.Redact = append([]string(nil), c.Providers.Redact...)

	out.Accounts.Admin.Password = Fingerprint(c.Accounts.Admin.Password)
	out.Accounts.User.Password = Fingerprint(c.Accounts.User.Password)
	out.Accounts.Other.Password = Fingerprint(c.Accounts.Other.Password)

	out.Backend.Env = make(map[string]string, len(c.Backend.Env))
	for k, v := range c.Backend.Env {
		if looksSecret(v) {
			v = Fingerprint(v)
		}
		out.Backend.Env[k] = v
	}

	// Slices are shared with the original otherwise, and run.json is
	// written from a copy precisely so a later mutation cannot rewrite it.
	out.Run.Surfaces = append([]string(nil), c.Run.Surfaces...)
	out.Run.Features = append([]string(nil), c.Run.Features...)
	out.Run.Tags.Include = append([]string(nil), c.Run.Tags.Include...)
	out.Run.Tags.Exclude = append([]string(nil), c.Run.Tags.Exclude...)
	out.UI.Browsers = append([]string(nil), c.UI.Browsers...)
	out.MCP.External = append([]ExternalMCP(nil), c.MCP.External...)
	return out
}
