package repository

import (
	"context"
	"path/filepath"
	"testing"

	"gorm.io/datatypes"
	"gorm.io/gorm"

	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
)

func newTestMcpRepo(t *testing.T) (*McpRepository, *gorm.DB, *models.User) {
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
	return NewMcpRepository(gdb), gdb, u
}

func TestMcpRepository_SaveInsertsWithDefaultsWhenNewAndOmitted(t *testing.T) {
	repo, _, u := newTestMcpRepo(t)
	ctx := context.Background()

	server := &models.McpServer{Name: "my-server", UserID: u.ID, Config: datatypes.JSON(`{"command":"echo"}`)}
	if err := repo.Save(ctx, server); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if server.ID == "" {
		t.Fatal("expected a generated ID")
	}

	got, err := repo.SelectByID(ctx, server.ID)
	if err != nil {
		t.Fatalf("SelectByID: %v", err)
	}
	if got == nil {
		t.Fatal("expected the row to exist")
	}
	if got.Visibility != "private" {
		t.Fatalf("visibility = %q, want the default \"private\"", got.Visibility)
	}
	if !got.Enabled {
		t.Fatal("expected enabled=true by default for a new server")
	}
}

func TestMcpRepository_SaveUpdatesOnlyConfigOnConflict(t *testing.T) {
	repo, _, u := newTestMcpRepo(t)
	ctx := context.Background()

	server := &models.McpServer{Name: "my-server", UserID: u.ID, Config: datatypes.JSON(`{"command":"v1"}`)}
	if err := repo.Save(ctx, server); err != nil {
		t.Fatalf("first Save: %v", err)
	}

	updated := &models.McpServer{ID: server.ID, Name: "renamed", UserID: u.ID, Config: datatypes.JSON(`{"command":"v2"}`)}
	if err := repo.Save(ctx, updated); err != nil {
		t.Fatalf("second Save: %v", err)
	}

	got, err := repo.SelectByID(ctx, server.ID)
	if err != nil {
		t.Fatalf("SelectByID: %v", err)
	}
	if string(got.Config) != `{"command":"v2"}` {
		t.Fatalf("config = %s, want the updated value", got.Config)
	}
	if got.Name != "my-server" {
		t.Fatalf("name = %q, want the original name preserved (only config/updated_at are in the upsert's DoUpdates)", got.Name)
	}
}

func TestMcpRepository_SelectAllForUserReturnsOwnAndPublicOnly(t *testing.T) {
	repo, gdb, u := newTestMcpRepo(t)
	ctx := context.Background()
	other := &models.User{Name: "Bob", Email: "bob@example.com"}
	if err := gdb.Create(other).Error; err != nil {
		t.Fatalf("create other user: %v", err)
	}

	own := &models.McpServer{Name: "own-server", UserID: u.ID, Visibility: "private", Config: datatypes.JSON(`{}`)}
	otherPrivate := &models.McpServer{Name: "other-private", UserID: other.ID, Visibility: "private", Config: datatypes.JSON(`{}`)}
	otherPublic := &models.McpServer{Name: "other-public", UserID: other.ID, Visibility: "public", Config: datatypes.JSON(`{}`)}
	for _, s := range []*models.McpServer{own, otherPrivate, otherPublic} {
		if err := repo.Save(ctx, s); err != nil {
			t.Fatalf("Save: %v", err)
		}
	}

	rows, err := repo.SelectAllForUser(ctx, u.ID)
	if err != nil {
		t.Fatalf("SelectAllForUser: %v", err)
	}
	names := make(map[string]bool, len(rows))
	for _, r := range rows {
		names[r.Name] = true
	}
	if !names["own-server"] || !names["other-public"] {
		t.Fatalf("got %v, want own-server and other-public present", names)
	}
	if names["other-private"] {
		t.Fatal("expected another user's private server to be excluded")
	}

	var ownerRow *McpServerWithOwner
	for i := range rows {
		if rows[i].Name == "other-public" {
			ownerRow = &rows[i]
		}
	}
	if ownerRow == nil || ownerRow.OwnerName == nil || *ownerRow.OwnerName != "Bob" {
		t.Fatalf("owner row = %+v, want OwnerName \"Bob\"", ownerRow)
	}
}

func TestMcpRepository_UpdateVisibility(t *testing.T) {
	repo, _, u := newTestMcpRepo(t)
	ctx := context.Background()
	server := &models.McpServer{Name: "my-server", UserID: u.ID, Config: datatypes.JSON(`{}`)}
	_ = repo.Save(ctx, server)

	if err := repo.UpdateVisibility(ctx, server.ID, "public"); err != nil {
		t.Fatalf("UpdateVisibility: %v", err)
	}
	got, _ := repo.SelectByID(ctx, server.ID)
	if got.Visibility != "public" {
		t.Fatalf("visibility = %q, want public", got.Visibility)
	}
}

func TestMcpRepository_UpdateToolInfo(t *testing.T) {
	repo, _, u := newTestMcpRepo(t)
	ctx := context.Background()
	server := &models.McpServer{Name: "my-server", UserID: u.ID, Config: datatypes.JSON(`{}`)}
	_ = repo.Save(ctx, server)

	toolInfo := datatypes.JSON(`[{"name":"add","description":"adds numbers"}]`)
	if err := repo.UpdateToolInfo(ctx, server.ID, toolInfo); err != nil {
		t.Fatalf("UpdateToolInfo: %v", err)
	}
	got, _ := repo.SelectByID(ctx, server.ID)
	if string(got.ToolInfo) != string(toolInfo) {
		t.Fatalf("tool_info = %s, want %s", got.ToolInfo, toolInfo)
	}
	if got.ToolInfoUpdatedAt == nil {
		t.Fatal("expected tool_info_updated_at to be set")
	}
}

func TestMcpRepository_UpdateConnectionStatus(t *testing.T) {
	repo, _, u := newTestMcpRepo(t)
	ctx := context.Background()
	server := &models.McpServer{Name: "my-server", UserID: u.ID, Config: datatypes.JSON(`{}`)}
	_ = repo.Save(ctx, server)

	if err := repo.UpdateConnectionStatus(ctx, server.ID, "error"); err != nil {
		t.Fatalf("UpdateConnectionStatus: %v", err)
	}
	got, _ := repo.SelectByID(ctx, server.ID)
	if got.LastConnectionStatus == nil || *got.LastConnectionStatus != "error" {
		t.Fatalf("last_connection_status = %v, want error", got.LastConnectionStatus)
	}
}

func TestMcpRepository_ExistsByServerName(t *testing.T) {
	repo, _, u := newTestMcpRepo(t)
	ctx := context.Background()
	exists, err := repo.ExistsByServerName(ctx, "not-there")
	if err != nil {
		t.Fatalf("ExistsByServerName: %v", err)
	}
	if exists {
		t.Fatal("expected false for a nonexistent name")
	}

	_ = repo.Save(ctx, &models.McpServer{Name: "my-server", UserID: u.ID, Config: datatypes.JSON(`{}`)})
	exists, err = repo.ExistsByServerName(ctx, "my-server")
	if err != nil {
		t.Fatalf("ExistsByServerName: %v", err)
	}
	if !exists {
		t.Fatal("expected true once the server exists")
	}
}

func TestMcpRepository_DeleteByID(t *testing.T) {
	repo, _, u := newTestMcpRepo(t)
	ctx := context.Background()
	server := &models.McpServer{Name: "my-server", UserID: u.ID, Config: datatypes.JSON(`{}`)}
	_ = repo.Save(ctx, server)

	if err := repo.DeleteByID(ctx, server.ID); err != nil {
		t.Fatalf("DeleteByID: %v", err)
	}
	got, err := repo.SelectByID(ctx, server.ID)
	if err != nil {
		t.Fatalf("SelectByID: %v", err)
	}
	if got != nil {
		t.Fatal("expected the row to be gone")
	}
}

func TestMcpRepository_SelectByServerNameReturnsNilForMissing(t *testing.T) {
	repo, _, _ := newTestMcpRepo(t)
	got, err := repo.SelectByServerName(context.Background(), "nope")
	if err != nil {
		t.Fatalf("SelectByServerName: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v, want nil", got)
	}
}
