package storage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadOrCreateSigningSecret_ReturnsTheSameSecretOnEveryCall(t *testing.T) {
	dir := t.TempDir()

	first, err := LoadOrCreateSigningSecret(dir)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	second, err := LoadOrCreateSigningSecret(dir)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}

	if string(first) != string(second) {
		t.Fatal("secret changed between calls -- every previously issued source URL would stop verifying")
	}
	if len(first) != 32 {
		t.Fatalf("secret length = %d, want 32", len(first))
	}
}

// This is the whole point of persisting the secret rather than reusing
// config.AuthToken: a URL minted before a restart must still verify after
// one, because it's stored inside a chat message.
func TestLoadOrCreateSigningSecret_SignedURLSurvivesARestart(t *testing.T) {
	dir := t.TempDir()

	firstSecret, _ := LoadOrCreateSigningSecret(dir)
	before, err := NewLocalStorage(dir, firstSecret, "http://127.0.0.1:1234")
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	url, err := before.PresignGetURL(context.Background(), "uploads/a.png", time.Hour)
	if err != nil {
		t.Fatalf("PresignGetURL: %v", err)
	}

	// "Restart": a brand-new process reading the same app-data dir.
	secondSecret, _ := LoadOrCreateSigningSecret(dir)
	after, _ := NewLocalStorage(dir, secondSecret, "http://127.0.0.1:5678")

	key, ok := after.KeyFromSignedURL(url)
	if !ok || key != "uploads/a.png" {
		t.Fatalf("got (%q, %v) -- URL issued before the restart no longer verifies", key, ok)
	}
}

func TestLoadOrCreateSigningSecret_WritesTheKeyFileOwnerReadableOnly(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadOrCreateSigningSecret(dir); err != nil {
		t.Fatalf("LoadOrCreateSigningSecret: %v", err)
	}

	info, err := os.Stat(filepath.Join(dir, signingKeyFile))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("permissions = %o, want 600", perm)
	}
}

func TestLoadOrCreateSigningSecret_RegeneratesFromACorruptedKeyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, signingKeyFile)
	if err := os.WriteFile(path, []byte("not-hex-at-all!!"), 0o600); err != nil {
		t.Fatalf("seed corrupt file: %v", err)
	}

	secret, err := LoadOrCreateSigningSecret(dir)
	if err != nil {
		t.Fatalf("LoadOrCreateSigningSecret: %v -- a corrupt key file must not be fatal", err)
	}
	if len(secret) != 32 {
		t.Fatalf("secret length = %d, want 32", len(secret))
	}

	// And the regenerated one is now the stable answer.
	again, _ := LoadOrCreateSigningSecret(dir)
	if string(secret) != string(again) {
		t.Fatal("regenerated secret was not persisted")
	}
}
