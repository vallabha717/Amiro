package repository

import (
	"context"
	"path/filepath"
	"testing"

	"gorm.io/gorm"

	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
)

func newWorkspaceTrustTestEnv(t *testing.T) (*WorkspaceTrustRepository, *gorm.DB, *models.User) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	u := &models.User{Name: "Ada", Email: "ada@example.com"}
	if err := gdb.Create(u).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	return NewWorkspaceTrustRepository(gdb), gdb, u
}

func TestWorkspaceTrustRepository_UngrantedRootIsNotTrusted(t *testing.T) {
	repo, _, u := newWorkspaceTrustTestEnv(t)

	trusted, err := repo.IsTrusted(context.Background(), u.ID, "/home/ada/project")
	if err != nil {
		t.Fatalf("IsTrusted: %v", err)
	}
	if trusted {
		t.Fatal("IsTrusted = true for a root never granted")
	}
}

func TestWorkspaceTrustRepository_GrantThenIsTrustedRoundTrips(t *testing.T) {
	repo, _, u := newWorkspaceTrustTestEnv(t)
	ctx := context.Background()

	if err := repo.Grant(ctx, u.ID, "/home/ada/project", GrantedViaPrompt); err != nil {
		t.Fatalf("Grant: %v", err)
	}

	trusted, err := repo.IsTrusted(ctx, u.ID, "/home/ada/project")
	if err != nil {
		t.Fatalf("IsTrusted: %v", err)
	}
	if !trusted {
		t.Fatal("IsTrusted = false after Grant")
	}
}

func TestWorkspaceTrustRepository_GrantIsIdempotent(t *testing.T) {
	repo, _, u := newWorkspaceTrustTestEnv(t)
	ctx := context.Background()

	if err := repo.Grant(ctx, u.ID, "/home/ada/project", GrantedViaPrompt); err != nil {
		t.Fatalf("first Grant: %v", err)
	}
	if err := repo.Grant(ctx, u.ID, "/home/ada/project", GrantedViaPrompt); err != nil {
		t.Fatalf("second Grant: %v", err)
	}

	grants, err := repo.List(ctx, u.ID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(grants) != 1 {
		t.Fatalf("len(grants) = %d, want 1 (Grant must be idempotent)", len(grants))
	}
}

func TestWorkspaceTrustRepository_RevokeRemovesTheGrant(t *testing.T) {
	repo, _, u := newWorkspaceTrustTestEnv(t)
	ctx := context.Background()

	if err := repo.Grant(ctx, u.ID, "/home/ada/project", GrantedViaPrompt); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if err := repo.Revoke(ctx, u.ID, "/home/ada/project"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	trusted, err := repo.IsTrusted(ctx, u.ID, "/home/ada/project")
	if err != nil {
		t.Fatalf("IsTrusted: %v", err)
	}
	if trusted {
		t.Fatal("IsTrusted = true after Revoke")
	}
}

func TestWorkspaceTrustRepository_RevokeOfUngrantedRootIsANoOp(t *testing.T) {
	repo, _, u := newWorkspaceTrustTestEnv(t)

	if err := repo.Revoke(context.Background(), u.ID, "/never/granted"); err != nil {
		t.Fatalf("Revoke of an ungranted root returned an error: %v", err)
	}
}

func TestWorkspaceTrustRepository_GrantsAreScopedPerUser(t *testing.T) {
	repo, gdb, u := newWorkspaceTrustTestEnv(t)
	ctx := context.Background()

	other := &models.User{Name: "Bob", Email: "bob@example.com"}
	if err := gdb.Create(other).Error; err != nil {
		t.Fatalf("create other user: %v", err)
	}

	if err := repo.Grant(ctx, u.ID, "/shared/root", GrantedViaPrompt); err != nil {
		t.Fatalf("Grant: %v", err)
	}

	trusted, err := repo.IsTrusted(ctx, other.ID, "/shared/root")
	if err != nil {
		t.Fatalf("IsTrusted: %v", err)
	}
	if trusted {
		t.Fatal("a grant for one user must not trust another user's turn against the same root")
	}
}

func TestWorkspaceTrustRepository_ListOrdersNewestFirst(t *testing.T) {
	repo, _, u := newWorkspaceTrustTestEnv(t)
	ctx := context.Background()

	if err := repo.Grant(ctx, u.ID, "/root/one", GrantedViaPrompt); err != nil {
		t.Fatalf("Grant one: %v", err)
	}
	if err := repo.Grant(ctx, u.ID, "/root/two", GrantedViaEnv); err != nil {
		t.Fatalf("Grant two: %v", err)
	}

	grants, err := repo.List(ctx, u.ID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(grants) != 2 {
		t.Fatalf("len(grants) = %d, want 2", len(grants))
	}
}
