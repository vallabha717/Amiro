-- A trust grant is a row, not a flag on Workspace (docs/coding-agent-parity/
-- 01-workspace-trust-and-rules.md): one per (user, resolved_root), so the
-- permission engine can ask "has this user already agreed to this exact
-- root?" instead of trusting connection state or a client-supplied flag.
-- resolved_root is always the symlink-resolved absolute path
-- workspace.Workspace.Root() produces -- the same path containment already
-- checks against -- so a grant can't be bypassed by a symlink alias of an
-- already-granted root, nor miss a legitimately-granted one over a trailing
-- slash or case difference.
CREATE TABLE workspace_trust (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    resolved_root TEXT NOT NULL,
    granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    granted_via TEXT NOT NULL,
    UNIQUE(user_id, resolved_root)
);
CREATE INDEX workspace_trust_user_id_idx ON workspace_trust(user_id);
