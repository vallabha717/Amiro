package export_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestExport_ListEmptyInitially verifies a new user has no exports.
func TestExport_ListEmptyInitially(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	exports, err := user.ListExports(t.Context())
	if err != nil {
		t.Fatalf("ListExports: %v", err)
	}
	if len(exports) != 0 {
		t.Errorf("expected 0 exports initially, got %d", len(exports))
	}
}

// TestExport_PublicReadIsAllowedWithoutSession verifies that reading an export and its comments
// works anonymously (via OptionalSession).
func TestExport_PublicReadIsAllowedWithoutSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()
	nonexistentID := "nonexistent-export-id"

	// GET /api/export/{id} without session returns 404 (not 401)
	_, err := anon.GetExport(t.Context(), nonexistentID)
	if err == nil {
		t.Fatal("expected error getting nonexistent export")
	}
	if status := apiclient.StatusOf(err); status != 404 {
		t.Errorf("anonymous GetExport status = %d, want 404", status)
	}

	// GET /api/export/{id}/comments without session returns 200 with empty list []
	comments, err := anon.ExportComments(t.Context(), nonexistentID)
	if err != nil {
		t.Fatalf("anonymous ExportComments: %v", err)
	}
	if len(comments) != 0 {
		t.Errorf("expected 0 comments on nonexistent export, got %d", len(comments))
	}
}

// TestExport_DeleteRequiresAuthenticationAndOwnership asserts unauthenticated or non-owner deletes are rejected.
func TestExport_DeleteRequiresAuthenticationAndOwnership(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()
	user := h.As("user")
	nonexistentID := "nonexistent-export-id"

	// Anonymous delete is rejected with 401
	err := anon.DeleteExport(t.Context(), nonexistentID)
	if err == nil {
		t.Fatal("expected anonymous DeleteExport to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous DeleteExport status = %d, want 401", status)
	}

	// Authenticated delete on nonexistent export returns 403 (CheckAccess returns false)
	err = user.DeleteExport(t.Context(), nonexistentID)
	if err == nil {
		t.Fatal("expected authenticated DeleteExport on nonexistent export to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("DeleteExport nonexistent status = %d, want 403", status)
	}
}

// TestExport_CommentsRequireAuthenticationOnWrite asserts POST/DELETE comments requires a session.
func TestExport_CommentsRequireAuthenticationOnWrite(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()
	user := h.As("user")
	nonexistentID := "nonexistent-export-id"

	// Anonymous comment creation is rejected with 401
	_, err := anon.AddExportComment(t.Context(), nonexistentID, map[string]any{
		"content": map[string]string{"text": "Nice conversation!"},
	})
	if err == nil {
		t.Fatal("expected anonymous AddExportComment to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous AddExportComment status = %d, want 401", status)
	}

	// Authenticated comment creation on nonexistent export returns 404 (export must exist)
	_, err = user.AddExportComment(t.Context(), nonexistentID, map[string]any{
		"content": map[string]string{"text": "Nice conversation!"},
	})
	if err == nil {
		t.Fatal("expected AddExportComment on nonexistent export to fail")
	}
	if status := apiclient.StatusOf(err); status != 404 {
		t.Errorf("AddExportComment nonexistent export status = %d, want 404", status)
	}

	// Authenticated comment deletion on nonexistent comment returns 403 (CheckCommentAccess returns false)
	err = user.DeleteExportComment(t.Context(), nonexistentID, "nonexistent-comment-id")
	if err == nil {
		t.Fatal("expected DeleteExportComment on nonexistent comment to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("DeleteExportComment nonexistent status = %d, want 403", status)
	}
}
