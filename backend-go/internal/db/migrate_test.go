package db

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "github.com/glebarez/sqlite" // registers the "sqlite" database/sql driver used below
)

func TestSplitMigrationFilename_ParsesVersionAndName(t *testing.T) {
	version, rest, ok := splitMigrationFilename("0007_agent.up.sql")
	if !ok {
		t.Fatal("expected ok=true")
	}
	if version != 7 {
		t.Fatalf("version = %d, want 7", version)
	}
	if rest != "agent.up.sql" {
		t.Fatalf("rest = %q, want %q", rest, "agent.up.sql")
	}
}

func TestSplitMigrationFilename_RejectsNameWithoutUnderscore(t *testing.T) {
	_, _, ok := splitMigrationFilename("readme.sql")
	if ok {
		t.Fatal("expected ok=false for a filename with no version prefix")
	}
}

func TestLoadMigrations_RejectsUnknownDialect(t *testing.T) {
	if _, err := loadMigrations("mysql"); err == nil {
		t.Fatal("expected an error for an unknown dialect")
	}
}

func TestLoadMigrations_ReturnsAllTwentyInVersionOrder(t *testing.T) {
	migrations, err := loadMigrations(DialectSQLite)
	if err != nil {
		t.Fatalf("loadMigrations: %v", err)
	}
	if len(migrations) != 20 {
		t.Fatalf("len(migrations) = %d, want 20", len(migrations))
	}
	for i, m := range migrations {
		if m.Version != i+1 {
			t.Fatalf("migrations[%d].Version = %d, want %d (out of order)", i, m.Version, i+1)
		}
		if m.UpSQL == "" || m.DownSQL == "" {
			t.Fatalf("migration %04d_%s missing up or down SQL", m.Version, m.Name)
		}
	}
}

func openRawSQLite(t *testing.T) *sql.DB {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	return sqlDB
}

func TestMigrate_RunningTwiceIsANoOp(t *testing.T) {
	sqlDB := openRawSQLite(t)

	if err := Migrate(sqlDB, DialectSQLite); err != nil {
		t.Fatalf("first Migrate: %v", err)
	}
	if err := Migrate(sqlDB, DialectSQLite); err != nil {
		t.Fatalf("second Migrate: %v", err)
	}

	var count int
	if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatalf("count schema_migrations: %v", err)
	}
	if count != 20 {
		t.Fatalf("schema_migrations has %d rows, want 20 (re-run should not duplicate)", count)
	}
}

func TestMigrate_UnknownDialectReturnsError(t *testing.T) {
	sqlDB := openRawSQLite(t)
	if err := Migrate(sqlDB, "mysql"); err == nil {
		t.Fatal("expected an error for an unknown dialect")
	}
}
