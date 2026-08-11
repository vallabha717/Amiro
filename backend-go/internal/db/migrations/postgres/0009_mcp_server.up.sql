CREATE TABLE mcp_server (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config JSONB NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
    tool_info JSONB,
    tool_info_updated_at TIMESTAMP,
    last_connection_status TEXT CHECK (last_connection_status IN ('connected','error')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX mcp_server_user_id_idx ON mcp_server(user_id);
