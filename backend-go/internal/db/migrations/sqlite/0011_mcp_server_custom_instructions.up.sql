CREATE TABLE mcp_server_custom_instructions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    mcp_server_id TEXT NOT NULL REFERENCES mcp_server(id) ON DELETE CASCADE,
    prompt TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, mcp_server_id)
);
