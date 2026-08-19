package thread_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestThread_ListEmptyInitially verifies that a freshly created user has no threads.
func TestThread_ListEmptyInitially(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	threads, err := user.ListThreads(t.Context())
	if err != nil {
		t.Fatalf("listing threads: %v", err)
	}
	if len(threads) != 0 {
		t.Errorf("expected 0 threads initially, got %d", len(threads))
	}
}

// TestThread_GetNonexistentReturns404 asserts that looking up a missing thread returns 404.
func TestThread_GetNonexistentReturns404(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	_, err := user.GetThread(t.Context(), "nonexistent-thread-id")
	if err == nil {
		t.Fatal("expected error getting nonexistent thread")
	}
	if status := apiclient.StatusOf(err); status != 404 {
		t.Errorf("get nonexistent thread status = %d, want 404", status)
	}
}

// TestThread_RenameNonexistentReturns404 asserts that updating a missing thread returns 404.
func TestThread_RenameNonexistentReturns404(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	err := user.RenameThread(t.Context(), "nonexistent-thread-id", "New Name")
	if err == nil {
		t.Fatal("expected error renaming nonexistent thread")
	}
	if status := apiclient.StatusOf(err); status != 404 {
		t.Errorf("rename nonexistent thread status = %d, want 404", status)
	}
}

// TestThread_DeleteNonexistentReturns404 asserts that deleting a missing thread returns 404.
func TestThread_DeleteNonexistentReturns404(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	err := user.DeleteThread(t.Context(), "nonexistent-thread-id")
	if err == nil {
		t.Fatal("expected error deleting nonexistent thread")
	}
	if status := apiclient.StatusOf(err); status != 404 {
		t.Errorf("delete nonexistent thread status = %d, want 404", status)
	}
}

// TestThread_DeleteAllClearsUserThreads tests DELETE /api/thread with and without scope query param.
func TestThread_DeleteAllClearsUserThreads(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	if err := user.DeleteAllThreads(t.Context()); err != nil {
		t.Fatalf("DELETE /api/thread: %v", err)
	}

	// Also test ?scope=unarchived
	resp, err := user.Do(t.Context(), "DELETE", "/api/thread?scope=unarchived", nil, nil)
	if err != nil {
		t.Fatalf("DELETE /api/thread?scope=unarchived: %v", err)
	}
	if resp.Status != 200 {
		t.Errorf("expected 200 from delete unarchived, got %d", resp.Status)
	}
}

// TestThread_DeleteMessageAndTruncate verifies message-level deletion routes.
func TestThread_DeleteMessageAndTruncate(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	// Calling DeleteMessage on non-existent message is a success (idempotent DB delete)
	if err := user.DeleteMessage(t.Context(), "nonexistent-msg-id"); err != nil {
		t.Fatalf("DELETE /api/thread/messages/{id}: %v", err)
	}

	// Calling TruncateFrom on non-existent message is a success
	if err := user.TruncateFrom(t.Context(), "nonexistent-msg-id"); err != nil {
		t.Fatalf("POST /api/thread/messages/{id}/truncate: %v", err)
	}
}

// TestThread_RequireSession verifies anonymous access is rejected with 401.
func TestThread_RequireSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()

	_, err := anon.ListThreads(t.Context())
	if err == nil {
		t.Fatal("expected anonymous ListThreads to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous ListThreads status = %d, want 401", status)
	}

	err = anon.DeleteAllThreads(t.Context())
	if err == nil {
		t.Fatal("expected anonymous DeleteAllThreads to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous DeleteAllThreads status = %d, want 401", status)
	}
}
