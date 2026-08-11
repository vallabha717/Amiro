package models

import (
	"time"

	"gorm.io/datatypes"
)

// ChatMessage ports ChatMessageTable (schema.pg.ts:31). ID is app-supplied
// text (no default-random in the source schema either), so there is no
// BeforeCreate hook here -- callers must set ID before Create.
//
// Parts is the one real Postgres/SQLite portability gap plan section 3
// calls out: the TS column is `json("parts").notNull().array()`, a
// Postgres-native array-of-JSON type with no SQLite equivalent. Modeled
// here as a single JSON-encoded blob (the whole array marshalled as one
// value) so it behaves identically on both drivers -- callers marshal/
// unmarshal the full []UIMessagePart slice through this one column.
type ChatMessage struct {
	ID        string         `gorm:"column:id;primaryKey"`
	ThreadID  string         `gorm:"column:thread_id;not null;index"`
	Role      string         `gorm:"column:role;not null"`
	Parts     datatypes.JSON `gorm:"column:parts;not null"`
	Metadata  datatypes.JSON `gorm:"column:metadata"`
	CreatedAt time.Time      `gorm:"column:created_at;not null;autoCreateTime"`
}

func (ChatMessage) TableName() string { return "chat_message" }
