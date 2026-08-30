-- See migrations/sqlite/0025_workspace_trust.up.sql for why resolved_root
-- is the grant's key and why revocation is a DELETE, not a soft flag: the
-- design doc's revocation rule ("does not retroactively undo anything;
-- it only changes what a future turn against that root may do") only
-- needs "does a row exist", not a lifecycle to track.
CREATE TABLE workspace_trust (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    resolved_root TEXT NOT NULL,
    granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    granted_via TEXT NOT NULL,
    UNIQUE(user_id, resolved_root)
);
CREATE INDEX workspace_trust_user_id_idx ON workspace_trust(user_id);
