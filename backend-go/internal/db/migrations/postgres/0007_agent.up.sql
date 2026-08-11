CREATE TABLE agent (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    icon JSONB,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    instructions JSONB,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private','readonly')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX agent_user_id_idx ON agent(user_id);
