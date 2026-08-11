// Package oauth implements the MCP Authorization spec's client-side OAuth
// 2.1 flow (RFC 9728 protected-resource discovery, RFC 8414
// authorization-server discovery, RFC 7591 dynamic client registration,
// RFC 7636 PKCE, and the authorization-code/refresh-token grants) from
// scratch: better-chatbot gets all of this for free from
// @modelcontextprotocol/sdk's client/auth.js helper (create-mcp-client.ts
// just supplies a persistence adapter, pg-oauth-provider.ts, that the SDK
// calls into) -- there is no equivalent bundled implementation on the Go
// side (Bifrost's schemas.OAuth2Provider is only an interface an embedder
// must supply their own protocol logic for; internal/mcp/manager.go's own
// former doc comment explains why that's a structurally different model
// than better-chatbot's own database-agnostic auto-discovery). This
// package is that protocol logic, framework-agnostic and independently
// testable; internal/mcp/oauth_flow.go wires it into Manager's
// connect/authorize lifecycle.
package oauth

import "time"

// Metadata is what Discover resolves from a remote MCP server's URL: where
// to send the user to authorize, where to exchange a code for tokens, and
// (optionally) where to dynamically register a client.
type Metadata struct {
	AuthorizationEndpoint string
	TokenEndpoint         string
	RegistrationEndpoint  string // empty when the server doesn't support RFC 7591 DCR
}

// ClientInfo is the OAuth client identity used for this MCP server's
// flow -- either obtained via RegisterClient (RFC 7591) or, in principle,
// pre-configured (not exposed via any UI yet; DCR is the only path this
// package implements, matching every real MCP OAuth server's expectation
// that a client "just shows up" without prior manual registration).
type ClientInfo struct {
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret,omitempty"`
	RedirectURI  string `json:"redirectUri"`
}

// Tokens is one grant's result (authorization-code or refresh-token).
// ExpiresAt is the zero time when the server didn't report expires_in --
// treated as never-expiring rather than already-expired.
type Tokens struct {
	AccessToken  string    `json:"accessToken"`
	RefreshToken string    `json:"refreshToken,omitempty"`
	TokenType    string    `json:"tokenType"`
	ExpiresAt    time.Time `json:"expiresAt,omitempty"`
}

// Expired reports whether AccessToken should be refreshed before use, with
// a 30-second safety margin so a token that's about to expire mid-request
// still gets refreshed proactively.
func (t Tokens) Expired() bool {
	return !t.ExpiresAt.IsZero() && !time.Now().Add(30*time.Second).Before(t.ExpiresAt)
}

// AuthHeaderValue renders the Authorization header value for this token,
// defaulting TokenType to "Bearer" the way RFC 6749 says a client should
// when a server omits it (rare, but seen in the wild).
func (t Tokens) AuthHeaderValue() string {
	tokenType := t.TokenType
	if tokenType == "" {
		tokenType = "Bearer"
	}
	return tokenType + " " + t.AccessToken
}
