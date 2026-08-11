CREATE TABLE chat_export_comment (
    id TEXT PRIMARY KEY,
    export_id TEXT NOT NULL REFERENCES chat_export(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES chat_export_comment(id) ON DELETE CASCADE,
    content JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX chat_export_comment_export_id_idx ON chat_export_comment(export_id);
CREATE INDEX chat_export_comment_author_id_idx ON chat_export_comment(author_id);
CREATE INDEX chat_export_comment_parent_id_idx ON chat_export_comment(parent_id);
