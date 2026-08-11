package oauth

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func TestGenerateVerifier_LengthWithinRFC7636Range(t *testing.T) {
	v, err := GenerateVerifier()
	if err != nil {
		t.Fatalf("GenerateVerifier: %v", err)
	}
	if len(v) < 43 || len(v) > 128 {
		t.Fatalf("verifier length = %d, want 43-128 per RFC 7636 4.1", len(v))
	}
}

func TestGenerateVerifier_ProducesDistinctValues(t *testing.T) {
	a, _ := GenerateVerifier()
	b, _ := GenerateVerifier()
	if a == b {
		t.Fatal("expected two calls to produce different verifiers")
	}
}

func TestChallenge_MatchesRFC7636S256Derivation(t *testing.T) {
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	got := Challenge(verifier)

	sum := sha256.Sum256([]byte(verifier))
	want := base64.RawURLEncoding.EncodeToString(sum[:])
	if got != want {
		t.Fatalf("Challenge = %q, want %q", got, want)
	}
	if got != "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" {
		t.Fatalf("Challenge = %q, want the well-known RFC 7636 appendix B test vector", got)
	}
}

func TestGenerateState_ProducesDistinctValues(t *testing.T) {
	a, _ := GenerateState()
	b, _ := GenerateState()
	if a == "" || a == b {
		t.Fatalf("expected non-empty, distinct state values, got %q and %q", a, b)
	}
}
