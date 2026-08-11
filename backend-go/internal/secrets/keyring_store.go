package secrets

import (
	"context"
	"errors"

	"github.com/zalando/go-keyring"
)

// keyringService is the OS keychain "service" namespace every provider key
// is stored under; the account/username slot holds the provider name
// (e.g. "openai", "anthropic").
const keyringService = "betterchatbot"

// KeyringStore is the desktop KeyStore, backed by the OS-native credential
// store (macOS Keychain, Windows Credential Manager, Secret
// Service/kwallet on Linux) via zalando/go-keyring.
type KeyringStore struct{}

func NewKeyringStore() *KeyringStore { return &KeyringStore{} }

func (KeyringStore) Get(_ context.Context, provider string) (string, bool, error) {
	key, err := keyring.Get(keyringService, provider)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return key, true, nil
}

func (KeyringStore) Set(_ context.Context, provider, key string) error {
	return keyring.Set(keyringService, provider, key)
}

func (KeyringStore) Delete(_ context.Context, provider string) error {
	err := keyring.Delete(keyringService, provider)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
