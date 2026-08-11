package oauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDiscover_ResourceMetadataPointsToSeparateAuthServer(t *testing.T) {
	var authServerURL string
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/oauth-authorization-server" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(authServerMetadata{
			AuthorizationEndpoint: authServerURL + "/authorize",
			TokenEndpoint:         authServerURL + "/token",
			RegistrationEndpoint:  authServerURL + "/register",
		})
	}))
	defer auth.Close()
	authServerURL = auth.URL

	mcpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/oauth-protected-resource" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(protectedResourceMetadata{AuthorizationServers: []string{authServerURL}})
	}))
	defer mcpServer.Close()

	meta, err := Discover(context.Background(), mcpServer.URL)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if meta.AuthorizationEndpoint != authServerURL+"/authorize" {
		t.Fatalf("AuthorizationEndpoint = %q", meta.AuthorizationEndpoint)
	}
	if meta.TokenEndpoint != authServerURL+"/token" {
		t.Fatalf("TokenEndpoint = %q", meta.TokenEndpoint)
	}
	if meta.RegistrationEndpoint != authServerURL+"/register" {
		t.Fatalf("RegistrationEndpoint = %q", meta.RegistrationEndpoint)
	}
}

func TestDiscover_FallsBackToServersOwnOriginWhenNoResourceMetadata(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/oauth-protected-resource":
			http.NotFound(w, r)
		case "/.well-known/oauth-authorization-server":
			_ = json.NewEncoder(w).Encode(authServerMetadata{
				AuthorizationEndpoint: "https://self/authorize",
				TokenEndpoint:         "https://self/token",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	meta, err := Discover(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if meta.AuthorizationEndpoint != "https://self/authorize" {
		t.Fatalf("AuthorizationEndpoint = %q, want the server's own origin metadata", meta.AuthorizationEndpoint)
	}
}

func TestDiscover_FallsBackToOIDCDiscoveryDocument(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(authServerMetadata{
				AuthorizationEndpoint: "https://oidc/authorize",
				TokenEndpoint:         "https://oidc/token",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	meta, err := Discover(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if meta.AuthorizationEndpoint != "https://oidc/authorize" {
		t.Fatalf("AuthorizationEndpoint = %q, want the OIDC discovery fallback", meta.AuthorizationEndpoint)
	}
}

func TestDiscover_PathAwareWellKnownTriedBeforeRoot(t *testing.T) {
	var hits []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.Path)
		if r.URL.Path == "/.well-known/oauth-authorization-server/mcp" {
			_ = json.NewEncoder(w).Encode(authServerMetadata{
				AuthorizationEndpoint: "https://x/authorize",
				TokenEndpoint:         "https://x/token",
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	_, err := Discover(context.Background(), srv.URL+"/mcp")
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(hits) == 0 || hits[0] != "/.well-known/oauth-protected-resource/mcp" {
		t.Fatalf("expected the path-aware resource-metadata URL tried first, got hits: %v", hits)
	}
	found := false
	for _, h := range hits {
		if h == "/.well-known/oauth-authorization-server/mcp" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected the path-aware authorization-server URL to be tried, got hits: %v", hits)
	}
}

func TestDiscover_NoMetadataAnywhereReturnsErrNotSupported(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	_, err := Discover(context.Background(), srv.URL)
	if err == nil {
		t.Fatal("expected an error when no OAuth metadata exists anywhere")
	}
}

func TestDiscover_InvalidURLReturnsError(t *testing.T) {
	_, err := Discover(context.Background(), "not-a-url")
	if err == nil {
		t.Fatal("expected an error for an invalid server URL")
	}
}
