package oauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRegisterClient_SendsPublicClientMetadataAndParsesResponse(t *testing.T) {
	var gotReq registerRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotReq)
		_ = json.NewEncoder(w).Encode(registerResponse{ClientID: "client-123", ClientSecret: "secret-abc"})
	}))
	defer srv.Close()

	info, err := RegisterClient(context.Background(), srv.URL, "http://127.0.0.1:9999/callback", "better-chatbot-my-server")
	if err != nil {
		t.Fatalf("RegisterClient: %v", err)
	}
	if info.ClientID != "client-123" || info.ClientSecret != "secret-abc" || info.RedirectURI != "http://127.0.0.1:9999/callback" {
		t.Fatalf("got %+v", info)
	}
	if gotReq.TokenEndpointAuthMethod != "none" {
		t.Fatalf("token_endpoint_auth_method = %q, want \"none\" (PKCE public client)", gotReq.TokenEndpointAuthMethod)
	}
	if len(gotReq.RedirectURIs) != 1 || gotReq.RedirectURIs[0] != "http://127.0.0.1:9999/callback" {
		t.Fatalf("redirect_uris = %v", gotReq.RedirectURIs)
	}
	if len(gotReq.GrantTypes) != 2 {
		t.Fatalf("grant_types = %v, want authorization_code + refresh_token", gotReq.GrantTypes)
	}
}

func TestRegisterClient_ServerErrorSurfaces(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()

	_, err := RegisterClient(context.Background(), srv.URL, "http://x/callback", "name")
	if err == nil {
		t.Fatal("expected an error for a non-2xx registration response")
	}
}

func TestRegisterClient_MissingClientIDIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(registerResponse{})
	}))
	defer srv.Close()

	_, err := RegisterClient(context.Background(), srv.URL, "http://x/callback", "name")
	if err == nil {
		t.Fatal("expected an error when the response has no client_id")
	}
}
