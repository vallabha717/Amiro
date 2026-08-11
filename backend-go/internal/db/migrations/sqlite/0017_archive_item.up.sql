CREATE TABLE archive_item (
    id TEXT PRIMARY KEY,
    archive_id TEXT NOT NULL REFERENCES archive(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX archive_item_archive_id_idx ON archive_item(archive_id);
CREATE INDEX archive_item_item_id_idx ON archive_item(item_id);
