package secrets

import (
	"context"
	"strings"
	"testing"
)

// requireKeyringAvailable skips the test when no OS credential backend is
// reachable (e.g. this sandbox: a session D-Bus exists but no
// org.freedesktop.secrets provider is registered on it) -- the same
// gate-don't-fail treatment tests/migration gives the real-Postgres test
// for an environment-dependent dependency.
func requireKeyringAvailable(t *testing.T) *KeyringStore {
	t.Helper()
	store := NewKeyringStore(t.TempDir())
	const probeProvider = "betterchatbot-availability-probe"
	if err := store.Set(context.Background(), probeProvider, "probe"); err != nil {
		t.Skipf("OS keychain not available in this environment, skipping: %v", err)
	}
	t.Cleanup(func() { store.Delete(context.Background(), probeProvider) })
	return store
}

func TestKeyringStore_GetReturnsFalseWhenUnset(t *testing.T) {
	store := NewKeyringStore(t.TempDir())
	_, ok, err := store.Get(context.Background(), "never-set")
	if err != nil {
		skipIfHeadless(t, err)
		t.Fatalf("Get: %v", err)
	}
	if ok {
		t.Fatal("expected ok=false for a provider with no stored key")
	}
}

func skipIfHeadless(t *testing.T, err error) {
	if err != nil && strings.Contains(err.Error(), "The name org.freedesktop.secrets was not provided by any .service files") {
		t.Skipf("Skipping keyring test: %v", err)
	}
}

func TestKeyringStore_RoundTripSetsAndGetsValues(t *testing.T) {
	store := requireKeyringAvailable(t)
	const provider = "betterchatbot-test-openai"
	t.Cleanup(func() { store.Delete(context.Background(), provider) })

	if err := store.Set(context.Background(), provider, "sk-test-123"); err != nil {
		skipIfHeadless(t, err)
		t.Fatalf("Set: %v", err)
	}
	key, ok, err := store.Get(context.Background(), provider)
	if err != nil {
		skipIfHeadless(t, err)
		t.Fatalf("Get: %v", err)
	}
	if !ok || key != "sk-test-123" {
		t.Fatalf("key = %q, ok = %v, want %q, true", key, ok, "sk-test-123")
	}
}

func TestKeyringStore_DeleteRemovesKey(t *testing.T) {
	store := requireKeyringAvailable(t)
	const provider = "betterchatbot-test-anthropic"

	if err := store.Set(context.Background(), provider, "sk-test-456"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := store.Delete(context.Background(), provider); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	_, ok, err := store.Get(context.Background(), provider)
	if err != nil {
		skipIfHeadless(t, err)
		t.Fatalf("Get after delete: %v", err)
	}
	if ok {
		t.Fatal("expected the key to be gone after Delete")
	}
}

func TestKeyringStore_DeleteOfUnsetKeyIsNotAnError(t *testing.T) {
	store := requireKeyringAvailable(t)
	if err := store.Delete(context.Background(), "definitely-unset-provider"); err != nil {
		t.Fatalf("Delete of an unset key should be a no-op, got: %v", err)
	}
}

func TestNew_SelectsKeyringForDesktopAndEnvForWeb(t *testing.T) {
	if _, ok := New(true, t.TempDir()).(*KeyringStore); !ok {
		t.Fatal("New(true) should return a *KeyringStore")
	}
	if _, ok := New(false, t.TempDir()).(*EnvStore); !ok {
		t.Fatal("New(false) should return an *EnvStore")
	}
}
