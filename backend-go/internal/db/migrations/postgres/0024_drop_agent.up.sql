-- The agent feature (saved, bindable custom-persona chat agents) is
-- decommissioned in Phase 6 (docs/skills/): Agent Skills replace it, and
-- this is a full removal, not a migration of existing rows -- decided and
-- recorded in docs/skills/README.md's decisions section. Anything saved as
-- an agent is dropped here.
DROP TABLE IF EXISTS agent;

-- bookmark rows naming a deleted agent would otherwise dangle: item_type
-- 'agent' no longer resolves to any table, and BookmarkRepository no longer
-- accepts it from the API (bookmark/handler.go's validate()). Delete them
-- rather than leave them for CheckItemAccess to silently deny forever.
DELETE FROM bookmark WHERE item_type = 'agent';

-- bookmark's own CHECK (item_type IN ('agent','workflow','mcp')) constraint
-- is deliberately left in place rather than rebuilt without 'agent' -- the
-- API layer (bookmark/handler.go's validate()) already refuses 'agent'
-- before a row can reach this constraint, and dropping+recreating a CHECK
-- constraint on a live table is more risk than a dead enum value justifies.
-- Mirrors the sqlite migration's reasoning (its own DROP CONSTRAINT
-- limitation doesn't even apply here; this is the same call made for
-- consistency between the two dialects, not a Postgres-specific need).
