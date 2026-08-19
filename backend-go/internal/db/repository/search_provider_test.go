package repository

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"amiro/backend/internal/db"
)

func newSearchProviderRepo(t *testing.T) (*SearchProviderRepository, context.Context) {
	t.Helper()
	gdb, err := db.Open(db.DialectSQLite, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	return NewSearchProviderRepository(gdb), context.Background()
}

func seedProvider(t *testing.T, r *SearchProviderRepository, ctx context.Context, kind, name, key string) string {
	t.Helper()
	id, err := r.Set(ctx, "", kind, name, key)
	if err != nil {
		t.Fatalf("Set(%s): %v", name, err)
	}
	return id
}

func TestSetCreatesAndUpdates(t *testing.T) {
	repo, ctx := newSearchProviderRepo(t)
	id := seedProvider(t, repo, ctx, "brave", "Brave", "key-1")

	if _, err := repo.Set(ctx, id, "brave", "Brave renamed", "key-2"); err != nil {
		t.Fatal(err)
	}
	got, err := repo.Get(ctx, id)
	if err != nil || got == nil {
		t.Fatalf("Get: %v, %v", got, err)
	}
	if got.Name != "Brave renamed" || got.APIKey != "key-2" {
		t.Fatalf("got %+v, want the renamed config with the new key", got)
	}
}

// The whole reason the browser never receives a real key: the editor submits
// an empty apiKey to mean "unchanged". If that cleared the stored key
// instead, every rename would silently break the provider.
func TestEmptyKeyOnUpdatePreservesTheStoredOne(t *testing.T) {
	repo, ctx := newSearchProviderRepo(t)
	id := seedProvider(t, repo, ctx, "brave", "Brave", "secret")

	if _, err := repo.Set(ctx, id, "brave", "Brave", ""); err != nil {
		t.Fatal(err)
	}
	got, _ := repo.Get(ctx, id)
	if got.APIKey != "secret" {
		t.Fatalf("APIKey = %q, want the stored key preserved", got.APIKey)
	}
}

func TestSetOnMissingIDIsNotFound(t *testing.T) {
	repo, ctx := newSearchProviderRepo(t)
	// A 500 here would report a client mistake -- editing something another
	// tab deleted -- as a server fault.
	if _, err := repo.Set(ctx, "nope", "brave", "Brave", "k"); !errors.Is(err, ErrSearchProviderNotFound) {
		t.Fatalf("got %v, want ErrSearchProviderNotFound", err)
	}
}

func TestSetActiveLeavesExactlyOneActive(t *testing.T) {
	repo, ctx := newSearchProviderRepo(t)
	a := seedProvider(t, repo, ctx, "brave", "Brave", "k")
	b := seedProvider(t, repo, ctx, "tavily", "Tavily", "k")

	for _, id := range []string{a, b, a} {
		if err := repo.SetActive(ctx, id); err != nil {
			t.Fatal(err)
		}
		all, _ := repo.List(ctx)
		active := 0
		for _, c := range all {
			if c.IsActive {
				active++
			}
		}
		if active != 1 {
			t.Fatalf("after activating %s: %d active, want exactly 1", id, active)
		}
	}

	got, _ := repo.GetActive(ctx)
	if got == nil || got.ID != a {
		t.Fatalf("GetActive = %+v, want %s", got, a)
	}
}

func TestSetActiveOnMissingIDIsNotFound(t *testing.T) {
	repo, ctx := newSearchProviderRepo(t)
	if err := repo.SetActive(ctx, "nope"); !errors.Is(err, ErrSearchProviderNotFound) {
		t.Fatalf("got %v, want ErrSearchProviderNotFound", err)
	}
}

// Deleting the active provider used to leave nothing active: web search went
// silently dead while the admin page still listed working providers, with
// nothing on either screen connecting the two.
func TestDeletingTheActiveProviderPromotesAnother(t *testing.T) {
	repo, ctx := newSearchProviderRepo(t)
	a := seedProvider(t, repo, ctx, "brave", "Brave", "k")
	b := seedProvider(t, repo, ctx, "tavily", "Tavily", "k")

	if err := repo.SetActive(ctx, b); err != nil {
		t.Fatal(err)
	}
	if err := repo.Delete(ctx, b); err != nil {
		t.Fatal(err)
	}

	got, err := repo.GetActive(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.ID != a {
		t.Fatalf("GetActive = %+v, want the surviving provider %s promoted", got, a)
	}
}

func TestDeletingAnInactiveProviderLeavesTheActiveOneAlone(t *testing.T) {
	repo, ctx := newSearchProviderRepo(t)
	a := seedProvider(t, repo, ctx, "brave", "Brave", "k")
	b := seedProvider(t, repo, ctx, "tavily", "Tavily", "k")

	_ = repo.SetActive(ctx, a)
	if err := repo.Delete(ctx, b); err != nil {
		t.Fatal(err)
	}
	got, _ := repo.GetActive(ctx)
	if got == nil || got.ID != a {
		t.Fatalf("GetActive = %+v, want %s untouched", got, a)
	}
}

func TestDeletingTheLastProviderLeavesNoneActive(t *testing.T) {
	repo, ctx := newSearchProviderRepo(t)
	a := seedProvider(t, repo, ctx, "brave", "Brave", "k")
	_ = repo.SetActive(ctx, a)

	if err := repo.Delete(ctx, a); err != nil {
		t.Fatal(err)
	}
	got, err := repo.GetActive(ctx)
	if err != nil {
		t.Fatalf("no providers is a normal state, not an error: %v", err)
	}
	if got != nil {
		t.Fatalf("GetActive = %+v, want nil", got)
	}
}

func TestDeleteOnMissingIDIsNotFound(t *testing.T) {
	repo, ctx := newSearchProviderRepo(t)
	if err := repo.Delete(ctx, "nope"); !errors.Is(err, ErrSearchProviderNotFound) {
		t.Fatalf("got %v, want ErrSearchProviderNotFound", err)
	}
}

func TestGetActiveIsNilWhenNothingIsActive(t *testing.T) {
	repo, ctx := newSearchProviderRepo(t)
	seedProvider(t, repo, ctx, "brave", "Brave", "k")

	got, err := repo.GetActive(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("a stored-but-never-activated provider is not active: %+v", got)
	}
}
