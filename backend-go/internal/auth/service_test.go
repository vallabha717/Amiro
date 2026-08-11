package auth

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"betterchatbot/backend/internal/db"
	"betterchatbot/backend/internal/db/models"
)

func newTestService(t *testing.T) *Service {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	return NewService(gdb)
}

func TestRegister_CreatesUserWithHashedPassword(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()

	user, err := service.Register(ctx, "Ada Lovelace", "Ada@Example.com", "hunter2")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if user.ID == "" {
		t.Fatal("expected a generated ID")
	}
	if user.Email != "ada@example.com" {
		t.Fatalf("Email = %q, want normalized lowercase", user.Email)
	}
	if user.Password == nil || *user.Password == "hunter2" {
		t.Fatal("expected the password to be hashed, not stored in plaintext")
	}
}

func TestRegister_RejectsDuplicateEmail(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()

	if _, err := service.Register(ctx, "Ada", "ada@example.com", "hunter2"); err != nil {
		t.Fatalf("first Register: %v", err)
	}
	_, err := service.Register(ctx, "Ada Again", "ADA@EXAMPLE.COM", "different")
	if err != ErrEmailTaken {
		t.Fatalf("err = %v, want ErrEmailTaken", err)
	}
}

func TestLogin_SucceedsWithCorrectPasswordAndIssuesSession(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	if _, err := service.Register(ctx, "Ada", "ada@example.com", "hunter2"); err != nil {
		t.Fatalf("Register: %v", err)
	}

	user, session, err := service.Login(ctx, "ada@example.com", "hunter2", "127.0.0.1", "test-agent")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if user.Email != "ada@example.com" {
		t.Fatalf("Email = %q", user.Email)
	}
	if session.Token == "" {
		t.Fatal("expected a non-empty session token")
	}
	if session.UserID != user.ID {
		t.Fatalf("session.UserID = %q, want %q", session.UserID, user.ID)
	}
}

func TestLogin_FailsWithWrongPassword(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	if _, err := service.Register(ctx, "Ada", "ada@example.com", "hunter2"); err != nil {
		t.Fatalf("Register: %v", err)
	}

	_, _, err := service.Login(ctx, "ada@example.com", "wrong-password", "", "")
	if err != ErrInvalidCredentials {
		t.Fatalf("err = %v, want ErrInvalidCredentials", err)
	}
}

func TestLogin_FailsForBannedUser(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	u, err := service.Register(ctx, "Ada", "ada@example.com", "hunter2")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	banned := true
	if err := service.db.Model(&models.User{}).Where("id = ?", u.ID).Update("banned", &banned).Error; err != nil {
		t.Fatalf("ban user: %v", err)
	}

	_, _, err = service.Login(ctx, "ada@example.com", "hunter2", "", "")
	if err != ErrUserBanned {
		t.Fatalf("err = %v, want ErrUserBanned", err)
	}
}

func TestLogin_SucceedsForUserWithExpiredBan(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	u, err := service.Register(ctx, "Ada", "ada@example.com", "hunter2")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	banned := true
	expired := time.Now().Add(-time.Hour)
	if err := service.db.Model(&models.User{}).Where("id = ?", u.ID).
		Updates(map[string]interface{}{"banned": &banned, "ban_expires": &expired}).Error; err != nil {
		t.Fatalf("ban user: %v", err)
	}

	_, _, err = service.Login(ctx, "ada@example.com", "hunter2", "", "")
	if err != nil {
		t.Fatalf("Login: %v, want success for an already-expired ban", err)
	}
}

func TestLogin_FailsForUnknownEmail(t *testing.T) {
	service := newTestService(t)
	_, _, err := service.Login(context.Background(), "nobody@example.com", "irrelevant", "", "")
	if err != ErrInvalidCredentials {
		t.Fatalf("err = %v, want ErrInvalidCredentials", err)
	}
}

func TestValidateSession_ReturnsUserForValidToken(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	if _, err := service.Register(ctx, "Ada", "ada@example.com", "hunter2"); err != nil {
		t.Fatalf("Register: %v", err)
	}
	_, session, err := service.Login(ctx, "ada@example.com", "hunter2", "", "")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	user, gotSession, err := service.ValidateSession(ctx, session.Token)
	if err != nil {
		t.Fatalf("ValidateSession: %v", err)
	}
	if user.Email != "ada@example.com" {
		t.Fatalf("Email = %q", user.Email)
	}
	if gotSession.Token != session.Token {
		t.Fatalf("Token = %q, want %q", gotSession.Token, session.Token)
	}
}

func TestValidateSession_RejectsUnknownToken(t *testing.T) {
	service := newTestService(t)
	_, _, err := service.ValidateSession(context.Background(), "does-not-exist")
	if err != ErrSessionNotFound {
		t.Fatalf("err = %v, want ErrSessionNotFound", err)
	}
}

func TestValidateSession_RejectsExpiredToken(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	user, err := service.Register(ctx, "Ada", "ada@example.com", "hunter2")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	session, err := service.CreateSession(ctx, user.ID, "", "")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Directly backdate the session's expiry rather than waiting out
	// SessionTTL (30 days) in a test -- there is deliberately no Service
	// method for this, expiry only ever happens by elapsed time in
	// production code.
	if err := service.db.Model(&models.Session{}).Where("token = ?", session.Token).
		Update("expires_at", time.Now().Add(-time.Hour)).Error; err != nil {
		t.Fatalf("backdate session: %v", err)
	}

	_, _, err = service.ValidateSession(ctx, session.Token)
	if err != ErrSessionExpired {
		t.Fatalf("err = %v, want ErrSessionExpired", err)
	}
}

func TestLogout_DeletesSession(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	user, err := service.Register(ctx, "Ada", "ada@example.com", "hunter2")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	session, err := service.CreateSession(ctx, user.ID, "", "")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if err := service.Logout(ctx, session.Token); err != nil {
		t.Fatalf("Logout: %v", err)
	}

	_, _, err = service.ValidateSession(ctx, session.Token)
	if err != ErrSessionNotFound {
		t.Fatalf("err = %v, want ErrSessionNotFound after logout", err)
	}
}

func TestSetPassword_SetsFirstPasswordWithoutCurrent(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	user, _, err := service.EnsureDesktopDefaultUser(ctx)
	if err != nil {
		t.Fatalf("EnsureDesktopDefaultUser: %v", err)
	}

	if err := service.SetPassword(ctx, user.ID, "", "newpass123"); err != nil {
		t.Fatalf("SetPassword: %v", err)
	}

	if _, _, err := service.Login(ctx, user.Email, "newpass123", "", ""); err != nil {
		t.Fatalf("Login with newly set password: %v", err)
	}
}

func TestSetPassword_RequiresCurrentPasswordWhenOneExists(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	user, err := service.Register(ctx, "Ada", "ada@example.com", "hunter2")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}

	if err := service.SetPassword(ctx, user.ID, "", "newpass123"); err != ErrCurrentPasswordRequired {
		t.Fatalf("err = %v, want ErrCurrentPasswordRequired", err)
	}
	if err := service.SetPassword(ctx, user.ID, "wrong", "newpass123"); err != ErrInvalidCredentials {
		t.Fatalf("err = %v, want ErrInvalidCredentials", err)
	}
	if err := service.SetPassword(ctx, user.ID, "hunter2", "newpass123"); err != nil {
		t.Fatalf("SetPassword with correct current password: %v", err)
	}
	if _, _, err := service.Login(ctx, "ada@example.com", "newpass123", "", ""); err != nil {
		t.Fatalf("Login with new password: %v", err)
	}
	if _, _, err := service.Login(ctx, "ada@example.com", "hunter2", "", ""); err != ErrInvalidCredentials {
		t.Fatalf("old password should no longer work, err = %v", err)
	}
}

func TestSetPassword_RejectsUnknownUser(t *testing.T) {
	service := newTestService(t)
	if err := service.SetPassword(context.Background(), "does-not-exist", "", "newpass123"); err != ErrUserNotFound {
		t.Fatalf("err = %v, want ErrUserNotFound", err)
	}
}

func TestEnsureDesktopDefaultUser_IsIdempotentAndClearsOldSessions(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()

	user1, session1, err := service.EnsureDesktopDefaultUser(ctx)
	if err != nil {
		t.Fatalf("first EnsureDesktopDefaultUser: %v", err)
	}

	user2, session2, err := service.EnsureDesktopDefaultUser(ctx)
	if err != nil {
		t.Fatalf("second EnsureDesktopDefaultUser: %v", err)
	}

	if user1.ID != user2.ID {
		t.Fatalf("second call created a new user (%q) instead of reusing %q", user2.ID, user1.ID)
	}
	if session1.Token == session2.Token {
		t.Fatal("expected a fresh session token on the second call")
	}

	// The first session must have been invalidated -- restarts should not
	// pile up stale sessions for the single desktop user.
	if _, _, err := service.ValidateSession(ctx, session1.Token); err != ErrSessionNotFound {
		t.Fatalf("first session err = %v, want ErrSessionNotFound (should have been cleared)", err)
	}
	if _, _, err := service.ValidateSession(ctx, session2.Token); err != nil {
		t.Fatalf("second session should still validate: %v", err)
	}
}
