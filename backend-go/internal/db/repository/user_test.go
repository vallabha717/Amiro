package repository

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"gorm.io/gorm"

	"betterchatbot/backend/internal/db"
	"betterchatbot/backend/internal/db/models"
	"betterchatbot/backend/internal/user"
)

func newUserTestEnv(t *testing.T) (*UserRepository, *gorm.DB, *models.User) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	password := "hashed-password"
	u := &models.User{Name: "Ada", Email: "ada@example.com", Password: &password}
	if err := gdb.Create(u).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	return NewUserRepository(gdb), gdb, u
}

// The password hash must never leave the repository -- api/user's DTO
// doesn't declare the field, but a caller reaching for models.User
// directly would still get it if this cleared nothing.
func TestUserRepository_GetByIDNeverReturnsThePasswordHash(t *testing.T) {
	repo, _, u := newUserTestEnv(t)

	got, err := repo.GetByID(context.Background(), u.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.User.Password != nil {
		t.Fatalf("password = %q, want nil", *got.User.Password)
	}
}

func TestUserRepository_GetByIDReturnsNilForMissingUser(t *testing.T) {
	repo, _, _ := newUserTestEnv(t)

	got, err := repo.GetByID(context.Background(), "no-such-id")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v, want nil", got)
	}
}

func TestUserRepository_GetByIDReportsNoLastLoginBeforeAnySession(t *testing.T) {
	repo, _, u := newUserTestEnv(t)

	got, err := repo.GetByID(context.Background(), u.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.LastLogin != nil {
		t.Fatalf("lastLogin = %v, want nil for a user who never logged in", got.LastLogin)
	}
}

func TestUserRepository_GetByIDReportsTheNewestSessionAsLastLogin(t *testing.T) {
	repo, gdb, u := newUserTestEnv(t)
	ctx := context.Background()

	older := time.Now().Add(-48 * time.Hour)
	newer := time.Now().Add(-1 * time.Hour)
	for i, at := range []time.Time{older, newer} {
		session := &models.Session{
			Token:     string(rune('a'+i)) + "-token",
			UserID:    u.ID,
			ExpiresAt: time.Now().Add(time.Hour),
			CreatedAt: at,
			UpdatedAt: at,
		}
		if err := gdb.Create(session).Error; err != nil {
			t.Fatalf("create session: %v", err)
		}
	}

	got, err := repo.GetByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.LastLogin == nil {
		t.Fatal("lastLogin = nil, want the newer session's timestamp")
	}
	if got.LastLogin.Before(newer.Add(-time.Minute)) {
		t.Fatalf("lastLogin = %v, want ~%v (the newest session, not the oldest)", got.LastLogin, newer)
	}
}

func TestUserRepository_PreferencesRoundTrip(t *testing.T) {
	repo, _, u := newUserTestEnv(t)
	ctx := context.Background()

	want := user.Preferences{DisplayName: "Ada L.", Profession: "Mathematician", BotName: "Analytical Engine"}
	if _, err := repo.UpdatePreferences(ctx, u.ID, want); err != nil {
		t.Fatalf("UpdatePreferences: %v", err)
	}

	got, err := repo.GetPreferences(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetPreferences: %v", err)
	}
	if got == nil || *got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

// The TS route replaces the whole preferences object rather than merging,
// so a field left out of the request is genuinely cleared.
func TestUserRepository_UpdatePreferencesReplacesRatherThanMerges(t *testing.T) {
	repo, _, u := newUserTestEnv(t)
	ctx := context.Background()

	_, _ = repo.UpdatePreferences(ctx, u.ID, user.Preferences{DisplayName: "Ada L.", BotName: "Engine"})
	_, _ = repo.UpdatePreferences(ctx, u.ID, user.Preferences{DisplayName: "Ada Lovelace"})

	got, err := repo.GetPreferences(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetPreferences: %v", err)
	}
	if got.DisplayName != "Ada Lovelace" {
		t.Fatalf("displayName = %q", got.DisplayName)
	}
	if got.BotName != "" {
		t.Fatalf("botName = %q, want cleared", got.BotName)
	}
}

func TestUserRepository_UpdatePreferencesReportsAMissingUser(t *testing.T) {
	repo, _, _ := newUserTestEnv(t)

	if _, err := repo.UpdatePreferences(context.Background(), "no-such-id", user.Preferences{}); err == nil {
		t.Fatal("want an error for a user that doesn't exist")
	}
}

func TestUserRepository_UpdateDetailsLeavesOmittedFieldsAlone(t *testing.T) {
	repo, _, u := newUserTestEnv(t)

	name := "Ada Lovelace"
	updated, err := repo.UpdateDetails(context.Background(), u.ID, &name, nil, nil)
	if err != nil {
		t.Fatalf("UpdateDetails: %v", err)
	}
	if updated.Name != "Ada Lovelace" {
		t.Fatalf("name = %q", updated.Name)
	}
	if updated.Email != "ada@example.com" {
		t.Fatalf("email = %q -- an omitted field must not be blanked", updated.Email)
	}
	if updated.Password != nil {
		t.Fatalf("password leaked through UpdateDetails")
	}
}

func TestUserRepository_ExistsByEmail(t *testing.T) {
	repo, _, _ := newUserTestEnv(t)
	ctx := context.Background()

	exists, err := repo.ExistsByEmail(ctx, "ada@example.com")
	if err != nil || !exists {
		t.Fatalf("got (%v, %v), want (true, nil)", exists, err)
	}
	exists, err = repo.ExistsByEmail(ctx, "nobody@example.com")
	if err != nil || exists {
		t.Fatalf("got (%v, %v), want (false, nil)", exists, err)
	}
}

func TestUserRepository_GetCount(t *testing.T) {
	repo, gdb, _ := newUserTestEnv(t)

	if err := gdb.Create(&models.User{Name: "Grace", Email: "grace@example.com"}).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}

	count, err := repo.GetCount(context.Background())
	if err != nil {
		t.Fatalf("GetCount: %v", err)
	}
	if count != 2 {
		t.Fatalf("count = %d, want 2", count)
	}
}

// A user registered through this backend has a password hash on the user
// row and no "credential" account row at all -- so reading only the
// account table (as the TS version does) would report hasPassword=false
// for someone who logs in with one every day.
func TestUserRepository_GetAuthMethodsReportsALocalPasswordWithNoAccountRow(t *testing.T) {
	repo, _, u := newUserTestEnv(t)

	methods, err := repo.GetAuthMethods(context.Background(), u.ID)
	if err != nil {
		t.Fatalf("GetAuthMethods: %v", err)
	}
	if !methods.HasPassword {
		t.Fatal("hasPassword = false for a user with a stored password hash")
	}
	if len(methods.OAuthProviders) != 0 {
		t.Fatalf("oauthProviders = %v, want empty", methods.OAuthProviders)
	}
}

func TestUserRepository_GetAuthMethodsSplitsCredentialFromOAuthProviders(t *testing.T) {
	repo, gdb, _ := newUserTestEnv(t)
	passwordless := &models.User{Name: "Grace", Email: "grace@example.com"}
	if err := gdb.Create(passwordless).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	for _, provider := range []string{"google", "github"} {
		account := &models.Account{AccountID: provider + "-1", ProviderID: provider, UserID: passwordless.ID}
		if err := gdb.Create(account).Error; err != nil {
			t.Fatalf("create account: %v", err)
		}
	}

	methods, err := repo.GetAuthMethods(context.Background(), passwordless.ID)
	if err != nil {
		t.Fatalf("GetAuthMethods: %v", err)
	}
	if methods.HasPassword {
		t.Fatal("hasPassword = true for a user with no password and no credential account")
	}
	if len(methods.OAuthProviders) != 2 {
		t.Fatalf("oauthProviders = %v, want both providers", methods.OAuthProviders)
	}
}

func TestUserRepository_ListForAdmin_SearchMatchesNameOrEmailCaseInsensitively(t *testing.T) {
	repo, gdb, _ := newUserTestEnv(t) // seeds Ada/ada@example.com
	if err := gdb.Create(&models.User{Name: "Grace Hopper", Email: "grace@example.com"}).Error; err != nil {
		t.Fatal(err)
	}

	got, err := repo.ListForAdmin(context.Background(), AdminUsersQuery{SearchValue: "GRACE"})
	if err != nil {
		t.Fatalf("ListForAdmin: %v", err)
	}
	if got.Total != 1 || len(got.Users) != 1 || got.Users[0].Name != "Grace Hopper" {
		t.Fatalf("got %+v, want exactly Grace Hopper", got)
	}
}

func TestUserRepository_ListForAdmin_StripsPasswordAndPaginates(t *testing.T) {
	repo, gdb, _ := newUserTestEnv(t)
	for _, name := range []string{"B", "C", "D"} {
		if err := gdb.Create(&models.User{Name: name, Email: name + "@example.com"}).Error; err != nil {
			t.Fatal(err)
		}
	}

	page, err := repo.ListForAdmin(context.Background(), AdminUsersQuery{Limit: 2, Offset: 0, SortBy: "name", SortDirection: "asc"})
	if err != nil {
		t.Fatalf("ListForAdmin: %v", err)
	}
	if page.Total != 4 {
		t.Fatalf("total = %d, want 4 across all pages", page.Total)
	}
	if len(page.Users) != 2 {
		t.Fatalf("got %d users, want the 2-row page", len(page.Users))
	}
	for _, u := range page.Users {
		if u.Password != nil {
			t.Fatalf("password hash leaked into admin list for %q", u.Name)
		}
	}
}

func TestUserRepository_UpdateRole(t *testing.T) {
	repo, _, u := newUserTestEnv(t)
	if err := repo.UpdateRole(context.Background(), u.ID, "admin"); err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}
	got, err := repo.GetByID(context.Background(), u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Role != "admin" {
		t.Fatalf("role = %q, want admin", got.Role)
	}
}

func TestUserRepository_UpdateRole_UnknownUserReturnsNotFound(t *testing.T) {
	repo, _, _ := newUserTestEnv(t)
	err := repo.UpdateRole(context.Background(), "does-not-exist", "admin")
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("got %v, want gorm.ErrRecordNotFound", err)
	}
}

func TestUserRepository_UpdateBanStatus_BanSetsReasonUnbanClearsIt(t *testing.T) {
	repo, _, u := newUserTestEnv(t)
	reason := "spamming"
	if err := repo.UpdateBanStatus(context.Background(), u.ID, true, &reason); err != nil {
		t.Fatalf("ban: %v", err)
	}
	got, err := repo.GetByID(context.Background(), u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Banned == nil || !*got.Banned || got.BanReason == nil || *got.BanReason != reason {
		t.Fatalf("got %+v, want banned=true reason=%q", got, reason)
	}

	if err := repo.UpdateBanStatus(context.Background(), u.ID, false, nil); err != nil {
		t.Fatalf("unban: %v", err)
	}
	got, err = repo.GetByID(context.Background(), u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Banned == nil || *got.Banned {
		t.Fatalf("got %+v, want banned=false", got)
	}
	if got.BanReason != nil {
		t.Fatalf("expected ban reason cleared on unban, got %q", *got.BanReason)
	}
}

func TestUserRepository_Delete_RemovesUserSessionsAndAccounts(t *testing.T) {
	repo, gdb, u := newUserTestEnv(t)
	if err := gdb.Create(&models.Session{Token: "tok-1", UserID: u.ID, ExpiresAt: time.Now().Add(time.Hour)}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.Account{AccountID: "acc-1", ProviderID: "credential", UserID: u.ID}).Error; err != nil {
		t.Fatal(err)
	}

	if err := repo.Delete(context.Background(), u.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	got, err := repo.GetByID(context.Background(), u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("expected the user gone, got %+v", got)
	}
	var sessionCount, accountCount int64
	gdb.Model(&models.Session{}).Where("user_id = ?", u.ID).Count(&sessionCount)
	gdb.Model(&models.Account{}).Where("user_id = ?", u.ID).Count(&accountCount)
	if sessionCount != 0 || accountCount != 0 {
		t.Fatalf("expected sessions/accounts cleaned up too, got %d sessions, %d accounts", sessionCount, accountCount)
	}
}

func TestUserRepository_Delete_UnknownUserReturnsNotFound(t *testing.T) {
	repo, _, _ := newUserTestEnv(t)
	err := repo.Delete(context.Background(), "does-not-exist")
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("got %v, want gorm.ErrRecordNotFound", err)
	}
}

func TestUserRepository_RevokeSessions(t *testing.T) {
	repo, gdb, u := newUserTestEnv(t)
	if err := gdb.Create(&models.Session{Token: "tok-1", UserID: u.ID, ExpiresAt: time.Now().Add(time.Hour)}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.RevokeSessions(context.Background(), u.ID); err != nil {
		t.Fatalf("RevokeSessions: %v", err)
	}
	var count int64
	gdb.Model(&models.Session{}).Where("user_id = ?", u.ID).Count(&count)
	if count != 0 {
		t.Fatalf("expected 0 sessions left, got %d", count)
	}
}
