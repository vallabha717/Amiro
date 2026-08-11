package oauth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

type registerRequest struct {
	ClientName              string   `json:"client_name"`
	RedirectURIs            []string `json:"redirect_uris"`
	GrantTypes              []string `json:"grant_types"`
	ResponseTypes           []string `json:"response_types"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
}

type registerResponse struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret,omitempty"`
}

// RegisterClient ports create-mcp-client.ts's createOAuthProvider client
// metadata (RFC 7591 dynamic client registration): a public client (PKCE,
// no client secret needed for the auth to be secure) requesting the
// authorization-code and refresh-token grants. token_endpoint_auth_method
// "none" mirrors the TS client's own choice -- PKCE is the actual proof of
// possession, not a client secret a desktop app couldn't keep
// confidential anyway.
func RegisterClient(ctx context.Context, registrationEndpoint, redirectURI, clientName string) (*ClientInfo, error) {
	body, err := json.Marshal(registerRequest{
		ClientName:              clientName,
		RedirectURIs:            []string{redirectURI},
		GrantTypes:              []string{"authorization_code", "refresh_token"},
		ResponseTypes:           []string{"code"},
		TokenEndpointAuthMethod: "none",
	})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, registrationEndpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("oauth: dynamic client registration failed: status %d", resp.StatusCode)
	}

	var out registerResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.ClientID == "" {
		return nil, fmt.Errorf("oauth: registration response had no client_id")
	}
	return &ClientInfo{ClientID: out.ClientID, ClientSecret: out.ClientSecret, RedirectURI: redirectURI}, nil
}
