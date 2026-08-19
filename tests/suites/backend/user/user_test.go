package user_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestUser_DetailsAndStats exercises getting and updating details, plus querying stats.
func TestUser_DetailsAndStats(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	details, err := user.UserDetails(t.Context())
	if err != nil {
		t.Fatalf("UserDetails: %v", err)
	}
	if details.ID == "" || details.Email == "" {
		t.Errorf("invalid user details: %+v", details)
	}

	// Update user details
	newName := "Updated User Name"
	updated, err := user.UpdateUserDetails(t.Context(), map[string]any{
		"name": newName,
	})
	if err != nil {
		t.Fatalf("UpdateUserDetails: %v", err)
	}
	if updated.Name != newName {
		t.Errorf("updated name = %q, want %q", updated.Name, newName)
	}

	// Get user stats
	stats, err := user.UserStats(t.Context())
	if err != nil {
		t.Fatalf("UserStats: %v", err)
	}
	if len(stats) == 0 {
		t.Error("expected non-empty JSON response from UserStats")
	}

	// Get auth methods
	methods, err := user.AuthMethods(t.Context())
	if err != nil {
		t.Fatalf("AuthMethods: %v", err)
	}
	if len(methods) == 0 {
		t.Error("expected non-empty JSON response from AuthMethods")
	}
}

// TestUser_PreferencesRoundTrip verifies saving and retrieving user preferences.
func TestUser_PreferencesRoundTrip(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	prefData := map[string]any{
		"theme":      "dark",
		"fontSize":   14,
		"sendOnCtrl": true,
	}

	saved, err := user.SetPreferences(t.Context(), prefData)
	if err != nil {
		t.Fatalf("SetPreferences: %v", err)
	}
	if len(saved) == 0 {
		t.Error("expected non-empty JSON from SetPreferences")
	}

	got, err := user.Preferences(t.Context())
	if err != nil {
		t.Fatalf("Preferences: %v", err)
	}
	if len(got) == 0 {
		t.Error("expected non-empty JSON from Preferences")
	}
}

// TestUser_DetailsByIDPermissions asserts self and admin can read details, other plain user gets 403.
func TestUser_DetailsByIDPermissions(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	other := h.As("other")
	admin := h.As("admin")

	userDetails, err := user.UserDetails(t.Context())
	if err != nil {
		t.Fatalf("UserDetails: %v", err)
	}

	// Reading own details by ID succeeds
	selfDetails, err := user.UserDetailsByID(t.Context(), userDetails.ID)
	if err != nil {
		t.Fatalf("UserDetailsByID (self): %v", err)
	}
	if selfDetails.ID != userDetails.ID {
		t.Errorf("self details ID mismatch: %q vs %q", selfDetails.ID, userDetails.ID)
	}

	// Admin reading user details by ID succeeds
	adminRead, err := admin.UserDetailsByID(t.Context(), userDetails.ID)
	if err != nil {
		t.Fatalf("UserDetailsByID (admin): %v", err)
	}
	if adminRead.ID != userDetails.ID {
		t.Errorf("admin read ID mismatch: %q vs %q", adminRead.ID, userDetails.ID)
	}

	// Another plain user reading user details by ID gets 403
	_, err = other.UserDetailsByID(t.Context(), userDetails.ID)
	if err == nil {
		t.Fatal("expected other user reading user details by ID to fail")
	}
	if status := apiclient.StatusOf(err); status != 403 {
		t.Errorf("other UserDetailsByID status = %d, want 403", status)
	}
}

// TestUser_PasswordChange verifies changing the user password.
func TestUser_PasswordChange(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	oldPass := h.Config.Accounts.User.Password
	newPass := oldPass + "-updated-123"

	// Wrong current password fails with 401 Unauthorized
	err := user.ChangePassword(t.Context(), "wrong-current-password", newPass)
	if err == nil {
		t.Fatal("expected ChangePassword with wrong current password to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("wrong current password status = %d, want 401", status)
	}

	// Correct current password succeeds
	if err := user.ChangePassword(t.Context(), oldPass, newPass); err != nil {
		t.Fatalf("ChangePassword: %v", err)
	}

	// Login with new password succeeds
	_, err = h.Client().Login(t.Context(), h.Config.Accounts.User.Email, newPass)
	if err != nil {
		t.Fatalf("Login with new password: %v", err)
	}
}

// TestUser_RequireSession verifies anonymous access is rejected with 401.
func TestUser_RequireSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()

	_, err := anon.UserDetails(t.Context())
	if err == nil {
		t.Fatal("expected anonymous UserDetails to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous UserDetails status = %d, want 401", status)
	}
}
