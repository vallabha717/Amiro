package repository

import (
	"context"
	"path/filepath"
	"testing"

	"gorm.io/datatypes"

	"betterchatbot/backend/internal/db"
	"betterchatbot/backend/internal/db/models"
)

func newTestMcpOAuthEnv(t *testing.T) (*McpOAuthSessionRepository, string) {
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
	server := &models.McpServer{Name: "remote-server", UserID: u.ID, Config: datatypes.JSON(`{"url":"https://example.com/mcp"}`)}
	mcpRepo := NewMcpRepository(gdb)
	if err := mcpRepo.Save(context.Background(), server); err != nil {
		t.Fatalf("save server: %v", err)
	}
	return NewMcpOAuthSessionRepository(gdb), server.ID
}

func TestMcpOAuthSessionRepository_CreateSessionThenGetByState(t *testing.T) {
	repo, serverID := newTestMcpOAuthEnv(t)
	ctx := context.Background()

	created, err := repo.CreateSession(ctx, serverID, "https://example.com/mcp", "state-1", "verifier-1")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if created.ID == "" {
		t.Fatal("expected a generated ID")
	}

	got, err := repo.GetByState(ctx, "state-1")
	if err != nil {
		t.Fatalf("GetByState: %v", err)
	}
	if got == nil || got.McpServerID != serverID || got.CodeVerifier == nil || *got.CodeVerifier != "verifier-1" {
		t.Fatalf("got %+v", got)
	}
}

func TestMcpOAuthSessionRepository_GetByState_UnknownReturnsNil(t *testing.T) {
	repo, _ := newTestMcpOAuthEnv(t)
	got, err := repo.GetByState(context.Background(), "does-not-exist")
	if err != nil {
		t.Fatalf("GetByState: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil for an unknown state, got %+v", got)
	}
}

func TestMcpOAuthSessionRepository_GetLatestForServer_ReturnsMostRecent(t *testing.T) {
	repo, serverID := newTestMcpOAuthEnv(t)
	ctx := context.Background()

	first, err := repo.CreateSession(ctx, serverID, "https://example.com/mcp", "state-old", "verifier-old")
	if err != nil {
		t.Fatal(err)
	}
	second, err := repo.CreateSession(ctx, serverID, "https://example.com/mcp", "state-new", "verifier-new")
	if err != nil {
		t.Fatal(err)
	}
	// Force a distinct, later updated_at than at creation time.
	if err := repo.SaveClientInfo(ctx, second.ID, datatypes.JSON(`{"clientId":"c2"}`)); err != nil {
		t.Fatal(err)
	}

	latest, err := repo.GetLatestForServer(ctx, serverID)
	if err != nil {
		t.Fatalf("GetLatestForServer: %v", err)
	}
	if latest == nil || latest.ID != second.ID {
		t.Fatalf("got %+v, want the most recently updated session (id=%s), not the first (id=%s)", latest, second.ID, first.ID)
	}
}

func TestMcpOAuthSessionRepository_SaveClientInfoAndSaveTokens(t *testing.T) {
	repo, serverID := newTestMcpOAuthEnv(t)
	ctx := context.Background()

	session, err := repo.CreateSession(ctx, serverID, "https://example.com/mcp", "state-1", "verifier-1")
	if err != nil {
		t.Fatal(err)
	}

	if err := repo.SaveClientInfo(ctx, session.ID, datatypes.JSON(`{"clientId":"c1","tokenEndpoint":"https://example.com/token"}`)); err != nil {
		t.Fatalf("SaveClientInfo: %v", err)
	}
	if err := repo.SaveTokens(ctx, session.ID, datatypes.JSON(`{"accessToken":"at-1"}`)); err != nil {
		t.Fatalf("SaveTokens: %v", err)
	}

	got, err := repo.GetByState(ctx, "state-1")
	if err != nil {
		t.Fatal(err)
	}
	if string(got.ClientInfo) != `{"clientId":"c1","tokenEndpoint":"https://example.com/token"}` {
		t.Fatalf("ClientInfo = %s", got.ClientInfo)
	}
	if string(got.Tokens) != `{"accessToken":"at-1"}` {
		t.Fatalf("Tokens = %s", got.Tokens)
	}
}

func TestMcpOAuthSessionRepository_SaveTokensAndCleanup_RemovesOtherAbandonedSessions(t *testing.T) {
	repo, serverID := newTestMcpOAuthEnv(t)
	ctx := context.Background()

	abandoned, err := repo.CreateSession(ctx, serverID, "https://example.com/mcp", "state-abandoned", "verifier-a")
	if err != nil {
		t.Fatal(err)
	}
	completed, err := repo.CreateSession(ctx, serverID, "https://example.com/mcp", "state-completed", "verifier-b")
	if err != nil {
		t.Fatal(err)
	}

	if err := repo.SaveTokensAndCleanup(ctx, completed.ID, serverID, datatypes.JSON(`{"accessToken":"at-1"}`)); err != nil {
		t.Fatalf("SaveTokensAndCleanup: %v", err)
	}

	stillThere, err := repo.GetByState(ctx, "state-completed")
	if err != nil {
		t.Fatal(err)
	}
	if stillThere == nil || string(stillThere.Tokens) != `{"accessToken":"at-1"}` {
		t.Fatalf("expected the completed session's tokens saved, got %+v", stillThere)
	}

	gone, err := repo.GetByState(ctx, "state-abandoned")
	if err != nil {
		t.Fatal(err)
	}
	if gone != nil {
		t.Fatalf("expected the abandoned tokenless session (id=%s) deleted, got %+v", abandoned.ID, gone)
	}
}

func TestMcpOAuthSessionRepository_DeleteForServer(t *testing.T) {
	repo, serverID := newTestMcpOAuthEnv(t)
	ctx := context.Background()

	if _, err := repo.CreateSession(ctx, serverID, "https://example.com/mcp", "state-1", "verifier-1"); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteForServer(ctx, serverID); err != nil {
		t.Fatalf("DeleteForServer: %v", err)
	}
	got, err := repo.GetLatestForServer(ctx, serverID)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("expected no sessions left after DeleteForServer, got %+v", got)
	}
}
