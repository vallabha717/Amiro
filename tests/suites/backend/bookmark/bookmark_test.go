package bookmark_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestBookmark_CreateAlwaysDeniesNowThatAgentIsGone documents Phase 6's
// (docs/skills/) real consequence, not just its intent: agent was the only
// itemType CheckItemAccess ever granted, and it's gone. Workflow access was
// never implemented in the first place (the repository's own "TODO: Add
// workflow access check when workflows support bookmarking"), so every
// well-formed bookmark request is now a 404 -- the endpoint is inert, not
// merely narrowed. See backend-go/internal/db/repository/bookmark.go's
// CheckItemAccess doc comment.
func TestBookmark_CreateAlwaysDeniesNowThatAgentIsGone(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	err := user.Bookmark(t.Context(), "some-workflow-id", "workflow")
	if err == nil {
		t.Fatal("expected Bookmark to fail -- no itemType is bookmarkable anymore")
	}
	if status := apiclient.StatusOf(err); status != 404 {
		t.Errorf("status = %d, want 404", status)
	}
}

// TestBookmark_RejectsAgentItemType is the schema-level half: "agent" is no
// longer a recognized itemType at all, not merely one that always denies.
func TestBookmark_RejectsAgentItemType(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	err := user.Bookmark(t.Context(), "some-id", "agent")
	if err == nil {
		t.Fatal("expected Bookmark with itemType agent to fail")
	}
	if status := apiclient.StatusOf(err); status != 400 {
		t.Errorf("agent itemType status = %d, want 400 -- agent bookmarking was removed in Phase 6", status)
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

// TestBookmark_RequireSession verifies unauthenticated calls are rejected with 401.
func TestBookmark_RequireSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()

	err := anon.Bookmark(t.Context(), "some-id", "workflow")
	if err == nil {
		t.Fatal("expected anonymous Bookmark to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous Bookmark status = %d, want 401", status)
	}
}
