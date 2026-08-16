package repository

import (
	"context"
	"path/filepath"
	"testing"

	"gorm.io/datatypes"

	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
)

func newTestCustomizationRepos(t *testing.T) (*McpServerCustomizationRepository, *McpToolCustomizationRepository, string, *models.User) {
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
	server := &models.McpServer{Name: "my-server", UserID: u.ID, Config: datatypes.JSON(`{}`)}
	mcpRepo := NewMcpRepository(gdb)
	if err := mcpRepo.Save(context.Background(), server); err != nil {
		t.Fatalf("save server: %v", err)
	}
	return NewMcpServerCustomizationRepository(gdb), NewMcpToolCustomizationRepository(gdb), server.ID, u
}

func strPtr(s string) *string { return &s }

func TestMcpServerCustomizationRepository_UpsertInsertsThenUpdatesPrompt(t *testing.T) {
	serverCustom, _, serverID, u := newTestCustomizationRepos(t)
	ctx := context.Background()

	if _, err := serverCustom.Upsert(ctx, u.ID, serverID, strPtr("be terse")); err != nil {
		t.Fatalf("first Upsert: %v", err)
	}
	got, err := serverCustom.Upsert(ctx, u.ID, serverID, strPtr("be verbose"))
	if err != nil {
		t.Fatalf("second Upsert: %v", err)
	}
	if got.Prompt == nil || *got.Prompt != "be verbose" {
		t.Fatalf("prompt = %v, want \"be verbose\"", got.Prompt)
	}

	all, err := serverCustom.SelectByUserID(ctx, u.ID)
	if err != nil {
		t.Fatalf("SelectByUserID: %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("got %d rows, want 1 (upsert should not duplicate)", len(all))
	}
}

func TestMcpServerCustomizationRepository_SelectReturnsNilWhenAbsent(t *testing.T) {
	serverCustom, _, serverID, u := newTestCustomizationRepos(t)
	got, err := serverCustom.SelectByUserIDAndServerID(context.Background(), u.ID, serverID)
	if err != nil {
		t.Fatalf("SelectByUserIDAndServerID: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v, want nil", got)
	}
}

func TestMcpServerCustomizationRepository_Delete(t *testing.T) {
	serverCustom, _, serverID, u := newTestCustomizationRepos(t)
	ctx := context.Background()
	_, _ = serverCustom.Upsert(ctx, u.ID, serverID, strPtr("x"))

	if err := serverCustom.DeleteByUserIDAndServerID(ctx, u.ID, serverID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	got, err := serverCustom.SelectByUserIDAndServerID(ctx, u.ID, serverID)
	if err != nil {
		t.Fatalf("SelectByUserIDAndServerID: %v", err)
	}
	if got != nil {
		t.Fatal("expected the row to be gone")
	}
}

func TestMcpToolCustomizationRepository_UpsertInsertsThenUpdatesPrompt(t *testing.T) {
	_, toolCustom, serverID, u := newTestCustomizationRepos(t)
	ctx := context.Background()

	if _, err := toolCustom.Upsert(ctx, u.ID, serverID, "add", strPtr("round to 2 decimals")); err != nil {
		t.Fatalf("first Upsert: %v", err)
	}
	got, err := toolCustom.Upsert(ctx, u.ID, serverID, "add", strPtr("round to 4 decimals"))
	if err != nil {
		t.Fatalf("second Upsert: %v", err)
	}
	if got.Prompt == nil || *got.Prompt != "round to 4 decimals" {
		t.Fatalf("prompt = %v", got.Prompt)
	}

	rows, err := toolCustom.SelectByUserIDAndServerID(ctx, u.ID, serverID)
	if err != nil {
		t.Fatalf("SelectByUserIDAndServerID: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1 (upsert should not duplicate)", len(rows))
	}
}

func TestMcpToolCustomizationRepository_DistinctToolsOnSameServerDoNotCollide(t *testing.T) {
	_, toolCustom, serverID, u := newTestCustomizationRepos(t)
	ctx := context.Background()

	_, _ = toolCustom.Upsert(ctx, u.ID, serverID, "add", strPtr("prompt for add"))
	_, _ = toolCustom.Upsert(ctx, u.ID, serverID, "subtract", strPtr("prompt for subtract"))

	rows, err := toolCustom.SelectByUserID(ctx, u.ID)
	if err != nil {
		t.Fatalf("SelectByUserID: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2 distinct tool customizations", len(rows))
	}
}

func TestMcpToolCustomizationRepository_Delete(t *testing.T) {
	_, toolCustom, serverID, u := newTestCustomizationRepos(t)
	ctx := context.Background()
	_, _ = toolCustom.Upsert(ctx, u.ID, serverID, "add", strPtr("x"))

	if err := toolCustom.Delete(ctx, u.ID, serverID, "add"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	got, err := toolCustom.Select(ctx, u.ID, serverID, "add")
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	if got != nil {
		t.Fatal("expected the row to be gone")
	}
}
