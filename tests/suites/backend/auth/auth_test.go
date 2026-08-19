package auth_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestAuth_StatusReflectsDatabaseState verifies that the initial database
// state reports isFirstUser=true, and after the first user is registered,
// isFirstUser becomes false.
func TestAuth_StatusReflectsDatabaseState(t *testing.T) {
	h := harness.New(t, harness.NoSeed())
	client := h.Client()

	status, err := client.AuthStatus(t.Context())
	if err != nil {
		t.Fatalf("getting auth status on empty database: %v", err)
	}
	if !status.IsFirstUser {
		t.Fatal("expected isFirstUser to be true on an empty database")
	}

	_, err = client.Register(t.Context(), "Admin User", "admin@example.com", "validpassword123")
	if err != nil {
		t.Fatalf("registering initial user: %v", err)
	}

	statusAfter, err := client.AuthStatus(t.Context())
	if err != nil {
		t.Fatalf("getting auth status after registration: %v", err)
	}
	if statusAfter.IsFirstUser {
		t.Fatal("expected isFirstUser to be false after user registered")
	}
}

// TestAuth_FirstAccountBecomesAdminAndSubsequentAccountsAreUsers ensures the
// role assignment rule holds: first registered account gets role=admin,
// second registered account gets role=user.
func TestAuth_FirstAccountBecomesAdminAndSubsequentAccountsAreUsers(t *testing.T) {
	h := harness.New(t, harness.NoSeed())
	client := h.Client()

	first, err := client.Register(t.Context(), "First User", "first@example.com", "validpassword123")
	if err != nil {
		t.Fatalf("registering first user: %v", err)
	}
	if first.User.Role != "admin" {
		t.Errorf("first user role = %q, want %q", first.User.Role, "admin")
	}

	second, err := client.Register(t.Context(), "Second User", "second@example.com", "validpassword123")
	if err != nil {
		t.Fatalf("registering second user: %v", err)
	}
	if second.User.Role != "user" {
		t.Errorf("second user role = %q, want %q", second.User.Role, "user")
	}
}

// TestAuth_DuplicateEmailIsRejected asserts that registering with an already
// existing email address fails with a client error (400 or 409).
func TestAuth_DuplicateEmailIsRejected(t *testing.T) {
	h := harness.New(t, harness.NoSeed())
	client := h.Client()

	_, err := client.Register(t.Context(), "User One", "dup@example.com", "validpassword123")
	if err != nil {
		t.Fatalf("registering initial user: %v", err)
	}

	_, err = client.Register(t.Context(), "User Two", "dup@example.com", "anotherpassword123")
	if err == nil {
		t.Fatal("expected registering duplicate email to fail, but got nil error")
	}
	status := apiclient.StatusOf(err)
	if status != 400 && status != 409 {
		t.Errorf("duplicate email status = %d, want 400 or 409", status)
	}
}

// TestAuth_LoginWithValidAndInvalidCredentials verifies password validation.
func TestAuth_LoginWithValidAndInvalidCredentials(t *testing.T) {
	h := harness.New(t, harness.NoSeed())
	client := h.Client()

	_, err := client.Register(t.Context(), "Login User", "login@example.com", "correctpassword123")
	if err != nil {
		t.Fatalf("registering user: %v", err)
	}

	sess, err := client.Login(t.Context(), "login@example.com", "correctpassword123")
	if err != nil {
		t.Fatalf("logging in with correct password: %v", err)
	}
	if sess.Token == "" {
		t.Error("expected non-empty session token on successful login")
	}

	_, err = client.Login(t.Context(), "login@example.com", "wrongpassword")
	if err == nil {
		t.Fatal("expected login with wrong password to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("wrong password status = %d, want 401", status)
	}

	_, err = client.Login(t.Context(), "nonexistent@example.com", "anypassword")
	if err == nil {
		t.Fatal("expected login with unknown email to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("unknown user status = %d, want 401", status)
	}
}

// TestAuth_LogoutInvalidatesSession verifies that calling POST /api/auth/logout
// revokes the session token, causing subsequent GET /api/auth/session to fail with 401.
func TestAuth_LogoutInvalidatesSession(t *testing.T) {
	h := harness.New(t, harness.NoSeed())
	client := h.Client()

	sess, err := client.Register(t.Context(), "Logout User", "logout@example.com", "validpassword123")
	if err != nil {
		t.Fatalf("registering user: %v", err)
	}

	authed := client.As("logout-user", sess.Token)
	me, err := authed.Me(t.Context())
	if err != nil {
		t.Fatalf("calling /api/auth/session before logout: %v", err)
	}
	if me.Email != "logout@example.com" {
		t.Errorf("me.Email = %q, want %q", me.Email, "logout@example.com")
	}

	if err := authed.Logout(t.Context()); err != nil {
		t.Fatalf("POST /api/auth/logout: %v", err)
	}

	_, err = authed.Me(t.Context())
	if err == nil {
		t.Fatal("expected /api/auth/session to fail after logout")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("session lookup after logout status = %d, want 401", status)
	}
}

// TestAuth_RequireSessionRejectsAbsentOrMalformedToken tests the session middleware.
func TestAuth_RequireSessionRejectsAbsentOrMalformedToken(t *testing.T) {
	h := harness.New(t)

	anon := h.Client().Anonymous()
	_, err := anon.Me(t.Context())
	if err == nil {
		t.Fatal("expected anonymous /api/auth/session to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("anonymous session status = %d, want 401", status)
	}

	malformed := h.Client().As("bogus", "not-a-valid-session-token")
	_, err = malformed.Me(t.Context())
	if err == nil {
		t.Fatal("expected malformed session token to fail")
	}
	if status := apiclient.StatusOf(err); status != 401 {
		t.Errorf("malformed session status = %d, want 401", status)
	}
}
