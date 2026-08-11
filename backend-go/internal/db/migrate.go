// Package db owns dialect selection (sqlite for desktop, postgres for web,
// per plan section 3's dual-deploy requirement) and schema migrations.
//
// Migrations are NOT run through golang-migrate: that library's only
// pure-Go SQLite source driver route goes through mattn/go-sqlite3 (cgo),
// which would reintroduce the C-toolchain cross-compile problem Phase 0
// deliberately avoided by picking glebarez/sqlite (modernc.org/sqlite,
// pure Go) as the driver. Instead this file is a small hand-rolled runner
// with the same semantics golang-migrate would give us -- a
// schema_migrations table, versioned .sql files applied in order inside a
// transaction, idempotent re-runs -- built directly on database/sql so it
// works identically against pgx's stdlib driver and modernc's sqlite
// driver without any cgo dependency anywhere in the chain.
package db

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
)

//go:embed migrations/postgres/*.sql migrations/sqlite/*.sql
var migrationFS embed.FS

// migration is one numbered schema change, loaded from a
// "NNNN_name.up.sql" / "NNNN_name.down.sql" pair.
type migration struct {
	Version int
	Name    string
	UpSQL   string
	DownSQL string
}

// Dialect names accepted by Open/Migrate. These also select the embedded
// migrations/<dialect>/ subdirectory.
const (
	DialectSQLite   = "sqlite"
	DialectPostgres = "postgres"
)

func loadMigrations(dialect string) ([]migration, error) {
	if dialect != DialectSQLite && dialect != DialectPostgres {
		return nil, fmt.Errorf("db: unknown dialect %q (want %q or %q)", dialect, DialectSQLite, DialectPostgres)
	}

	dir := "migrations/" + dialect
	entries, err := fs.ReadDir(migrationFS, dir)
	if err != nil {
		return nil, fmt.Errorf("db: read migrations dir: %w", err)
	}

	byVersion := map[int]*migration{}
	for _, entry := range entries {
		name := entry.Name()
		version, rest, ok := splitMigrationFilename(name)
		if !ok {
			continue
		}
		content, err := fs.ReadFile(migrationFS, dir+"/"+name)
		if err != nil {
			return nil, fmt.Errorf("db: read %s: %w", name, err)
		}

		m, exists := byVersion[version]
		if !exists {
			m = &migration{Version: version}
			byVersion[version] = m
		}
		switch {
		case strings.HasSuffix(rest, ".up.sql"):
			m.Name = strings.TrimSuffix(rest, ".up.sql")
			m.UpSQL = string(content)
		case strings.HasSuffix(rest, ".down.sql"):
			m.DownSQL = string(content)
		}
	}

	migrations := make([]migration, 0, len(byVersion))
	for _, m := range byVersion {
		if m.UpSQL == "" {
			return nil, fmt.Errorf("db: migration %04d has no .up.sql", m.Version)
		}
		migrations = append(migrations, *m)
	}
	sort.Slice(migrations, func(i, j int) bool { return migrations[i].Version < migrations[j].Version })
	return migrations, nil
}

// splitMigrationFilename parses "0007_agent.up.sql" into (7, "agent.up.sql").
func splitMigrationFilename(name string) (version int, rest string, ok bool) {
	underscore := strings.IndexByte(name, '_')
	if underscore < 0 {
		return 0, "", false
	}
	v, err := strconv.Atoi(name[:underscore])
	if err != nil {
		return 0, "", false
	}
	return v, name[underscore+1:], true
}

// Migrate applies every not-yet-applied migration for dialect against
// sqlDB, in order, each inside its own transaction, tracked in a
// schema_migrations table. Safe to call on every startup: already-applied
// versions are skipped.
func Migrate(sqlDB *sql.DB, dialect string) error {
	migrations, err := loadMigrations(dialect)
	if err != nil {
		return err
	}

	if _, err := sqlDB.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		return fmt.Errorf("db: create schema_migrations: %w", err)
	}

	applied := map[int]bool{}
	rows, err := sqlDB.Query(`SELECT version FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("db: read schema_migrations: %w", err)
	}
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return fmt.Errorf("db: scan schema_migrations: %w", err)
		}
		applied[v] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()

	// pgx's stdlib driver takes positional "$1"/"$2" placeholders, not "?";
	// modernc's sqlite driver takes "?". Everything else in this file is
	// dialect-agnostic SQL, so this one insert is the only place that
	// branches on it.
	insertSQL := `INSERT INTO schema_migrations (version, name) VALUES (?, ?)`
	if dialect == DialectPostgres {
		insertSQL = `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`
	}

	for _, m := range migrations {
		if applied[m.Version] {
			continue
		}

		tx, err := sqlDB.Begin()
		if err != nil {
			return fmt.Errorf("db: begin migration %04d_%s: %w", m.Version, m.Name, err)
		}
		if _, err := tx.Exec(m.UpSQL); err != nil {
			tx.Rollback()
			return fmt.Errorf("db: apply migration %04d_%s: %w", m.Version, m.Name, err)
		}
		if _, err := tx.Exec(insertSQL, m.Version, m.Name); err != nil {
			tx.Rollback()
			return fmt.Errorf("db: record migration %04d_%s: %w", m.Version, m.Name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("db: commit migration %04d_%s: %w", m.Version, m.Name, err)
		}
	}

	return nil
}
