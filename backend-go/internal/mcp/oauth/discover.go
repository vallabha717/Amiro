package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var httpClient = &http.Client{Timeout: 10 * time.Second}

// ErrNotSupported means Discover found no OAuth metadata at all for a
// server -- the caller should treat this exactly like the pre-OAuth
// behavior (surface whatever the original connection error was), not as
// a real failure of its own.
var ErrNotSupported = errors.New("oauth: server does not advertise OAuth metadata")

// protectedResourceMetadata is the subset of RFC 9728's
// oauth-protected-resource document this package reads.
type protectedResourceMetadata struct {
	AuthorizationServers []string `json:"authorization_servers"`
}

// authServerMetadata is the subset of RFC 8414's
// oauth-authorization-server document (also satisfied by an OIDC
// discovery document, which every field here happens to share the name
// of) this package reads.
type authServerMetadata struct {
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	RegistrationEndpoint  string `json:"registration_endpoint"`
}

// Discover ports the MCP Authorization spec's client discovery sequence
// (2025-06-18 revision): first RFC 9728 protected-resource metadata (to
// find which authorization server actually protects this MCP server),
// then RFC 8414 authorization-server metadata on that issuer -- falling
// back to OIDC discovery (many authorization servers only implement that
// document, not the OAuth-specific one) and, if step one finds nothing at
// all, to authorization-server metadata on the MCP server's own origin
// directly (the common case for a server that IS its own authorization
// server, e.g. many "click here to sign in" self-hosted MCP servers).
//
// Every well-known lookup tries the RFC's path-aware form first (the
// well-known segment inserted before the URL's own path, so a server
// mounted at a sub-path -- e.g. https://example.com/mcp -- is looked up at
// https://example.com/.well-known/oauth-authorization-server/mcp) then
// falls back to the origin-root form, matching real-world servers that
// only implement the simpler root form.
func Discover(ctx context.Context, serverURL string) (*Metadata, error) {
	u, err := url.Parse(serverURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("oauth: invalid server URL %q", serverURL)
	}

	issuer := u
	if prm, err := fetchProtectedResourceMetadata(ctx, u); err == nil && len(prm.AuthorizationServers) > 0 {
		if parsed, err := url.Parse(prm.AuthorizationServers[0]); err == nil {
			issuer = parsed
		}
	}

	asm, err := fetchAuthServerMetadata(ctx, issuer)
	if err != nil {
		return nil, err
	}
	if asm.AuthorizationEndpoint == "" || asm.TokenEndpoint == "" {
		return nil, ErrNotSupported
	}
	return &Metadata{
		AuthorizationEndpoint: asm.AuthorizationEndpoint,
		TokenEndpoint:         asm.TokenEndpoint,
		RegistrationEndpoint:  asm.RegistrationEndpoint,
	}, nil
}

func fetchProtectedResourceMetadata(ctx context.Context, u *url.URL) (*protectedResourceMetadata, error) {
	var prm protectedResourceMetadata
	for _, candidate := range wellKnownCandidates(u, "oauth-protected-resource") {
		if getJSON(ctx, candidate, &prm) == nil {
			return &prm, nil
		}
	}
	return nil, ErrNotSupported
}

func fetchAuthServerMetadata(ctx context.Context, u *url.URL) (*authServerMetadata, error) {
	var asm authServerMetadata
	candidates := wellKnownCandidates(u, "oauth-authorization-server")
	candidates = append(candidates, wellKnownCandidates(u, "openid-configuration")...)
	for _, candidate := range candidates {
		if getJSON(ctx, candidate, &asm) == nil && asm.AuthorizationEndpoint != "" {
			return &asm, nil
		}
	}
	return nil, ErrNotSupported
}

// wellKnownCandidates returns the path-aware well-known URL first, then
// the origin-root fallback -- deduplicated when u has no path (both forms
// would be identical).
func wellKnownCandidates(u *url.URL, wellKnownName string) []string {
	origin := &url.URL{Scheme: u.Scheme, Host: u.Host}
	root := origin.String() + "/.well-known/" + wellKnownName

	trimmedPath := strings.TrimSuffix(u.Path, "/")
	if trimmedPath == "" {
		return []string{root}
	}
	pathAware := origin.String() + "/.well-known/" + wellKnownName + trimmedPath
	return []string{pathAware, root}
}

func getJSON(ctx context.Context, rawURL string, dst any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("oauth: %s: status %d", rawURL, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(dst)
}
