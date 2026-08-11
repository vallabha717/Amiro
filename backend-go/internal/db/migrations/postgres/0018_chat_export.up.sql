CREATE TABLE chat_export (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    exporter_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    original_thread_id TEXT,
    messages JSONB,
    exported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
);
CREATE INDEX chat_export_exporter_id_idx ON chat_export(exporter_id);
