package storage

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Operation distinguishes an upload-slot token from a get/download token --
// the same op the S3 backend's PresignPutObject vs PresignGetObject draws.
type Operation string

const (
	OperationGet    Operation = "get"
	OperationUpload Operation = "upload"
)

var (
	ErrTokenExpired = errors.New("storage: signed token expired")
	ErrTokenInvalid = errors.New("storage: signed token invalid")
)

type tokenPayload struct {
	Key       string    `json:"key"`
	Operation Operation `json:"op"`
	ExpiresAt time.Time `json:"exp"`
}

// signToken and verifyToken implement the "short-lived signed paths served
// by the sidecar's own loopback HTTP server ... validated the same way the
// shared-secret auth middleware works" scheme plan section 3 describes for
// LocalStorage's "presigned URLs". The /storage/<token> HTTP handler that
// consumes them lives in internal/api/storage (Phase 6); this file only
// produces and validates the token itself.
func signToken(secret []byte, key string, op Operation, ttl time.Duration) (string, error) {
	payload := tokenPayload{Key: key, Operation: op, ExpiresAt: time.Now().Add(ttl)}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	encodedBody := base64.RawURLEncoding.EncodeToString(body)

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(encodedBody))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	return encodedBody + "." + signature, nil
}

// verifyToken checks the HMAC signature and expiry, and returns the
// key/operation it was issued for.
func verifyToken(secret []byte, token string) (string, Operation, error) {
	dot := -1
	for i := len(token) - 1; i >= 0; i-- {
		if token[i] == '.' {
			dot = i
			break
		}
	}
	if dot < 0 {
		return "", "", ErrTokenInvalid
	}
	encodedBody, signature := token[:dot], token[dot+1:]

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(encodedBody))
	expectedSignature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(signature), []byte(expectedSignature)) != 1 {
		return "", "", ErrTokenInvalid
	}

	body, err := base64.RawURLEncoding.DecodeString(encodedBody)
	if err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrTokenInvalid, err)
	}
	var payload tokenPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrTokenInvalid, err)
	}

	if time.Now().After(payload.ExpiresAt) {
		return "", "", ErrTokenExpired
	}

	return payload.Key, payload.Operation, nil
}
