CREATE TABLE workflow (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL DEFAULT '0.1.0',
    name TEXT NOT NULL,
    icon JSONB,
    description TEXT,
    is_published BOOLEAN NOT NULL DEFAULT false,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private','readonly')),
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX workflow_user_id_idx ON workflow(user_id);
