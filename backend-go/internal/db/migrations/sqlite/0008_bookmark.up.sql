CREATE TABLE bookmark (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    item_type TEXT NOT NULL CHECK (item_type IN ('agent','workflow','mcp')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, item_id, item_type)
);
CREATE INDEX bookmark_user_id_idx ON bookmark(user_id);
CREATE INDEX bookmark_item_idx ON bookmark(item_id, item_type);
