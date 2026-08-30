-- background_jobs is the durable row behind a background agent run
-- (docs/coding-agent-parity/05-background-agent-runs.md): the in-memory
-- worker registry is a liveness cache over this table, never the source of
-- truth, so a job survives a restart and a suspended job's pending approval
-- is resolvable from any surface that can open thread_id.
CREATE TABLE background_jobs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_thread(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    prompt TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('edit', 'auto')),
    status TEXT NOT NULL CHECK (status IN ('running', 'suspended', 'done', 'failed', 'interrupted')),
    auto_pr INTEGER NOT NULL DEFAULT 0,
    auto_pr_started INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMP NOT NULL,
    finished_at TIMESTAMP
);
CREATE INDEX background_jobs_user_started_idx ON background_jobs(user_id, started_at DESC);
CREATE INDEX background_jobs_thread_idx ON background_jobs(thread_id);
CREATE INDEX background_jobs_status_idx ON background_jobs(status);
