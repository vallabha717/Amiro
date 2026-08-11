package oauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestExchangeCode_SendsAuthorizationCodeGrantWithVerifier(t *testing.T) {
	var gotBody url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotBody = r.Form
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"at-1","refresh_token":"rt-1","token_type":"Bearer","expires_in":3600}`))
	}))
	defer srv.Close()

	client := &ClientInfo{ClientID: "cid", ClientSecret: "csecret", RedirectURI: "http://x/callback"}
	tokens, err := ExchangeCode(context.Background(), srv.URL, client, "the-code", "the-verifier")
	if err != nil {
		t.Fatalf("ExchangeCode: %v", err)
	}
	if tokens.AccessToken != "at-1" || tokens.RefreshToken != "rt-1" || tokens.TokenType != "Bearer" {
		t.Fatalf("got %+v", tokens)
	}
	if tokens.ExpiresAt.Before(time.Now().Add(59 * time.Minute)) {
		t.Fatalf("ExpiresAt = %v, want ~1 hour from now", tokens.ExpiresAt)
	}

	if gotBody.Get("grant_type") != "authorization_code" {
		t.Fatalf("grant_type = %q", gotBody.Get("grant_type"))
	}
	if gotBody.Get("code") != "the-code" || gotBody.Get("code_verifier") != "the-verifier" {
		t.Fatalf("code/code_verifier missing or wrong: %v", gotBody)
	}
	if gotBody.Get("client_secret") != "csecret" {
		t.Fatalf("expected client_secret forwarded when present, got %v", gotBody)
	}
}

func TestExchangeCode_OmitsClientSecretForPublicClient(t *testing.T) {
	var gotBody url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotBody = r.Form
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"at-1","token_type":"Bearer"}`))
	}))
	defer srv.Close()

	client := &ClientInfo{ClientID: "cid", RedirectURI: "http://x/callback"} // no secret: PKCE public client
	if _, err := ExchangeCode(context.Background(), srv.URL, client, "code", "verifier"); err != nil {
		t.Fatalf("ExchangeCode: %v", err)
	}
	if gotBody.Has("client_secret") {
		t.Fatalf("expected no client_secret field for a public client, got %v", gotBody)
	}
}

func TestExchangeCode_NoExpiresInMeansNeverExpires(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"at-1","token_type":"Bearer"}`))
	}))
	defer srv.Close()

	tokens, err := ExchangeCode(context.Background(), srv.URL, &ClientInfo{ClientID: "cid", RedirectURI: "http://x"}, "code", "verifier")
	if err != nil {
		t.Fatalf("ExchangeCode: %v", err)
	}
	if !tokens.ExpiresAt.IsZero() {
		t.Fatalf("ExpiresAt = %v, want zero when server omits expires_in", tokens.ExpiresAt)
	}
	if tokens.Expired() {
		t.Fatal("a zero ExpiresAt should mean never-expired")
	}
}

func TestExchangeCode_NonSuccessStatusReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
	}))
	defer srv.Close()

	_, err := ExchangeCode(context.Background(), srv.URL, &ClientInfo{ClientID: "cid", RedirectURI: "http://x"}, "bad-code", "verifier")
	if err == nil {
		t.Fatal("expected an error for a non-2xx token response")
	}
}

func TestRefresh_KeepsOldRefreshTokenWhenServerOmitsANewOne(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "old-rt" {
			t.Fatalf("unexpected refresh request: %v", r.Form)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"new-at","token_type":"Bearer"}`))
	}))
	defer srv.Close()

	tokens, err := Refresh(context.Background(), srv.URL, &ClientInfo{ClientID: "cid", RedirectURI: "http://x"}, "old-rt")
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if tokens.AccessToken != "new-at" {
		t.Fatalf("AccessToken = %q", tokens.AccessToken)
	}
	if tokens.RefreshToken != "old-rt" {
		t.Fatalf("RefreshToken = %q, want the original preserved per RFC 6749 6", tokens.RefreshToken)
	}
}

func TestTokens_ExpiredHasSafetyMargin(t *testing.T) {
	tokens := Tokens{AccessToken: "x", ExpiresAt: time.Now().Add(10 * time.Second)}
	if !tokens.Expired() {
		t.Fatal("a token expiring in 10s should already report Expired (30s safety margin)")
	}
	tokens.ExpiresAt = time.Now().Add(5 * time.Minute)
	if tokens.Expired() {
		t.Fatal("a token expiring in 5 minutes should not yet report Expired")
	}
}

func TestTokens_AuthHeaderValueDefaultsToBearer(t *testing.T) {
	tokens := Tokens{AccessToken: "abc"}
	if got := tokens.AuthHeaderValue(); got != "Bearer abc" {
		t.Fatalf("got %q, want %q", got, "Bearer abc")
	}
	tokens.TokenType = "DPoP"
	if got := tokens.AuthHeaderValue(); got != "DPoP abc" {
		t.Fatalf("got %q, want %q", got, "DPoP abc")
	}
}
