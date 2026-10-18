# Search runtime: configured-only provider routing

This document describes the search routing as it is actually wired today. When an
Amiro-managed provider registry is present, the runtime reaches only the
providers a user configured through Amiro. It does not fall back to any
unconfigured free engine. DuckDuckGo and Bing are eligible only when they exist
as configured providers; there is no implicit free DuckDuckGo/Bing fallback
outside the registry.

Every claim below is tied to a source path so it can be re-checked. No secrets
and no personal paths appear here.

## 1. Where the policy lives

Two layers decide what search is used.

**Registry layer (runtime home).** The Amiro backend exports the admin-configured
providers into the engine's own home, and the engine only consults that list.

- Registry file name: `search-providers-runtime.json` (`backend/src/routes/search_providers.rs`,
  `const REGISTRY`).
- Runtime config file: `config.toml` in the same home.
- Home resolution: `AMIRO_RUNTIME_HOME`, else `<AMIRO_HOME>/runtime`, else
  `~/.amiro/runtime` (`backend/src/state.rs`, `AppState::from_env`).

**Tool-exposure layer (engine).** Provider-native (hosted) search only replaces
Amiro's built-in local `websearch` tool. It never adds search to a session whose
tool policy excluded it.

- `runtime/crates/amiro-message-types/src/provider_native.rs`:
  `is_builtin_local_websearch` identifies the built-in tool by name plus the
  fixed description `"Search the web."`. A custom SDK tool that reuses the name
  `websearch` keeps its own definition and is never swapped.
- `runtime/crates/amiro-provider-anthropic-runtime/src/native_web_search.rs`:
  `server_tools_for_request` attaches the Anthropic `web_search` server tool only
  when the request is first-party, native search is enabled, and
  `session_offers_websearch(tools)` is true. `without_local_websearch` drops the
  built-in local tool so the model has exactly one way to search.
- `runtime/crates/amiro-provider-openai-runtime/src/native_web_search.rs`:
  `hosted_tools_with_config` requires native enabled, first-party backend, a
  model that supports hosted web search, and a session that offers `websearch`.
  `without_local_websearch` mirrors the Anthropic behavior.

Important nuance in both `without_local_websearch` implementations: if the
built-in `websearch` schema carries a `provider` property (which happens whenever
a configured registry is loaded), the local tool is kept even while hosted search
is attached. That is what keeps configured local alternatives usable when the
default is native.

## 2. Fresh install seeding

`seed_free_providers` (`backend/src/routes/search_providers.rs`) seeds exactly
three records on first run:

- `inference-provider-native` (label "Provider Native")
- `duckduckgo`
- `bing`

If no supported provider was already active, the migration marks the
`inference-provider-native` record active, so the first-run default is Provider
Native. `normalize_default` then makes the store's active flag match the registry
default. A migration marker (`search-providers-free-seed-v1.json`, `version: 1`)
makes this a one-time seed; later renders only normalize the default, preserving
user deletions and their own default choice.

The advertised catalog (`search_catalog`) is DuckDuckGo, Bing, Brave, Tavily,
Exa, Serper, Firecrawl, SearXNG, Custom HTTP JSON, and Provider Native. Vellum is
not in the catalog and the tests assert its absence.

## 3. What is exported to the engine

`export_config` rewrites the `[websearch]` table of the runtime `config.toml`:

- `configured_providers_file` = absolute path to `search-providers-runtime.json`.
- `engine` = the default provider's engine (`duckduckgo` if none).
- `prefer_native` = true only when a default exists and its engine is `native`.
- `fallback_engines` = `[]`.
- Inline `custom`, `bing_api_key`, and `searxng_url` are removed from the config
  and live only in the private registry.

`sync_search_to_runtime_config` writes the registry JSON first, then atomically
writes `config.toml` (temp file plus rename, mode `0o600` on unix). Startup also
repairs an interrupted export.

## 4. Runtime routing and fallback

`runtime/crates/amiro-app-core/src/tool/websearch.rs`:

- `parameters_schema` removes the `engine` property and adds a `provider`
  property whose `enum` is the configured provider IDs. It never emits the
  endpoint, keys, or raw registry JSON.
- `execute` loads the registry on each call. If `configured_providers_file` is
  set, it routes to `execute_configured` and never reaches the free-engine path.
- `execute_configured` rejects a per-call `engine` override, builds the order as
  requested provider (or registry default) first, then every other configured
  provider, and tries them in order. Success records `Fallback after: <ids>`.
  Empty, error, and timeout outcomes are summarized as reasons, and the final
  error explicitly states that no unconfigured providers were used.
- A selected provider whose engine is `native` cannot run locally, so
  `search_configured_provider` returns the message telling the model to use
  hosted search for the native provider or a configured local alternative.

Provider-native preference is computed by `WebSearchConfig::native_enabled`
(`runtime/crates/amiro-config-types/src/web_search.rs`). With a configured
registry it returns true only when the registry's default provider has engine
`native`. Without a registry it falls back to `prefer_native || engine == native`.

## 5. Fail-closed behavior (empty, invalid, unknown)

`ConfiguredSearchRegistry::load` returns an error when the file is missing or
unreadable, when it is not valid JSON, when any provider ID is empty or
duplicated, or when providers exist but the default cannot be resolved. The tool
propagates that error (`map_err(anyhow::Error::msg)`) instead of running a
fallback.

- Unknown provider requested: `configured_provider_order` errors with
  "Requested search provider is not configured" before any network call.
- Empty registry: `execute_configured` errors with "No search providers are
  configured. Configure one in Amiro settings." It does not escape to free
  search.
- Invalid registry on load: `execute` and `parameters_schema` both fail closed.

## 6. Private registry is not browser-readable

The private registry is a server-side artifact. The workspace file API is
admin-gated, allowlisted, and realpath-contained (`backend/src/agent.rs`,
`resolve_contained_workspace_path` and `is_allowed_workspace_rel`). Under the
`runtime` root only `prompt-overlay.md`, `config.toml`, and the `memory` / `skills`
subtrees are readable. `search-providers-runtime.json` is not allowlisted, so a
browser request returns HTTP 403. `config.toml` is readable but its
credential-bearing assignments are masked by `redact_config_secrets` before the
bytes leave the process.

## 7. Verification commands

Neither script is self-contained; each has a prerequisite.

- Runtime routing: `node scripts/verify-search-runtime.mjs`.
  Requires an already-compiled runtime binary, `runtime/target/debug/amiro-runtime`
  by default or `AMIRO_RUNTIME_BIN` when set. It writes its fixture home, config,
  and registry under a temp or scratch directory, so it does not touch a real
  Amiro home. It spawns that binary against a local fixture HTTP server, then over
  the debug socket:
  - `tools:full` shows `websearch.input_schema.properties.provider.enum` equal to
    the configured IDs, with no `engine` property and no endpoint string leaked.
  - A search issues the default provider first, then the configured alternative
    after a 503.
  - An unconfigured provider is rejected with `not configured` and no new network
    request.
  - Editing the registry changes the exposed enum without a runtime restart.
  - An empty registry fails with `No search providers` and no free-engine escape.

- Admin API plus UI: `node scripts/verify-search-ui.mjs`.
  Requires a live server (`AMIRO_TEST_URL`, default `http://127.0.0.1:3000`) and an
  Amiro home (`AMIRO_TEST_HOME`, default `~/.amiro`) that already contains the
  `admin@local` administrator user and at least one active session for it. The
  harness looks up that specific user by email and then finds a session whose
  `userId` matches; it does not accept an arbitrary admin account.
  It mutates live state: it switches the active default to Bing and then back, and
  it restores the originally active provider in a `finally` block by
  re-activating it (and closes the browser) even when a check fails. Run it only
  against a home you are willing to have that default temporarily changed and then
  restored. Checks: three preconfigured providers, Provider Native as default,
  Vellum absent from the catalog, HTTP 403 for the private registry, switching the
  default to Bing and back through the browser, and a mobile layout with no
  overflow and no page errors.

- Component-level: `src/components/search-provider-ui.test.tsx` covers the admin
  page and editor rendering with mocked data.
- Rust unit tests: `configured_registry_controls_native_preference_and_fails_closed`
  (`runtime/crates/amiro-config-types/src/web_search.rs`) and the
  `backend/src/routes/search_providers.rs` test module (seeding, export,
  activation, concurrency, permissions, 403/auth).

## 8. Deployment shape

Production serves the API and the static UI from one process and one listener: the
compiled Rust backend (`backend/src/main.rs`). It is not a standalone static
server.

- `next.config.ts` sets `output: "export"` for non-dev builds, producing `out/`.
- `backend/src/state.rs` (`out_dir`) resolves the UI directory from `AMIRO_OUT_DIR`,
  else a packaged `ui/` directory next to the executable, else `../out` relative to
  the backend crate.
- `backend/src/main.rs` mounts the API routes, then falls back to serving that
  directory for non-API GET/HEAD requests (`ServeDir` with an `index.html`
  fallback and a `.html` / `index.html` route resolver).
- Listener: `AMIRO_HOST` (default `127.0.0.1`) and `AMIRO_PORT` (default `8787`).
  Binding a non-loopback host without `AMIRO_TOKEN` logs a warning.

Both defaults are overridable, and the live deployment sets them explicitly. A
typical production launch of the compiled binary (`amiro-backend`, from
`backend/Cargo.toml`) at port 3000 is:

    AMIRO_PORT=3000 AMIRO_HOST=127.0.0.1 AMIRO_OUT_DIR="$PWD/out" \
      AMIRO_RUNTIME_HOME="$HOME/.amiro/runtime" \
      /path/to/amiro-backend

`AMIRO_PORT=3000` is a supported deployment override, not a `serve-out.mjs`-only
value. The Rust backend can and does serve the API plus static UI on 3000 when
configured that way.

`serve-out.mjs` is not the production deployment. It is a minimal static-only
server for exercising the exported bundle in a browser; it serves `out/` and
defaults to port `3000` (`Number(process.argv[2] || 3000)`). It exposes no API.
`verify-search-ui.mjs` defaults its base URL to `http://127.0.0.1:3000`, which
matches both that static server and a deployment that overrides `AMIRO_PORT=3000`.

## 9. Exact limitations

- Hosted-failure recovery is not exercised. `verify-search-runtime.mjs` drives
  the built-in local tool with configured local providers. It does not make a
  real first-party model request, so the path where hosted search is attached,
  fails, and the model then calls the kept local tool is not covered by these
  scripts.
- The scripts write a fixture registry and a fixture `config.toml`; they do not
  exercise the admin write path end to end. That path is covered by the Rust
  route tests and the browser UI script instead.
- Do not read search tests as normal chat tests. `verify-search-runtime.mjs`
  drives a headless debug session with `tools:full` and `tool:websearch`, and
  `verify-search-ui.mjs` drives the admin API and `/admin/search` page. Neither
  exercises the ordinary chat turn loop. Native/hosted search only ever replaces
  the built-in local tool, and only when the session's tool policy offers
  `websearch`, so a search-only result says nothing about chat tool exposure.
- Registry reload is per tool call (`ConfiguredSearchRegistry::load` runs inside
  `parameters_schema` and `execute`), which is why script-driven registry edits
  take effect without a restart.

## Source map

| Concern | Source |
| --- | --- |
| Registry config type, native gate, load validation | `runtime/crates/amiro-config-types/src/web_search.rs` |
| Local tool schema, routing, fallback, fail-closed | `runtime/crates/amiro-app-core/src/tool/websearch.rs` |
| Admin seed/export/sync, catalog, routes | `backend/src/routes/search_providers.rs` |
| Tool-exposure replacement policy | `runtime/crates/amiro-message-types/src/provider_native.rs`, `runtime/crates/amiro-provider-anthropic-runtime/src/native_web_search.rs`, `runtime/crates/amiro-provider-openai-runtime/src/native_web_search.rs` |
| Workspace file allowlist / 403 / redaction | `backend/src/agent.rs` |
| Runtime home resolution | `backend/src/state.rs` |
| Default config comments | `runtime/crates/amiro-base/src/config/default_file.rs` |
| Static export, production static serving, listener | `next.config.ts`, `backend/src/state.rs`, `backend/src/main.rs`, `serve-out.mjs` |
| Verification scripts | `scripts/verify-search-runtime.mjs`, `scripts/verify-search-ui.mjs` |
