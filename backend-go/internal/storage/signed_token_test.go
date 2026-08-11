package storage

import (
	"testing"
	"time"
)

func TestSignToken_VerifyTokenRoundTrips(t *testing.T) {
	secret := []byte("test-secret")
	token, err := signToken(secret, "chat-attachments/foo.png", OperationGet, time.Hour)
	if err != nil {
		t.Fatalf("signToken: %v", err)
	}

	key, op, err := verifyToken(secret, token)
	if err != nil {
		t.Fatalf("verifyToken: %v", err)
	}
	if key != "chat-attachments/foo.png" {
		t.Fatalf("key = %q", key)
	}
	if op != OperationGet {
		t.Fatalf("op = %q, want %q", op, OperationGet)
	}
}

func TestVerifyToken_RejectsExpiredToken(t *testing.T) {
	secret := []byte("test-secret")
	token, err := signToken(secret, "foo.png", OperationGet, -time.Hour)
	if err != nil {
		t.Fatalf("signToken: %v", err)
	}
	if _, _, err := verifyToken(secret, token); err != ErrTokenExpired {
		t.Fatalf("err = %v, want ErrTokenExpired", err)
	}
}

func TestVerifyToken_RejectsWrongSecret(t *testing.T) {
	token, err := signToken([]byte("secret-a"), "foo.png", OperationGet, time.Hour)
	if err != nil {
		t.Fatalf("signToken: %v", err)
	}
	if _, _, err := verifyToken([]byte("secret-b"), token); err != ErrTokenInvalid {
		t.Fatalf("err = %v, want ErrTokenInvalid", err)
	}
}

func TestVerifyToken_RejectsTamperedPayload(t *testing.T) {
	secret := []byte("test-secret")
	token, err := signToken(secret, "foo.png", OperationGet, time.Hour)
	if err != nil {
		t.Fatalf("signToken: %v", err)
	}
	tampered, err := signToken(secret, "bar.png", OperationGet, time.Hour)
	if err != nil {
		t.Fatalf("signToken: %v", err)
	}
	// Splice the second token's signature onto the first token's payload --
	// must not validate.
	dot := len(token)
	for i := len(token) - 1; i >= 0; i-- {
		if token[i] == '.' {
			dot = i
			break
		}
	}
	tamperedDot := len(tampered)
	for i := len(tampered) - 1; i >= 0; i-- {
		if tampered[i] == '.' {
			tamperedDot = i
			break
		}
	}
	forged := token[:dot] + tampered[tamperedDot:]
	if _, _, err := verifyToken(secret, forged); err != ErrTokenInvalid {
		t.Fatalf("err = %v, want ErrTokenInvalid", err)
	}
}

func TestVerifyToken_RejectsMalformedToken(t *testing.T) {
	if _, _, err := verifyToken([]byte("secret"), "not-a-valid-token"); err != ErrTokenInvalid {
		t.Fatalf("err = %v, want ErrTokenInvalid", err)
	}
}

func TestSignToken_UploadAndGetOperationsAreDistinguished(t *testing.T) {
	secret := []byte("test-secret")
	token, err := signToken(secret, "foo.png", OperationUpload, time.Hour)
	if err != nil {
		t.Fatalf("signToken: %v", err)
	}
	_, op, err := verifyToken(secret, token)
	if err != nil {
		t.Fatalf("verifyToken: %v", err)
	}
	if op != OperationUpload {
		t.Fatalf("op = %q, want %q", op, OperationUpload)
	}
}
