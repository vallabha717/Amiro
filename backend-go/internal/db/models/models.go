// Package models holds the GORM structs for all 18 tables ported from
// src/lib/db/pg/schema.pg.ts. Every ID/UUID column is declared TEXT/VARCHAR
// on both dialects (never Postgres' native UUID type) and generated
// app-side via NewID() in a BeforeCreate hook, per plan section 3 -- this
// keeps one struct/query set working unmodified against both the SQLite and
// Postgres GORM dialectors, matching the Phase 0 spike's proof.
package models

import "github.com/google/uuid"

// NewID returns a fresh app-generated primary-key value. Called from every
// model's BeforeCreate hook when the ID field is still empty.
func NewID() string {
	return uuid.NewString()
}

// All returns every model struct pointer, in FK-safe creation order. Used
// by tests that need to sanity-check the full set against a live DB; NOT
// used for schema creation -- schema.go's versioned SQL migrations are
// authoritative, not GORM AutoMigrate (plan section 3).
func All() []any {
	return []any{
		&User{},
		&Session{},
		&Account{},
		&Verification{},
		&ChatThread{},
		&ChatMessage{},
		&Bookmark{},
		&McpServer{},
		&McpToolCustomization{},
		&McpServerCustomization{},
		&McpOAuthSession{},
		&Workflow{},
		&WorkflowNode{},
		&WorkflowEdge{},
		&Archive{},
		&ArchiveItem{},
		&ChatExport{},
		&ChatExportComment{},
		&ProviderConfig{},
	}
}
