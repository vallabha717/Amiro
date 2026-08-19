package db

import (
	"fmt"
	"log"
	"os"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Open connects to the dialect-appropriate database (driver/dsn picked by
// internal/config.Config.DatabaseDriver/DatabaseDSN), applies every pending
// migration, and returns a ready-to-use *gorm.DB. Same struct/query code
// works unmodified against either return value, per plan section 3.
func Open(driver, dsn string) (*gorm.DB, error) {
	var dialector gorm.Dialector
	switch driver {
	case DialectSQLite:
		dialector = sqlite.Open(dsn)
	case DialectPostgres:
		dialector = postgres.Open(dsn)
	default:
		return nil, fmt.Errorf("db: unknown driver %q (want %q or %q)", driver, DialectSQLite, DialectPostgres)
	}

	// IgnoreRecordNotFoundError: found by running internal/auth's tests --
	// GORM's default logger otherwise logs every gorm.ErrRecordNotFound at
	// Warn level, which is the *expected* outcome of routine lookups like
	// "does this email already exist" or "is this session token valid", not
	// a real error worth alarming on.
	gormLogger := logger.New(log.New(os.Stderr, "", log.LstdFlags), logger.Config{
		SlowThreshold:             200 * time.Millisecond,
		LogLevel:                  logger.Warn,
		IgnoreRecordNotFoundError: true,
	})

	gdb, err := gorm.Open(dialector, &gorm.Config{Logger: gormLogger})
	if err != nil {
		return nil, fmt.Errorf("db: open %s: %w", driver, err)
	}

	sqlDB, err := gdb.DB()
	if err != nil {
		return nil, fmt.Errorf("db: underlying sql.DB: %w", err)
	}

	if driver == DialectSQLite {
		// SQLite defaults foreign-key enforcement OFF per-connection; every
		// migration in migrations/sqlite/ declares REFERENCES ... ON DELETE
		// CASCADE expecting it ON, so this must run before Migrate below
		// (matters for the down-migration DROP TABLE CASCADE-equivalent
		// behavior on rollback, and for cascade deletes at runtime).
		if _, err := sqlDB.Exec(`PRAGMA foreign_keys = ON`); err != nil {
			return nil, fmt.Errorf("db: enable foreign_keys pragma: %w", err)
		}

		// Write-ahead logging, so a reader is never blocked by the writer and
		// a second process can open the same file at all.
		//
		// The default rollback journal takes an exclusive lock for the whole
		// of every write transaction, and a second connection that meets it
		// fails *immediately* with SQLITE_BUSY rather than waiting. That was
		// survivable while exactly one process (the Tauri sidecar) ever
		// opened the database. It stops being survivable the moment anything
		// else does -- the terminal client, a headless run, a backup tool --
		// and the symptom is a hard "database is locked" error on an
		// ordinary save, not a slow query.
		//
		// busy_timeout is the other half and is useless without this one: it
		// makes a connection that meets a held lock wait up to five seconds
		// instead of failing, which turns the remaining writer-vs-writer
		// collisions (WAL still allows only one writer) into latency.
		//
		// Both are strict improvements for the desktop app on its own, which
		// is why they land here rather than behind a flag. WAL is a property
		// of the database file, persisting across connections; the pragma is
		// re-issued every open because that is harmless and means a file
		// restored from a non-WAL backup is upgraded rather than silently
		// running in the old mode.
		if _, err := sqlDB.Exec(`PRAGMA journal_mode = WAL`); err != nil {
			return nil, fmt.Errorf("db: enable WAL journal mode: %w", err)
		}
		if _, err := sqlDB.Exec(`PRAGMA busy_timeout = 5000`); err != nil {
			return nil, fmt.Errorf("db: set busy_timeout pragma: %w", err)
		}
	}

	if err := Migrate(sqlDB, driver); err != nil {
		return nil, fmt.Errorf("db: migrate: %w", err)
	}

	return gdb, nil
}
