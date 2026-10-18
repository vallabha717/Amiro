# Credential Vault

Amiro's encrypted credential store: AES-256-GCM secrets at rest under
`$AMIRO_HOME/protected/`, a metadata-only catalog that reaches the agent prompt,
environment-variable injection into runtime processes, and a domain-scoped
server-side HTTP broker. Through the metadata catalog and brokered HTTP path,
agents can authenticate upstream calls without raw secret values entering the
system prompt or brokered response bodies (while runtime `$AMIRO_CRED_*`
environment injection makes secrets available to local child processes such as
`bash` and `mcp.json` header expansion).

- Rust implementation: `backend/src/credentials.rs`
- Rust routes: `backend/src/routes/credentials.rs`
- Agent runtime wiring: `backend/src/agent.rs`, `backend/src/runtime.rs`
- Node adapter mirror: `adapter/src/credentials.mjs`,
  `adapter/src/routes/credentials.mjs`
- Frontend client: `src/lib/backend/credentials-api.ts`
- Admin UI: `src/app/(chat)/(admin)/admin/credentials/page.tsx`

## Encryption at Rest (`$AMIRO_HOME/protected/`)

```
$AMIRO_HOME/
└── protected/                # mode 0700, tightened on every open
    ├── store.key             # 32 random bytes, mode 0600, never overwritten
    └── credentials.enc       # JSON: { "credential/<service>/<field>": {...} }
```

### Master key — `store.key`

- 32 bytes from the OS CSPRNG (`rand::rngs::OsRng`), generated on first use.
- Created atomically with `create_new(true)` and mode `0600`; if two processes
  race, the loser re-reads the winner's key (`AlreadyExists` branch), so the key
  is **never** regenerated or overwritten (`load_or_create_key`).
- `load_existing_key` reads the key **without creating it**, which is what
  read-only callers (the runtime environment, prompt builder) use so a turn with
  no stored credentials has no side effects.
- Held in a `MasterKey(Zeroizing<[u8; 32]>)`, scrubbed on drop.

### Store — `credentials.enc`

Each entry is keyed `credential/<service>/<field>` and holds:

```json
{
  "nonce": "<base64, 12 random bytes per write>",
  "ciphertext": "<base64, AES-256-GCM body + tag>",
  "label": "GitHub Personal Access Token",
  "createdAt": "2026-…",
  "updatedAt": "2026-…",
  "usageDescription": "…",      // optional policy
  "allowedTools": ["bash"],      // optional policy
  "allowedDomains": ["api.github.com", "*.github.com"]  // optional policy
}
```

- **AES-256-GCM** with a **fresh random 12-byte nonce per write**.
- **`<service>/<field>` is the AEAD associated data (AAD)**, so a ciphertext
  copied to a different slot (or a tampered one) fails to open. Tests
  `wrong_aad_is_rejected` and `tampered_ciphertext_is_rejected` pin this.
- Writes are atomic (temp file + rename via `write_json`) and serialized with the
  shared `AppState::store` mutex, so concurrent awaits cannot lose a credential.
- The adapter mirrors the exact envelope: `aes-256-gcm` with the auth tag
  appended to the ciphertext, base64 nonce and body, same AAD, same
  `credential/<service>/<field>` keys — so the Rust backend and Node adapter
  share one on-disk store.

### Zeroizing memory & masked hints

- `Secret(Zeroizing<String>)` wraps plaintext, implements `Drop` to `zeroize()`,
  and has a `Debug` impl that prints only `Secret(<redacted>)`. The persisted
  `StoredCredential` also redacts `nonce`/`ciphertext` in `Debug`.
- `masked_hint` returns `••••` for values ≤ 4 chars, otherwise `••••` plus the
  last four characters (`••••1234`). Hints are what routes and the prompt expose;
  plaintext is only ever produced for server-side use.
- `value.len() > 8192` (`MAX_VALUE_LEN`) and service/field names outside
  `[a-z0-9._-]{1,64}` are rejected; labels cap at 256 bytes.

### Legacy plaintext migration & scrubbing

Two legacy plaintext files are migrated automatically and removed:

- **`store/github.json`** (`backend/src/routes/github.rs`) — `migrate_legacy`
  runs on every `GET /api/github/status`, moves any plaintext `token` into the
  encrypted store under `github/token`, and rewrites the file with
  `token: null` plus a masked `tokenHint` (idempotent, safe to call repeatedly).
- **`store/composio.json`** (`backend/src/composio_config.rs`) — `migrate_legacy`
  runs inside `resolve()`, moves `apiKey`/`api_key` into `composio/api_key`,
  then **overwrites the file with zeros before unlinking it**
  (`secure_remove`), so the plaintext is not left in slack space.

Both migrations call `composio_config::refresh_runtime_key`, which restarts the
backend-supervised runtime bridge so a fresh child process inherits the
migrated environment.

## How Agents Use Credentials Safely (Four Security Invariants)

### 1. Metadata-only prompt catalog

`build_credential_prompt_block` (Rust, `backend/src/agent.rs`) and
`buildPromptBlock` (Node, `adapter/src/credentials.mjs`) produce a
`## Stored Credentials (Vault)` block for the per-user `prompt-overlay.md`. The
adapter injects it via `credentialCatalogBlock` in
`adapter/src/agent-context.mjs` (bounded to 4000 bytes).

Each line exposes only non-secret policy metadata:

```
- <service>/<field> ($AMIRO_CRED_<SERVICE>_<FIELD>): <label> — <usageDescription> [allowed domains: …]
```

It includes the slot, the exported env var
(`env_var_name` → `AMIRO_CRED_<SERVICE>_<FIELD>`), the optional label and
`usageDescription`, and `allowedDomains` — **never the plaintext**. The catalog
is built with `list_metadata_sync` / `listMetadataReadOnly`, which read the
existing key without creating one, so the block is empty when nothing is stored.

The block's own instruction: *"Never echo or print raw secret values in chat
output; reference them by their environment variable name … or via brokered
tools."*

### 2. Runtime environment & MCP header injection

`runtime_env_vars_sync` (Rust) / `listMetadataReadOnly` aliases decrypt every
stored credential for injection into the child runtime process
(`backend/src/runtime.rs`, `runtime_env`). For each slot it emits
`(AMIRO_CRED_<SERVICE>_<FIELD>, plaintext)`, plus well-known aliases:

- `github/token` also exports `GITHUB_TOKEN` and `GH_TOKEN` when those names are
  not already present in the child env.
- `composio/api_key` also exports `COMPOSIO_API_KEY`, which the runtime expands
  in `mcp.json` headers (the Composio sync writes
  `${COMPOSIO_API_KEY}` as a placeholder, never the key).

Consequences the model can rely on, without a value in any prompt:

- **`bash`**: reference `${AMIRO_CRED_...}` in commands.
- **`mcp.json`**: reference `${AMIRO_CRED_...}` in MCP server headers.
- **Custom search `header_env`**: `header_env = { Authorization =
  "SEARCH_AUTH" }` names an env var the runtime fills from the child
  environment (`runtime/crates/amiro-app-core/src/tool/websearch.rs`), so the
  search config file never carries the secret.

Injection is read-only and key-safe: it never mints a master key, so a
process that has never stored a credential sees an empty catalog.

### 3. Domain-scoped credential broker

`POST /api/credentials/broker` (admin-only) executes an upstream HTTP request
**server side** so the model never holds the secret:

1. Resolves the credential's metadata and enforces `allowedDomains`. Matching
   supports exact hosts and `*.domain` wildcards
   (`host_matches_domain` / `hostMatchesDomain`): `*.example.com` matches
   `example.com` and any subdomain, is case-insensitive, and does not match
   look-alikes such as `github.com.evil.test`. An empty list means unrestricted.
   A blocked host is a `403`.
2. Injects the secret into a header — `headerName` (default `Authorization`)
   prefixed by `valuePrefix` (default `"Bearer "`), e.g.
   `Authorization: Bearer <secret>`. Caller-supplied `headers` are applied
   first; a JSON `body` sets `content-type: application/json` unless one was
   given.
3. Returns `{ok, status, body}` where the body (and any header reflected into an
   error) is passed through `scrub_secret`, which replaces every occurrence of
   the secret with `[REDACTED]`.

The broker requires an absolute `http(s)` URL and returns `404` when the
credential is not configured, `400` for a bad URL/method/body, and `502` when
the upstream is unreachable.

### 4. No plaintext on any route, and redaction everywhere

- `GET /api/credentials` and `PUT /api/credentials` return
  `CredentialMetadata` (`id`, `service`, `field`, `label`, `hint`, `updatedAt`,
  `envVar`, `usageDescription`, `allowedTools`, `allowedDomains`) — never a
  value. Reads are open to any authenticated user; writes, delete, validate, and
  broker are **admin-only**.
- `POST /api/credentials/validate` checks a stored credential against
  `composio` (`GET {base}/api/v3/toolkits`) or `github` (requires
  `AMIRO_GITHUB_BASE_URL`, `GET {base}/user`) and returns `{valid: boolean}`
  only.
- Equality/dedupe is done on the ciphertext-safe metadata; every error path
  replaces a reflected secret with `[REDACTED]`, and the TTS/STT upstream errors
  in the voice routes do the same.

## Admin UI (`/admin/credentials`) & Tests

`src/app/(chat)/(admin)/admin/credentials/page.tsx` renders the vault:

- **Quick presets**: GitHub, OpenAI, 9Router, Composio, Slack, and Custom. A
  preset fills `service`, `field`, `label`, `usageDescription`, and
  `allowedDomains`.
- **Search**: filters the list client-side (`credentials-search-input`), with an
  "N of M" counter and an empty/no-match state.
- **Add dialog**: service/field/secret (with show/hide), an "Optional details"
  disclosure for label, agent guidance (`usageDescription`), and comma-separated
  allowed domains, plus a live preview of the resulting
  `$AMIRO_CRED_<SERVICE>_<FIELD>` variable.
- **Rows**: show the masked hint, label, domains, and copy chips that put the
  `$AMIRO_CRED_*` reference on the clipboard (`handleCopyEnv`).
- **Delete confirmation**: an alert dialog warning that "Agents will lose access
  immediately" before calling `deleteCredential`.

The client (`src/lib/backend/credentials-api.ts`) mirrors the API
(`listCredentials`, `saveCredential`, `deleteCredential`, `validateCredential`),
caches metadata in `localStorage` (`amiro.credentials.cache`) for offline
rendering, and derives the env var name client-side with
`toCredentialEnvVar`.

### Test commands

```bash
# Unit tests for the encryption core, policy, env export, and aliases.
cargo test --manifest-path backend/Cargo.toml --lib credentials

# Route/HTTP tests: admin gating, no-value guarantees, broker behavior.
cargo test --manifest-path backend/Cargo.toml --test credentials

# Node adapter mirror: real handlers, local HTTP upstream for the broker.
node --test adapter/test/credentials.test.mjs

# Frontend client.
npx vitest run src/lib/backend/credentials-api.test.ts
```

Coverage highlights: `roundtrip_and_metadata`, `wrong_aad_is_rejected`,
`tampered_ciphertext_is_rejected`, `files_are_private_and_key_is_stable`
(directory `0700`, key/store `0600`), `plaintext_never_hits_the_disk`,
`policy_metadata_roundtrips`, and
`runtime_env_vars_include_aliases_and_never_create_a_key` in
`backend/src/credentials.rs`; `domain_patterns_are_enforced`,
`allow_list_gates_hosts`, and `secrets_are_scrubbed_from_bodies` in
`backend/src/routes/credentials.rs`.

## Current Limitations & Scope

- **Local owner-only master key**: `protected/store.key` is a local 32-byte random key protected by OS file permissions (`0600` inside `0700` `protected/`) rather than an external cloud KMS or OS keychain prompt.
- **Runtime environment vs. brokered isolation**: `POST /api/credentials/broker` enforces `allowedDomains` (an empty `allowedDomains` list is unrestricted) and scrubs exact secret matches (`[REDACTED]`) from upstream HTTP responses before returning them. By contrast, credentials exported into the child runtime environment (`$AMIRO_CRED_<SERVICE>_<FIELD>`) are readable by local owner tools/processes (such as `bash`), and exact-string scrubbing does not redact transformed/encoded copies of a secret printed by a shell command.
- **HTTP/REST broker scope**: `POST /api/credentials/broker` proxies HTTP/HTTPS requests (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`) with header injection and `[REDACTED]` response scrubbing; non-HTTP binary protocols rely on runtime `$AMIRO_CRED_<SERVICE>_<FIELD>` environment injection instead.
- **Built-in validation endpoints**: `POST /api/credentials/validate` currently performs live upstream verification for `composio` and `github`; other services store and broker credentials normally without a dedicated validation probe.

## Related documentation

- `docs/VOICE-AND-SPEECH.md` — how voice providers store their keys in this
  vault (`tts.<provider>/api_key`, `stt.<provider>/api_key`).
- `docs/SECURITY-MODEL.md`, `docs/COMPOSIO.md` — broader security posture and
  the Composio key resolution precedence (`store > env > TOML`).
