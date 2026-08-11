package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// LocalStorage is the desktop Storage backend: files live under the OS
// app-data directory (plan section 3), addressed by an app-chosen key
// (e.g. "chat-attachments/<uuid>/<filename>"). "Presigned URLs" are
// HMAC-signed, expiring tokens pointing at the sidecar's own loopback HTTP
// server, served by internal/api/storage's Serve/ReceiveUpload handlers;
// this type produces and validates the tokens.
type LocalStorage struct {
	root    string
	secret  []byte
	baseURL string
}

// NewLocalStorage roots all keys under dataDir/storage. secret signs
// presigned-URL tokens (pass the sidecar's per-launch shared secret --
// internal/config.Config.AuthToken -- so no separate secret needs
// managing). baseURL is the sidecar's own loopback origin, e.g.
// "http://127.0.0.1:<port>".
func NewLocalStorage(dataDir string, secret []byte, baseURL string) (*LocalStorage, error) {
	root := filepath.Join(dataDir, "storage")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("storage: create root: %w", err)
	}
	return &LocalStorage{root: root, secret: secret, baseURL: strings.TrimSuffix(baseURL, "/")}, nil
}

// resolve maps an app-chosen key to an on-disk path, rejecting anything
// that would escape root (path traversal via "..", an absolute path, etc).
//
// Explicitly rejects any ".." segment rather than relying on
// filepath.Clean's root-clamping behavior to defang it: Clean *would* make
// a key like "../../etc/passwd" land safely inside root (no actual
// escape), but silently -- the caller gets no error and the file lands at
// a location its own key didn't describe. An explicit reject surfaces that
// as the caller bug it almost certainly is, rather than masking it.
func (s *LocalStorage) resolve(key string) (string, error) {
	if key == "" {
		return "", fmt.Errorf("storage: empty key")
	}
	if filepath.IsAbs(key) {
		return "", fmt.Errorf("storage: key %q must be relative", key)
	}
	for _, part := range strings.Split(filepath.ToSlash(key), "/") {
		if part == ".." {
			return "", fmt.Errorf("storage: key %q must not contain \"..\" segments", key)
		}
	}

	path := filepath.Join(s.root, key)
	if path != s.root && !strings.HasPrefix(path, s.root+string(filepath.Separator)) {
		return "", fmt.Errorf("storage: key %q escapes storage root", key)
	}
	return path, nil
}

func (s *LocalStorage) Put(_ context.Context, key string, r io.Reader) error {
	path, err := s.resolve(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("storage: create parent dir: %w", err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("storage: open %q: %w", key, err)
	}
	defer f.Close()
	if _, err := io.Copy(f, r); err != nil {
		return fmt.Errorf("storage: write %q: %w", key, err)
	}
	return nil
}

func (s *LocalStorage) Get(_ context.Context, key string) (io.ReadCloser, error) {
	path, err := s.resolve(key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("storage: %q: %w", key, os.ErrNotExist)
		}
		return nil, fmt.Errorf("storage: open %q: %w", key, err)
	}
	return f, nil
}

func (s *LocalStorage) Delete(_ context.Context, key string) error {
	path, err := s.resolve(key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("storage: delete %q: %w", key, err)
	}
	return nil
}

func (s *LocalStorage) PresignUploadURL(_ context.Context, key string, ttl time.Duration) (string, error) {
	if _, err := s.resolve(key); err != nil {
		return "", err
	}
	token, err := signToken(s.secret, key, OperationUpload, ttl)
	if err != nil {
		return "", err
	}
	return s.baseURL + "/storage/" + token, nil
}

func (s *LocalStorage) PresignGetURL(_ context.Context, key string, ttl time.Duration) (string, error) {
	if _, err := s.resolve(key); err != nil {
		return "", err
	}
	token, err := signToken(s.secret, key, OperationGet, ttl)
	if err != nil {
		return "", err
	}
	return s.baseURL + "/storage/" + token, nil
}

// ValidateSignedToken checks a token from a /storage/<token> request URL
// and returns the key/operation it authorizes. Called by
// internal/api/storage's Serve and ReceiveUpload handlers.
func (s *LocalStorage) ValidateSignedToken(token string) (key string, op Operation, err error) {
	return verifyToken(s.secret, token)
}

// KeyFromSignedURL implements SignedURLResolver: a URL this backend issued
// carries an opaque signed token where an S3-style URL would carry the key
// itself, so recovering the key means verifying the token. Returns false
// for any URL that isn't one of ours (or whose token no longer verifies),
// letting KeyFromURL fall through to storageKeyFromUrl's pathname rule.
func (s *LocalStorage) KeyFromSignedURL(rawURL string) (string, bool) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", false
	}
	if !strings.HasPrefix(parsed.Path, signedPathPrefix) {
		return "", false
	}
	token := strings.TrimPrefix(parsed.Path, signedPathPrefix)
	key, _, err := verifyToken(s.secret, token)
	if err != nil {
		return "", false
	}
	return key, true
}

// SourceURL returns the long-lived, signed URL a stored file is referenced
// by from chat message parts -- the LocalStorage counterpart of
// FileStorage.getSourceUrl (file-storage.interface.ts:72). See
// SourceURLTTL for why it is long-lived and what still limits it.
func (s *LocalStorage) SourceURL(ctx context.Context, key string) (string, error) {
	return s.PresignGetURL(ctx, key, SourceURLTTL)
}
