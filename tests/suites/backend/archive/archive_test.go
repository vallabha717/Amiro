package archive_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestArchive_Lifecycle tests CRUD and item management for archives.
func TestArchive_Lifecycle(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	desc := "My projects archive"
	created, err := user.CreateArchive(t.Context(), "Projects", &desc)
	if err != nil {
		t.Fatalf("CreateArchive: %v", err)
	}
	if created.ID == "" {
		t.Fatal("expected non-empty archive ID")
	}
	if created.Name != "Projects" {
		t.Errorf("archive name = %q, want %q", created.Name, "Projects")
	}

	got, err := user.GetArchive(t.Context(), created.ID)
	if err != nil {
		t.Fatalf("GetArchive: %v", err)
	}
	if got.ID != created.ID || got.Name != "Projects" {
		t.Errorf("got archive mismatch: %+v", got)
	}

	newDesc := "Updated projects description"
	updated, err := user.UpdateArchive(t.Context(), created.ID, map[string]any{
		"name":        "Updated Projects",
		"description": newDesc,
	})
	if err != nil {
		t.Fatalf("UpdateArchive: %v", err)
	}
	if updated.Name != "Updated Projects" {
		t.Errorf("updated name = %q, want %q", updated.Name, "Updated Projects")
	}

	list, err := user.ListArchives(t.Context())
	if err != nil {
		t.Fatalf("ListArchives: %v", err)
	}
	found := false
	for _, a := range list {
		if a.ID == created.ID {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("archive %s not found in ListArchives output", created.ID)
	}

	// Add item to archive
	item, err := user.AddArchiveItem(t.Context(), created.ID, "sample-thread-item-id")
	if err != nil {
		t.Fatalf("AddArchiveItem: %v", err)
	}
	if item.ID == "" {
		t.Fatal("expected non-empty item ID")
	}

	items, err := user.ArchiveItems(t.Context(), created.ID)
	if err != nil {
		t.Fatalf("ArchiveItems: %v", err)
	}
	if len(items) != 1 {
		t.Errorf("expected 1 item in archive, got %d", len(items))
	}

	// Remove item from archive
	if err := user.RemoveArchiveItem(t.Context(), created.ID, item.ItemID); err != nil {
		t.Fatalf("RemoveArchiveItem: %v", err)
	}

	// Delete archive
	if err := user.DeleteArchive(t.Context(), created.ID); err != nil {
		t.Fatalf("DeleteArchive: %v", err)
	}

	_, err = user.GetArchive(t.Context(), created.ID)
	if err == nil {
		t.Fatal("expected GetArchive to fail after deletion")
	}
	if status := apiclient.StatusOf(err); status != 404 {
		t.Errorf("deleted archive lookup status = %d, want 404", status)
	}
}

// TestArchive_OwnershipIsolation asserts other users get 403 on another user's archive.
func TestArchive_OwnershipIsolation(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	other := h.As("other")

	desc := "Alice's secret archive"
	created, err := user.CreateArchive(t.Context(), "Alice Secret", &desc)
	if err != nil {
		t.Fatalf("CreateArchive: %v", err)
	}

	_, err = other.GetArchive(t.Context(), created.ID)
	if err == nil {
		t.Fatal("expected other user to be forbidden from viewing Alice's archive")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("other GetArchive status = %d, want 403", status)
	}

	_, err = other.UpdateArchive(t.Context(), created.ID, map[string]any{"name": "Hacked"})
	if err == nil {
		t.Fatal("expected other user to be forbidden from updating Alice's archive")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("other UpdateArchive status = %d, want 403", status)
	}

	err = other.DeleteArchive(t.Context(), created.ID)
	if err == nil {
		t.Fatal("expected other user to be forbidden from deleting Alice's archive")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("other DeleteArchive status = %d, want 403", status)
	}
}

// TestArchive_RequireSession verifies anonymous access is rejected with 401.
func TestArchive_RequireSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()

	_, err := anon.ListArchives(t.Context())
	if err == nil {
		t.Fatal("expected anonymous ListArchives to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous ListArchives status = %d, want 401", status)
	}
}
