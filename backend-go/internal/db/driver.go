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
	}

	if err := Migrate(sqlDB, driver); err != nil {
		return nil, fmt.Errorf("db: migrate: %w", err)
	}

	return gdb, nil
}
