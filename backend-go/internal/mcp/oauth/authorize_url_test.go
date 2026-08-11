package oauth

import (
	"net/url"
	"testing"
)

func TestBuildAuthorizationURL_IncludesRequiredParams(t *testing.T) {
	raw, err := BuildAuthorizationURL("https://auth.example.com/authorize", "client-1", "http://127.0.0.1:9999/callback", "state-1", "challenge-1", "mcp:tools")
	if err != nil {
		t.Fatalf("BuildAuthorizationURL: %v", err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse result: %v", err)
	}
	q := u.Query()
	cases := map[string]string{
		"response_type":         "code",
		"client_id":             "client-1",
		"redirect_uri":          "http://127.0.0.1:9999/callback",
		"state":                 "state-1",
		"code_challenge":        "challenge-1",
		"code_challenge_method": "S256",
		"scope":                 "mcp:tools",
	}
	for k, want := range cases {
		if got := q.Get(k); got != want {
			t.Fatalf("query param %q = %q, want %q", k, got, want)
		}
	}
}

func TestBuildAuthorizationURL_OmitsEmptyScope(t *testing.T) {
	raw, err := BuildAuthorizationURL("https://auth.example.com/authorize", "client-1", "http://x/callback", "state-1", "challenge-1", "")
	if err != nil {
		t.Fatalf("BuildAuthorizationURL: %v", err)
	}
	u, _ := url.Parse(raw)
	if u.Query().Has("scope") {
		t.Fatal("expected no scope param when scope is empty")
	}
}

func TestBuildAuthorizationURL_PreservesExistingQueryParams(t *testing.T) {
	raw, err := BuildAuthorizationURL("https://auth.example.com/authorize?audience=api", "client-1", "http://x/callback", "state-1", "challenge-1", "")
	if err != nil {
		t.Fatalf("BuildAuthorizationURL: %v", err)
	}
	u, _ := url.Parse(raw)
	if u.Query().Get("audience") != "api" {
		t.Fatalf("expected the endpoint's own existing query params preserved, got %v", u.Query())
	}
}

func TestBuildAuthorizationURL_InvalidEndpointReturnsError(t *testing.T) {
	_, err := BuildAuthorizationURL("://not-a-url", "c", "r", "s", "ch", "")
	if err == nil {
		t.Fatal("expected an error for an invalid authorization endpoint")
	}
}
