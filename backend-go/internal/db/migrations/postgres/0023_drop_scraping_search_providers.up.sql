-- DuckDuckGo and SearxNG are gone from internal/search: both were scrapers
-- of endpoints that block data-center IPs (DDG answers 202 with a CAPTCHA,
-- public SearxNG instances answer 200 with an HTML bot challenge), and a
-- stored row naming one of them would now resolve to no adapter at all.
--
-- Deleted rather than migrated to a surviving provider: every remaining
-- provider needs an API key that these rows cannot supply, so a converted
-- row would be a config that looks ready and fails on first use.
DELETE FROM search_provider_config WHERE provider IN ('duckduckgo', 'searxng');

-- If that removed the active one, promote the oldest survivor, matching
-- SearchProviderRepository.Delete's rule: if any provider exists, one is
-- active.
UPDATE search_provider_config
SET is_active = true
WHERE id = (SELECT id FROM search_provider_config ORDER BY created_at ASC, id ASC LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM search_provider_config WHERE is_active = true);

-- base_url is left in place, unused, with its NOT NULL DEFAULT ''. Every
-- surviving provider authenticates with a key and none takes a base URL, so
-- the column is dead -- but SQLite's DROP COLUMN is both recent and refused
-- on any column an index or view touches, and a failed migration on an
-- existing desktop install costs more than a dead column does.
