-- checkpoint_files is the index over the pre-image blob store
-- (docs/coding-agent-parity/02-checkpoints-and-rewind.md): one row per file
-- a turn is about to write, captured lazily on that file's first
-- write_file/edit_file/multi_edit call within the turn. resolved_root
-- travels with path rather than being assumed to be whatever workspace is
-- "currently active" when a restore later runs, so a restore always
-- resolves against the exact root that was in effect when the pre-image
-- was captured -- never a workspace override a later turn happened to pass.
-- blob_key is empty when existed_before is false: a file write created
-- rather than a file write overwrote has no pre-image bytes to store.
CREATE TABLE checkpoint_files (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    path TEXT NOT NULL,
    resolved_root TEXT NOT NULL,
    blob_key TEXT NOT NULL DEFAULT '',
    existed_before INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Unique on (thread_id, turn_id, path): the whole "captured lazily on the
-- first write to a path within a turn" contract is enforced here, not just
-- in application code -- a second capture attempt for the same file in the
-- same turn is a no-op insert, never a second (wrong, post-edit) pre-image.
CREATE UNIQUE INDEX checkpoint_files_turn_path_idx ON checkpoint_files(thread_id, turn_id, path);
CREATE INDEX checkpoint_files_thread_created_idx ON checkpoint_files(thread_id, created_at);
