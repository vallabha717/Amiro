package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func newTestLocalStorage(t *testing.T) *LocalStorage {
	t.Helper()
	s, err := NewLocalStorage(t.TempDir(), []byte("test-secret"), "http://127.0.0.1:12345")
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	return s
}

func TestLocalStorage_PutThenGetRoundTrips(t *testing.T) {
	s := newTestLocalStorage(t)
	ctx := context.Background()

	if err := s.Put(ctx, "docs/hello.txt", strings.NewReader("hello world")); err != nil {
		t.Fatalf("Put: %v", err)
	}

	rc, err := s.Get(ctx, "docs/hello.txt")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer rc.Close()

	got, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if string(got) != "hello world" {
		t.Fatalf("content = %q, want %q", got, "hello world")
	}
}

func TestLocalStorage_GetOfMissingKeyReturnsNotExist(t *testing.T) {
	s := newTestLocalStorage(t)
	_, err := s.Get(context.Background(), "does/not/exist.txt")
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("err = %v, want wrapping os.ErrNotExist", err)
	}
}

func TestLocalStorage_DeleteRemovesFile(t *testing.T) {
	s := newTestLocalStorage(t)
	ctx := context.Background()
	if err := s.Put(ctx, "f.txt", bytes.NewReader([]byte("x"))); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := s.Delete(ctx, "f.txt"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.Get(ctx, "f.txt"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("err = %v, want os.ErrNotExist after Delete", err)
	}
}

func TestLocalStorage_DeleteOfMissingKeyIsNotAnError(t *testing.T) {
	s := newTestLocalStorage(t)
	if err := s.Delete(context.Background(), "never-existed.txt"); err != nil {
		t.Fatalf("Delete of a missing key should be a no-op, got: %v", err)
	}
}

func TestLocalStorage_RejectsPathTraversalKeys(t *testing.T) {
	s := newTestLocalStorage(t)
	ctx := context.Background()

	traversalKeys := []string{
		"../outside.txt",
		"../../etc/passwd",
		"docs/../../outside.txt",
	}
	for _, key := range traversalKeys {
		if err := s.Put(ctx, key, strings.NewReader("x")); err == nil {
			t.Errorf("Put(%q): expected an error, key should not escape storage root", key)
		}
	}
}

func TestLocalStorage_PresignGetURL_ProducesAValidatableToken(t *testing.T) {
	s := newTestLocalStorage(t)
	url, err := s.PresignGetURL(context.Background(), "docs/hello.txt", time.Hour)
	if err != nil {
		t.Fatalf("PresignGetURL: %v", err)
	}
	if !strings.HasPrefix(url, "http://127.0.0.1:12345/storage/") {
		t.Fatalf("url = %q, want the sidecar base URL + /storage/ prefix", url)
	}

	token := strings.TrimPrefix(url, "http://127.0.0.1:12345/storage/")
	key, op, err := s.ValidateSignedToken(token)
	if err != nil {
		t.Fatalf("ValidateSignedToken: %v", err)
	}
	if key != "docs/hello.txt" || op != OperationGet {
		t.Fatalf("key = %q, op = %q", key, op)
	}
}

func TestLocalStorage_PresignUploadURL_ProducesAnUploadToken(t *testing.T) {
	s := newTestLocalStorage(t)
	url, err := s.PresignUploadURL(context.Background(), "docs/new.txt", time.Hour)
	if err != nil {
		t.Fatalf("PresignUploadURL: %v", err)
	}
	token := strings.TrimPrefix(url, "http://127.0.0.1:12345/storage/")
	_, op, err := s.ValidateSignedToken(token)
	if err != nil {
		t.Fatalf("ValidateSignedToken: %v", err)
	}
	if op != OperationUpload {
		t.Fatalf("op = %q, want %q", op, OperationUpload)
	}
}

func TestLocalStorage_PresignURL_RejectsPathTraversalKey(t *testing.T) {
	s := newTestLocalStorage(t)
	if _, err := s.PresignGetURL(context.Background(), "../outside.txt", time.Hour); err == nil {
		t.Fatal("expected an error presigning a traversal key")
	}
}
