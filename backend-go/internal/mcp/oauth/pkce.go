package oauth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
)

// GenerateVerifier ports the SDK's PKCE code_verifier generation (RFC 7636
// §4.1): 32 random bytes, base64url-encoded without padding, yielding a
// 43-character string -- within the spec's required 43-128 character
// range, matching every real-world MCP client's choice (more entropy than
// the minimum is never wrong; less would violate the RFC).
func GenerateVerifier() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// Challenge derives the S256 PKCE code_challenge from a verifier (RFC 7636
// §4.2): base64url(sha256(verifier)), no padding. Plain-method PKCE
// ("code_challenge_method=plain") is deliberately not offered -- S256 is
// mandatory for any client implementing PKCE per RFC 7636 §4.3 when the
// authorization server supports it, and every MCP OAuth server that
// requires PKCE at all supports S256.
func Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// GenerateState is the CSRF-correlation state parameter (RFC 6749 §10.12):
// 24 random bytes, base64url-encoded -- reused as the primary key
// correlating an authorization redirect back to its pending
// mcp_oauth_session row (models.McpOAuthSession.State has a unique index).
func GenerateState() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
