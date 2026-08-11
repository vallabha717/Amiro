ALTER TABLE mcp_server DROP CONSTRAINT mcp_server_last_connection_status_check;
ALTER TABLE mcp_server ADD CONSTRAINT mcp_server_last_connection_status_check CHECK (last_connection_status IN ('connected','error'));
