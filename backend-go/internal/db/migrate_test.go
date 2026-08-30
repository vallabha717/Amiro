package db

import (
	"database/sql"
	"io/fs"
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

// countMigrationFiles is the expected migration count, read from the
// embedded files rather than written down.
//
// This used to be a literal, and a literal is wrong the moment anyone adds a
// migration -- which is what happened: the number said 21 while the tree held
// 22, so the suite failed for everyone until someone edited a constant that
// asserts nothing about correctness. The invariants worth testing are the
// ones below (contiguous from 1, both directions present, both dialects in
// step); the total is just bookkeeping and the tree already knows it.
func countMigrationFiles(t *testing.T, dialect string) int {
	t.Helper()
	entries, err := fs.Glob(migrationFS, "migrations/"+dialect+"/*.up.sql")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	return len(entries)
}

func TestLoadMigrations_ReturnsEveryMigrationInVersionOrder(t *testing.T) {
	migrations, err := loadMigrations(DialectSQLite)
	if err != nil {
		t.Fatalf("loadMigrations: %v", err)
	}
	if want := countMigrationFiles(t, DialectSQLite); len(migrations) != want {
		t.Fatalf("len(migrations) = %d, want %d (one per .up.sql on disk)", len(migrations), want)
	}
	for i, m := range migrations {
		// Contiguous and 1-based: a gap means a migration was deleted
		// rather than superseded, and every install past that point has a
		// schema nothing in the tree describes.
		if m.Version != i+1 {
			t.Fatalf("migrations[%d].Version = %d, want %d (gap or out of order)", i, m.Version, i+1)
		}
		if m.UpSQL == "" || m.DownSQL == "" {
			t.Fatalf("migration %04d_%s missing up or down SQL", m.Version, m.Name)
		}
	}
}

// The dual-deploy invariant: sqlite is the desktop schema and postgres is the
// web one, and a migration added to only one of them is a difference that
// stays invisible until the other deploy runs.
func TestLoadMigrations_DialectsAreInStep(t *testing.T) {
	sqliteMigrations, err := loadMigrations(DialectSQLite)
	if err != nil {
		t.Fatalf("loadMigrations(sqlite): %v", err)
	}
	postgresMigrations, err := loadMigrations(DialectPostgres)
	if err != nil {
		t.Fatalf("loadMigrations(postgres): %v", err)
	}
	if len(sqliteMigrations) != len(postgresMigrations) {
		t.Fatalf("sqlite has %d migrations, postgres has %d -- one dialect is missing a migration",
			len(sqliteMigrations), len(postgresMigrations))
	}
	for i := range sqliteMigrations {
		if sqliteMigrations[i].Version != postgresMigrations[i].Version {
			t.Fatalf("version mismatch at index %d: sqlite %d, postgres %d",
				i, sqliteMigrations[i].Version, postgresMigrations[i].Version)
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
	if want := countMigrationFiles(t, DialectSQLite); count != want {
		t.Fatalf("schema_migrations has %d rows, want %d (re-run should not duplicate)", count, want)
	}
}

func TestMigrate_UnknownDialectReturnsError(t *testing.T) {
	sqlDB := openRawSQLite(t)
	if err := Migrate(sqlDB, "mysql"); err == nil {
		t.Fatal("expected an error for an unknown dialect")
	}
}

// TestMigrate_0024DropAgent_AppliesThenRollsBack is Phase 6's (docs/skills/)
// migration proof. This hand-rolled runner has no automatic down-migration
// command (Migrate only ever walks forward, see this file's package doc
// comment) -- DownSQL is loaded but never executed by production code, so
// "rolls back" here means what it can honestly mean given that: running
// 0024's own down.sql directly is valid, executable SQL that restores the
// table shape, the same way a developer debugging by hand would use it.
func TestMigrate_0024DropAgent_AppliesThenRollsBack(t *testing.T) {
	sqlDB := openRawSQLite(t)

	if err := Migrate(sqlDB, DialectSQLite); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	if _, err := sqlDB.Exec(`SELECT * FROM agent`); err == nil {
		t.Fatal("SELECT on the agent table succeeded after migration -- 0024_drop_agent did not run")
	}

	migrations, err := loadMigrations(DialectSQLite)
	if err != nil {
		t.Fatalf("loadMigrations: %v", err)
	}
	var down string
	for _, m := range migrations {
		if m.Version == 24 {
			down = m.DownSQL
		}
	}
	if down == "" {
		t.Fatal("migration 0024 has no DownSQL loaded")
	}
	if _, err := sqlDB.Exec(down); err != nil {
		t.Fatalf("executing 0024's down.sql: %v", err)
	}

	if _, err := sqlDB.Exec(`SELECT * FROM agent`); err != nil {
		t.Fatalf("SELECT on the agent table failed after rollback: %v", err)
	}
}
