package admin_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestAdmin_NonAdminGetsForbiddenOnEveryRoute asserts that a plain user receives 403 on every admin endpoint.
func TestAdmin_NonAdminGetsForbiddenOnEveryRoute(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	targetID := "any-user-id"

	_, err := user.ListUsers(t.Context())
	if err == nil {
		t.Fatal("expected non-admin ListUsers to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("ListUsers non-admin status = %d, want 403", status)
	}

	_, err = user.GetUser(t.Context(), targetID)
	if err == nil {
		t.Fatal("expected non-admin GetUser to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("GetUser non-admin status = %d, want 403", status)
	}

	_, err = user.UserStatsByID(t.Context(), targetID)
	if err == nil {
		t.Fatal("expected non-admin UserStatsByID to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("UserStatsByID non-admin status = %d, want 403", status)
	}

	err = user.SetUserRole(t.Context(), targetID, "admin")
	if err == nil {
		t.Fatal("expected non-admin SetUserRole to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("SetUserRole non-admin status = %d, want 403", status)
	}

	err = user.BanUser(t.Context(), targetID, true, nil)
	if err == nil {
		t.Fatal("expected non-admin BanUser to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("BanUser non-admin status = %d, want 403", status)
	}

	err = user.DeleteUser(t.Context(), targetID)
	if err == nil {
		t.Fatal("expected non-admin DeleteUser to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("DeleteUser non-admin status = %d, want 403", status)
	}
}

// TestAdmin_Lifecycle exercises admin listing, inspecting, modifying role/ban, and deleting users.
func TestAdmin_Lifecycle(t *testing.T) {
	h := harness.New(t)
	admin := h.As("admin")

	page, err := admin.ListUsers(t.Context())
	if err != nil {
		t.Fatalf("ListUsers (admin): %v", err)
	}
	if page.Total < 3 || len(page.Users) < 3 {
		t.Errorf("expected at least 3 seeded users, got total=%d len=%d", page.Total, len(page.Users))
	}

	// Register a disposable user for admin operations
	disposable, err := h.Client().Register(t.Context(), "Disposable", "disposable@example.com", "validpassword123")
	if err != nil {
		t.Fatalf("Register disposable user: %v", err)
	}

	// Get disposable user
	got, err := admin.GetUser(t.Context(), disposable.User.ID)
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if got.ID != disposable.User.ID || got.Email != "disposable@example.com" {
		t.Errorf("got user mismatch: %+v", got)
	}

	// Get disposable user stats
	stats, err := admin.UserStatsByID(t.Context(), disposable.User.ID)
	if err != nil {
		t.Fatalf("UserStatsByID: %v", err)
	}
	if len(stats) == 0 {
		t.Error("expected non-empty JSON response from UserStatsByID")
	}

	// Update role to admin
	if err := admin.SetUserRole(t.Context(), disposable.User.ID, "admin"); err != nil {
		t.Fatalf("SetUserRole: %v", err)
	}

	// Ban user
	reason := "Violation of terms"
	if err := admin.BanUser(t.Context(), disposable.User.ID, true, &reason); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	// Unban user
	if err := admin.BanUser(t.Context(), disposable.User.ID, false, nil); err != nil {
		t.Fatalf("UnbanUser: %v", err)
	}

	// Delete user
	if err := admin.DeleteUser(t.Context(), disposable.User.ID); err != nil {
		t.Fatalf("DeleteUser: %v", err)
	}

	_, err = admin.GetUser(t.Context(), disposable.User.ID)
	if err == nil {
		t.Fatal("expected GetUser to fail after deletion")
	}
	if status := apiclient.StatusOf(err); status != 404 {
		t.Errorf("deleted user lookup status = %d, want 404", status)
	}
}

// TestAdmin_CannotDeleteSelf verifies that an admin is prevented from deleting their own account.
func TestAdmin_CannotDeleteSelf(t *testing.T) {
	h := harness.New(t)
	admin := h.As("admin")

	me, err := admin.Me(t.Context())
	if err != nil {
		t.Fatalf("Me: %v", err)
	}

	err = admin.DeleteUser(t.Context(), me.ID)
	if err == nil {
		t.Fatal("expected self-deletion attempt to fail")
	}
	if status := apiclient.StatusOf(err); status != 400 {
		t.Errorf("self-deletion status = %d, want 400", status)
	}
}

// TestAdmin_RequireSession verifies anonymous access is rejected with 401.
func TestAdmin_RequireSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()

	_, err := anon.ListUsers(t.Context())
	if err == nil {
		t.Fatal("expected anonymous ListUsers to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous ListUsers status = %d, want 401", status)
	}
}
