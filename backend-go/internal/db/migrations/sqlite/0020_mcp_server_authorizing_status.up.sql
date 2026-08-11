CREATE TABLE mcp_server_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
    tool_info TEXT,
    tool_info_updated_at TIMESTAMP,
    last_connection_status TEXT CHECK (last_connection_status IN ('connected','error','authorizing')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO mcp_server_new SELECT * FROM mcp_server;
DROP TABLE mcp_server;
ALTER TABLE mcp_server_new RENAME TO mcp_server;
CREATE INDEX mcp_server_user_id_idx ON mcp_server(user_id);
