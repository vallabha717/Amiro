CREATE TABLE mcp_oauth_session (
    id TEXT PRIMARY KEY,
    mcp_server_id TEXT NOT NULL REFERENCES mcp_server(id) ON DELETE CASCADE,
    server_url TEXT NOT NULL,
    client_info JSONB,
    tokens JSONB,
    code_verifier TEXT,
    state TEXT UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX mcp_oauth_session_server_id_idx ON mcp_oauth_session(mcp_server_id);
CREATE INDEX mcp_oauth_session_state_idx ON mcp_oauth_session(state);
CREATE INDEX mcp_oauth_session_tokens_idx ON mcp_oauth_session(mcp_server_id) WHERE tokens IS NOT NULL;
