-- Irreversible by design, same as 0023_drop_scraping_search_providers's
-- down migration: this restores the schema (an empty agent table, matching
-- 0007_agent.up.sql), not the rows the up migration deleted, and not the
-- bookmark rows it deleted either. A developer rolling back to debug
-- something else gets a working table shape, not their data back.
CREATE TABLE agent (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    instructions TEXT,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private','readonly')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX agent_user_id_idx ON agent(user_id);
