package backend

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"amiro/tests/harness/config"
)

// Database is one test's isolated database.
//
// Isolation is not negotiable here. A shared database is the single most
// common source of order-dependent flakes, and this suite runs in parallel
// by default -- so every test gets its own file (sqlite) or its own schema
// (postgres), created before the backend starts and dropped after it stops.
type Database struct {
	Driver string
	// DSN is what AMIRO_DATABASE_URL is set to.
	DSN string
	// Dir is the directory holding a sqlite file; empty for postgres.
	Dir string

	drop func() error
}

// NewDatabase provisions a database for one test.
//
// dir is the per-test directory inside the run tree; testID is used to name
// a postgres schema, where there is no directory to hide behind.
func NewDatabase(ctx context.Context, cfg *config.Config, dir, testID string) (*Database, error) {
	switch cfg.Backend.Database.Driver {
	case "", "sqlite":
		return newSQLite(cfg, dir)
	case "postgres":
		return newPostgres(ctx, cfg, testID)
	default:
		return nil, fmt.Errorf("unsupported database driver %q", cfg.Backend.Database.Driver)
	}
}

func newSQLite(cfg *config.Config, dir string) (*Database, error) {
	if cfg.Backend.Database.DSN != "" {
		// An explicitly configured sqlite path is honoured as given. It
		// defeats per-test isolation, which is the caller's decision to
		// make -- debugging one test against one durable file is a real
		// need -- and it is recorded in run.json either way.
		return &Database{Driver: "sqlite", DSN: cfg.Backend.Database.DSN}, nil
	}
	dbDir := filepath.Join(dir, "db")
	if err := os.MkdirAll(dbDir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dbDir, "amiro.db")
	return &Database{
		Driver: "sqlite",
		DSN:    path,
		Dir:    dbDir,
		drop: func() error {
			if cfg.Backend.Database.KeepOnSuccess {
				return nil
			}
			return os.RemoveAll(dbDir)
		},
	}, nil
}

// newPostgres creates one schema per test inside the configured database
// and points the DSN's search_path at it.
//
// A schema rather than a database because CREATE DATABASE cannot run inside
// a transaction and is slow enough to dominate a fast test; a schema is
// cheap, is dropped with one CASCADE, and gives the same isolation for
// everything GORM does.
func newPostgres(ctx context.Context, cfg *config.Config, testID string) (*Database, error) {
	base := cfg.Backend.Database.DSN
	if base == "" {
		return nil, fmt.Errorf("backend.database.dsn is required for the postgres driver")
	}
	schema := schemaName(testID)

	db, err := sql.Open("pgx", base)
	if err != nil {
		return nil, fmt.Errorf("connecting to postgres: %w", err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("connecting to postgres at the configured backend.database.dsn: %w", err)
	}
	// The identifier is built by schemaName from a hash, so it is always a
	// safe bare identifier; quoting it anyway keeps that a property of this
	// statement rather than of a function three calls away.
	if _, err := db.ExecContext(ctx, fmt.Sprintf(`CREATE SCHEMA IF NOT EXISTS %q`, schema)); err != nil {
		return nil, fmt.Errorf("creating schema %s: %w", schema, err)
	}

	dsn, err := withSearchPath(base, schema)
	if err != nil {
		return nil, err
	}
	return &Database{
		Driver: "postgres",
		DSN:    dsn,
		drop: func() error {
			if cfg.Backend.Database.KeepOnSuccess {
				return nil
			}
			conn, err := sql.Open("pgx", base)
			if err != nil {
				return err
			}
			defer conn.Close()
			_, err = conn.Exec(fmt.Sprintf(`DROP SCHEMA IF EXISTS %q CASCADE`, schema))
			return err
		},
	}, nil
}

// withSearchPath adds search_path to a postgres URL or keyword DSN.
func withSearchPath(dsn, schema string) (string, error) {
	if !strings.HasPrefix(dsn, "postgres://") && !strings.HasPrefix(dsn, "postgresql://") {
		// Keyword/value form: "host=... dbname=...". options is the
		// equivalent knob, and -c search_path is how it is spelled.
		return dsn + fmt.Sprintf(" options='-c search_path=%s'", schema), nil
	}
	u, err := url.Parse(dsn)
	if err != nil {
		return "", fmt.Errorf("backend.database.dsn is not a valid URL: %w", err)
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// schemaName derives a legal postgres identifier from a test id.
//
// Postgres truncates identifiers at 63 bytes, so a long test name would
// collide with another long test name sharing a prefix -- the exact failure
// this whole function exists to prevent. Anything long is hashed.
func schemaName(testID string) string {
	safe := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_':
			return r
		case r >= 'A' && r <= 'Z':
			return r + 32
		default:
			return '_'
		}
	}, testID)
	const prefix = "amiro_test_"
	if len(safe) > 40 {
		safe = fmt.Sprintf("%s%x", safe[:24], hashString(safe))
	}
	return prefix + safe
}

func hashString(s string) uint32 {
	var h uint32 = 2166136261
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 16777619
	}
	return h
}

// Drop releases the database. Safe to call more than once.
func (d *Database) Drop() error {
	if d == nil || d.drop == nil {
		return nil
	}
	drop := d.drop
	d.drop = nil
	return drop()
}
