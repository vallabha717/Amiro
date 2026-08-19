package bookmark_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestBookmark_CreateAndDeleteWithAgent exercises bookmarking and un-bookmarking an agent.
func TestBookmark_CreateAndDeleteWithAgent(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	agent, err := user.CreateAgent(t.Context(), apiclient.AgentInput{
		Name:       "Bookmarkable Agent",
		Visibility: "private",
	})
	if err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	// Create bookmark
	if err := user.Bookmark(t.Context(), agent.ID, "agent"); err != nil {
		t.Fatalf("Bookmark agent: %v", err)
	}

	// Idempotent bookmark creation
	if err := user.Bookmark(t.Context(), agent.ID, "agent"); err != nil {
		t.Fatalf("idempotent Bookmark agent: %v", err)
	}

	// Delete bookmark
	if err := user.Unbookmark(t.Context(), agent.ID, "agent"); err != nil {
		t.Fatalf("Unbookmark agent: %v", err)
	}

	// Idempotent unbookmark
	if err := user.Unbookmark(t.Context(), agent.ID, "agent"); err != nil {
		t.Fatalf("idempotent Unbookmark agent: %v", err)
	}
}

// TestBookmark_ValidationRejectsInvalidType verifies invalid itemType is rejected with 400.
func TestBookmark_ValidationRejectsInvalidType(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	err := user.Bookmark(t.Context(), "some-item-id", "invalid_type")
	if err == nil {
		t.Fatal("expected Bookmark with invalid itemType to fail")
	}
	if status := apiclient.StatusOf(err); status != 400 {
		t.Errorf("invalid itemType status = %d, want 400", status)
	}
}

// TestBookmark_NonexistentItemReturns404 asserts attempting to bookmark a missing item fails with 404.
func TestBookmark_NonexistentItemReturns404(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	err := user.Bookmark(t.Context(), "nonexistent-agent-id", "agent")
	if err == nil {
		t.Fatal("expected Bookmark nonexistent agent to fail")
	}
	if status := apiclient.StatusOf(err); status != 404 {
		t.Errorf("nonexistent agent status = %d, want 404", status)
	}
}

// TestBookmark_RequireSession verifies unauthenticated calls are rejected with 401.
func TestBookmark_RequireSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()

	err := anon.Bookmark(t.Context(), "some-id", "agent")
	if err == nil {
		t.Fatal("expected anonymous Bookmark to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous Bookmark status = %d, want 401", status)
	}
}
