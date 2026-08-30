-- See migrations/sqlite/0026_checkpoint_files.up.sql for why resolved_root
-- travels with path and why the (thread_id, turn_id, path) uniqueness is a
-- database constraint, not just an application-level check.
CREATE TABLE checkpoint_files (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    path TEXT NOT NULL,
    resolved_root TEXT NOT NULL,
    blob_key TEXT NOT NULL DEFAULT '',
    existed_before BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX checkpoint_files_turn_path_idx ON checkpoint_files(thread_id, turn_id, path);
CREATE INDEX checkpoint_files_thread_created_idx ON checkpoint_files(thread_id, created_at);
