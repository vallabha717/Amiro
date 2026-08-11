package secrets

import (
	"context"
	"testing"
)

func TestEnvStore_GetReturnsFalseWhenUnset(t *testing.T) {
	t.Setenv("DEFINITELY_NOT_SET_API_KEY", "")
	store := NewEnvStore()
	_, ok, err := store.Get(context.Background(), "definitely_not_set")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if ok {
		t.Fatal("expected ok=false for an unset env var")
	}
}

func TestEnvStore_GetReadsMechanicalProviderEnvVar(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "sk-test-123")
	store := NewEnvStore()
	key, ok, err := store.Get(context.Background(), "openai")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !ok || key != "sk-test-123" {
		t.Fatalf("key = %q, ok = %v, want %q, true", key, ok, "sk-test-123")
	}
}

func TestEnvStore_GetUsesOverrideForIrregularProviderName(t *testing.T) {
	t.Setenv("GOOGLE_GENERATIVE_AI_API_KEY", "goog-test-456")
	store := NewEnvStore()
	key, ok, err := store.Get(context.Background(), "google")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !ok || key != "goog-test-456" {
		t.Fatalf("key = %q, ok = %v, want %q, true", key, ok, "goog-test-456")
	}
}

func TestEnvStore_SetIsReadOnly(t *testing.T) {
	store := NewEnvStore()
	if err := store.Set(context.Background(), "openai", "sk-whatever"); err != ErrReadOnly {
		t.Fatalf("err = %v, want ErrReadOnly", err)
	}
}

func TestEnvStore_DeleteIsReadOnly(t *testing.T) {
	store := NewEnvStore()
	if err := store.Delete(context.Background(), "openai"); err != ErrReadOnly {
		t.Fatalf("err = %v, want ErrReadOnly", err)
	}
}
