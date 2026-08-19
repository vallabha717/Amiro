package db

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestOpen_RejectsUnknownDriver(t *testing.T) {
	_, err := Open("mysql", "irrelevant")
	if err == nil {
		t.Fatal("expected an error for an unknown driver, got nil")
	}
}

// TestOpen_SQLiteUsesWALAndWaitsOnBusy pins the two pragmas that let more
// than one process hold the database open.
//
// Worth a test rather than trusting the Exec: a pragma that fails to apply
// does not error, it silently leaves the previous mode in place, and the
// consequence only shows up as an intermittent "database is locked" on a
// machine where two Amiro processes happened to overlap. Reading the value
// back is the only way to know it took.
func TestOpen_SQLiteUsesWALAndWaitsOnBusy(t *testing.T) {
	gdb, err := Open(DialectSQLite, filepath.Join(t.TempDir(), "amiro.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		t.Fatalf("sql.DB: %v", err)
	}
	defer sqlDB.Close()

	var mode string
	if err := sqlDB.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil {
		t.Fatalf("read journal_mode: %v", err)
	}
	if !strings.EqualFold(mode, "wal") {
		t.Errorf("journal_mode = %q, want wal -- a second process opening this file would fail on the first write collision", mode)
	}

	var timeout int
	if err := sqlDB.QueryRow(`PRAGMA busy_timeout`).Scan(&timeout); err != nil {
		t.Fatalf("read busy_timeout: %v", err)
	}
	if timeout < 1000 {
		t.Errorf("busy_timeout = %d ms, want at least 1000 -- without it a contended write fails instead of waiting", timeout)
	}
}

// TestOpen_SQLiteAllowsASecondConnection is the property the pragmas above
// exist for, asserted directly: two connections to one file, one writing,
// the other reading, neither failing.
func TestOpen_SQLiteAllowsASecondConnection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "amiro.db")

	first, err := Open(DialectSQLite, path)
	if err != nil {
		t.Fatalf("open first: %v", err)
	}
	firstSQL, _ := first.DB()
	defer firstSQL.Close()

	second, err := Open(DialectSQLite, path)
	if err != nil {
		t.Fatalf("open second: %v", err)
	}
	secondSQL, _ := second.DB()
	defer secondSQL.Close()

	if _, err := firstSQL.Exec(`CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT)`); err != nil {
		t.Fatalf("first connection write: %v", err)
	}
	if _, err := firstSQL.Exec(`INSERT INTO probe (note) VALUES ('written by the first')`); err != nil {
		t.Fatalf("first connection insert: %v", err)
	}

	var note string
	if err := secondSQL.QueryRow(`SELECT note FROM probe`).Scan(&note); err != nil {
		t.Fatalf("second connection read: %v", err)
	}
	if note != "written by the first" {
		t.Errorf("second connection read %q", note)
	}

	if _, err := secondSQL.Exec(`INSERT INTO probe (note) VALUES ('written by the second')`); err != nil {
		t.Fatalf("second connection write: %v", err)
	}
}
