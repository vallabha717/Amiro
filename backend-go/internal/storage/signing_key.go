package storage

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SourceURLTTL is how long a LocalStorage "source URL" stays valid.
//
// It has to be long, not minutes: a source URL is persisted verbatim
// inside a chat message's parts (a `source-url` part naming an uploaded
// file or a generated image), so it's re-read every time that thread is
// reopened, potentially months later -- unlike a presigned *upload* slot,
// which is consumed within seconds of being issued.
//
// Known limitation, not fixed here: the URL also embeds the sidecar's
// loopback port, which is OS-assigned per launch (plan section 1), so a
// stored absolute URL stops resolving after a restart even while its token
// is still valid. Rewriting stored URLs against the live port is
// frontend-side work that belongs with Phase 7's decoupling, where every
// `/api/...` call learns the port from window.__BACKEND_PORT__ anyway.
const SourceURLTTL = 90 * 24 * time.Hour

// signingKeyFile is where the storage-signing secret is persisted, under
// the app-data dir alongside the SQLite database.
const signingKeyFile = "storage-signing.key"

// LoadOrCreateSigningSecret returns the persistent secret LocalStorage
// signs its presigned URLs with, generating and storing one on first run.
//
// Deliberately NOT config.Config.AuthToken, which internal/storage's own
// Phase 2 doc comment suggested passing: that token is regenerated on
// every launch (Rust mints a fresh one per spawn, and config.Load falls
// back to a random one for standalone runs), so every previously issued
// source URL would fail verification the moment the app restarts -- taking
// every image and attachment in the user's chat history with it. A secret
// that outlives the process has to live on disk with the data it protects.
func LoadOrCreateSigningSecret(dataDir string) ([]byte, error) {
	path := filepath.Join(dataDir, signingKeyFile)

	stored, err := os.ReadFile(path)
	if err == nil {
		secret, decodeErr := hex.DecodeString(strings.TrimSpace(string(stored)))
		if decodeErr == nil && len(secret) > 0 {
			return secret, nil
		}
		// A truncated or corrupted key file is regenerated rather than
		// treated as fatal: the only consequence is that previously issued
		// URLs stop verifying, which is already true if the file is
		// unreadable, and refusing to start would be worse.
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("storage: read signing key: %w", err)
	}

	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, fmt.Errorf("storage: generate signing key: %w", err)
	}
	if err := os.WriteFile(path, []byte(hex.EncodeToString(secret)), 0o600); err != nil {
		return nil, fmt.Errorf("storage: write signing key: %w", err)
	}
	return secret, nil
}
