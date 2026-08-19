package secrets

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/zalando/go-keyring"
)

const (
	keyringService       = "amiro"
	legacyKeyringService = "betterchatbot"
)

type KeyringStore struct {
	mu           sync.Mutex
	memFallback  map[string]string
	fallbackFile string
}

func NewKeyringStore(appDataDir string) *KeyringStore {
	fallbackFile := filepath.Join(appDataDir, "keys.json")
	store := &KeyringStore{
		memFallback:  make(map[string]string),
		fallbackFile: fallbackFile,
	}
	store.loadFallback()
	return store
}

func (s *KeyringStore) loadFallback() {
	b, err := os.ReadFile(s.fallbackFile)
	if err == nil {
		_ = json.Unmarshal(b, &s.memFallback)
	}
}

func (s *KeyringStore) saveFallback() {
	b, err := json.Marshal(s.memFallback)
	if err == nil {
		_ = os.WriteFile(s.fallbackFile, b, 0600)
	}
}

// Get never returns an error: the file-store fallback is the documented
// mitigation for "keyring unavailable over SSH / headless Linux" (plan
// §2.7's risk table -- "must not hard-fail"), and a caller can't act on
// that error differently than on ok=false, so the two used to collapse
// into one anyway everywhere it mattered except here. Found the hard way:
// `amiro auth whoami` after a `logout` in this exact environment (a
// session D-Bus with no org.freedesktop.secrets provider registered on
// it) surfaced the raw dbus error instead of "not signed in" -- the one
// case where the fallback file legitimately has no answer either (the key
// was just deleted from it), which is also just "not set," not a failure.
func (s *KeyringStore) Get(_ context.Context, provider string) (string, bool, error) {
	key, err := keyring.Get(keyringService, provider)
	if errors.Is(err, keyring.ErrNotFound) || err != nil {
		// Fallback to check legacy keyring service name
		if legacyKey, legacyErr := keyring.Get(legacyKeyringService, provider); legacyErr == nil && legacyKey != "" {
			return legacyKey, true, nil
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if errors.Is(err, keyring.ErrNotFound) || err != nil {
		if val, ok := s.memFallback[provider]; ok {
			return val, true, nil
		}
		return "", false, nil
	}
	return key, true, nil
}

func (s *KeyringStore) Set(_ context.Context, provider, key string) error {
	err := keyring.Set(keyringService, provider, key)
	if err != nil {
		s.mu.Lock()
		s.memFallback[provider] = key
		s.saveFallback()
		s.mu.Unlock()
	}
	return nil
}

func (s *KeyringStore) Delete(_ context.Context, provider string) error {
	err := keyring.Delete(keyringService, provider)
	s.mu.Lock()
	delete(s.memFallback, provider)
	s.saveFallback()
	s.mu.Unlock()

	if errors.Is(err, keyring.ErrNotFound) || err != nil {
		return nil
	}
	return nil
}
