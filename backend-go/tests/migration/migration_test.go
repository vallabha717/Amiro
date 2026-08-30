// Package migration is a cross-cutting suite (plan section 6's "expect
// tests/migration/ in Phase 1"): it drives the real internal/db.Open
// against a real database file/instance and checks the full 18-table
// schema round-trips, not just that individual .sql files parse.
package migration

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
)

// roundTrip exercises a representative FK chain (user -> session,
// user -> chat_thread -> chat_message) plus one JSON-blob column
// (ChatMessage.Parts, the Postgres-array-to-JSON portability fix from plan
// section 3) against whichever *gorm.DB Open handed back.
func roundTrip(t *testing.T, driver, dsn string) {
	t.Helper()

	gdb, err := db.Open(driver, dsn)
	if err != nil {
		t.Fatalf("Open(%q): %v", driver, err)
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		t.Fatalf("underlying sql.DB: %v", err)
	}
	defer sqlDB.Close()

	user := &models.User{Name: "Ada", Email: "ada@example.com"}
	if err := gdb.Create(user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	if user.ID == "" {
		t.Fatal("BeforeCreate did not assign an ID")
	}

	session := &models.Session{
		UserID:    user.ID,
		Token:     "test-token-" + user.ID,
		ExpiresAt: time.Now().Add(time.Hour),
	}
	if err := gdb.Create(session).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}

	thread := &models.ChatThread{Title: "hello", UserID: user.ID}
	if err := gdb.Create(thread).Error; err != nil {
		t.Fatalf("create chat_thread: %v", err)
	}

	msg := &models.ChatMessage{
		ID:       "msg-1",
		ThreadID: thread.ID,
		Role:     "user",
		Parts:    []byte(`[{"type":"text","text":"hi"}]`),
	}
	if err := gdb.Create(msg).Error; err != nil {
		t.Fatalf("create chat_message: %v", err)
	}

	var fetched models.ChatMessage
	if err := gdb.First(&fetched, "id = ?", "msg-1").Error; err != nil {
		t.Fatalf("fetch chat_message: %v", err)
	}
	// Compared semantically, not byte-for-byte: Postgres' JSONB column type
	// canonicalizes key order/whitespace on storage (found by running this
	// test for real against Postgres -- SQLite's plain TEXT column doesn't
	// do this, so the byte-exact assertion this replaced passed on SQLite
	// and failed on Postgres). Harmless as long as callers always go
	// through encoding/json rather than comparing the raw column bytes.
	var want, got any
	if err := json.Unmarshal([]byte(`[{"type":"text","text":"hi"}]`), &want); err != nil {
		t.Fatalf("unmarshal want: %v", err)
	}
	if err := json.Unmarshal(fetched.Parts, &got); err != nil {
		t.Fatalf("unmarshal got: %v", err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("Parts round-tripped to %v, want %v", got, want)
	}

	// Deleting the user must cascade to session/thread/message via the FK
	// ON DELETE CASCADE declared in every migrations/<dialect>/*.up.sql.
	if err := gdb.Delete(user).Error; err != nil {
		t.Fatalf("delete user: %v", err)
	}
	var remaining int64
	gdb.Model(&models.ChatMessage{}).Where("id = ?", "msg-1").Count(&remaining)
	if remaining != 0 {
		t.Fatalf("chat_message survived cascade delete of its owning user")
	}

	// Re-running Migrate against the same DB must be a no-op, not an error
	// -- this is what happens on every real startup after the first.
	if err := db.Migrate(sqlDB, driver); err != nil {
		t.Fatalf("second Migrate call: %v", err)
	}
}

func TestMigrate_SQLite_CreatesAllTablesAndRoundTrips(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "test.db")
	roundTrip(t, db.DialectSQLite, dsn)
}

func TestMigrate_SQLite_AllTwentyTablesExist(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		t.Fatalf("underlying sql.DB: %v", err)
	}
	defer sqlDB.Close()

	want := []string{
		"user", "session", "account", "verification", "chat_thread",
		"chat_message", "bookmark", "mcp_server",
		"mcp_server_tool_custom_instructions", "mcp_server_custom_instructions",
		"mcp_oauth_session", "workflow", "workflow_node", "workflow_edge",
		"archive", "archive_item", "chat_export", "chat_export_comment",
		"workspace_trust", "checkpoint_files",
	}
	for _, table := range want {
		var name string
		err := sqlDB.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, table).Scan(&name)
		if err != nil {
			t.Errorf("table %q: %v", table, err)
		}
	}

	// agent was decommissioned in Phase 6 (docs/skills/) -- 0024_drop_agent
	// must have actually dropped it, not merely stopped a new install from
	// creating it, or a desktop install upgrading from an older version
	// would carry a dead table forever.
	var name string
	err = sqlDB.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'agent'`).Scan(&name)
	if err == nil {
		t.Fatal("agent table still exists after migration -- 0024_drop_agent did not run")
	}
}

// TestMigrate_Postgres runs the same round trip against a real Postgres
// instance, gated behind an env var the same way Phase 0's gorm spike gated
// SPIKE_POSTGRES_URL -- postgres isn't available in every environment this
// suite runs in, so it skips rather than fails when unset.
func TestMigrate_Postgres_CreatesAllTablesAndRoundTrips(t *testing.T) {
	dsn := os.Getenv("BACKENDGO_TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("BACKENDGO_TEST_POSTGRES_URL not set, skipping postgres migration test")
	}
	roundTrip(t, db.DialectPostgres, dsn)
}
