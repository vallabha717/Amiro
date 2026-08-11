CREATE TABLE chat_message (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    parts JSONB NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX chat_message_thread_id_idx ON chat_message(thread_id);
