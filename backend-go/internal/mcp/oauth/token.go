package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    *int   `json:"expires_in"`
}

// ExchangeCode ports the SDK transport's finishAuth (RFC 6749 §4.1.3,
// authorization_code grant + RFC 7636 §4.5's code_verifier): trades the
// authorization code the callback received for an access/refresh token
// pair. client.ClientSecret is included only when the DCR response
// actually returned one (a pure-PKCE public client has none, and the form
// field is simply omitted -- matching token_endpoint_auth_method "none").
func ExchangeCode(ctx context.Context, tokenEndpoint string, client *ClientInfo, code, codeVerifier string) (*Tokens, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {client.RedirectURI},
		"client_id":     {client.ClientID},
		"code_verifier": {codeVerifier},
	}
	if client.ClientSecret != "" {
		form.Set("client_secret", client.ClientSecret)
	}
	return postForm(ctx, tokenEndpoint, form)
}

// Refresh ports the refresh_token grant (RFC 6749 §6): a server that
// didn't return a new refresh_token in its response means the original
// one is still valid and should keep being used, per the RFC's own
// "if omitted... the client should continue" guidance.
func Refresh(ctx context.Context, tokenEndpoint string, client *ClientInfo, refreshToken string) (*Tokens, error) {
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {client.ClientID},
	}
	if client.ClientSecret != "" {
		form.Set("client_secret", client.ClientSecret)
	}
	tokens, err := postForm(ctx, tokenEndpoint, form)
	if err != nil {
		return nil, err
	}
	if tokens.RefreshToken == "" {
		tokens.RefreshToken = refreshToken
	}
	return tokens, nil
}

func postForm(ctx context.Context, tokenEndpoint string, form url.Values) (*Tokens, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("oauth: token endpoint returned status %d: %s", resp.StatusCode, string(body))
	}

	var out tokenResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	if out.AccessToken == "" {
		return nil, fmt.Errorf("oauth: token response had no access_token")
	}

	tokens := &Tokens{AccessToken: out.AccessToken, RefreshToken: out.RefreshToken, TokenType: out.TokenType}
	if out.ExpiresIn != nil {
		tokens.ExpiresAt = time.Now().Add(time.Duration(*out.ExpiresIn) * time.Second)
	}
	return tokens, nil
}
