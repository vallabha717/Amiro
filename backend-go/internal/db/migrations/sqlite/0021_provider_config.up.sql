-- One row per user-configured provider connection, not per provider type:
-- the same type can be configured more than once (two OpenAI-compatible
-- gateways with different base URLs and keys), so `provider` is the type
-- discriminator and carries no uniqueness constraint -- `name` is what
-- disambiguates them in the model selector.
--
-- api_key is stored here in plaintext deliberately. The desktop build's
-- keychain path (internal/secrets) can't satisfy the product requirement
-- that a user can read back and edit a key they already saved, which is
-- exactly how MCP server configs already behave in this app.
CREATE TABLE provider_config (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    models TEXT NOT NULL DEFAULT '[]',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX provider_config_provider_idx ON provider_config(provider);
