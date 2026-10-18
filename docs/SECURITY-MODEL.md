# Security model: owner auth, credential vault, General

Amiro is a single-owner app meant to run in a VM or sandbox. This page lists
the real interfaces, the config that controls them, the tests, and what is
not protected.

## Single-owner auth (`backend/src/auth.rs`)

- There is no sign-up. The first owner is created once, through the `/setup`
  page or headlessly with `AMIRO_OWNER_EMAIL` plus `AMIRO_OWNER_PASSWORD` (or
  `AMIRO_OWNER_PASSWORD_FILE`) while the user store is empty.
- Passwords need at least 12 characters.
- Routes: `GET /api/auth/status`, `POST /api/auth/setup` (403 once an owner
  exists), `POST /api/auth/login`, `GET /api/auth/session`,
  `POST /api/auth/logout`, `PUT /api/auth/credentials` (change email or
  password, invalidates other sessions).
- Removed: `AMIRO_ALLOW_REGISTRATION`, `SEED_ADMIN`, `ALLOW_INSECURE_ADMIN`,
  `AMIRO_TRUSTED_OPERATOR`. Chat tools are on by default.
  `AMIRO_TOOL_PROFILE=none` is the only opt-out.
- Binding to a non-loopback address without `AMIRO_TOKEN` logs a warning.
- Tests: `backend/tests/native_acceptance.rs`, `tests/ui/specs/auth/`,
  `scripts/accept-single-owner.sh`.

## Credential vault (`backend/src/credentials.rs`, `routes/credentials.rs`)

- Storage: `~/.amiro/protected/credentials.enc`, AES-256-GCM, a fresh 12-byte
  nonce per value, associated data `service/field`. The master key is 32 random
  bytes in `protected/store.key` (0600, directory 0700). Writes are atomic.
- Routes: `GET /api/credentials` (metadata and a masked hint, never values),
  `PUT /api/credentials`, `DELETE /api/credentials/{service}/{field}`,
  `POST /api/credentials/validate`, `POST /api/credentials/broker`. Writes,
  validate and broker are owner-only.
- Broker: executes an HTTP request server side, injects the secret into a
  header, enforces the credential's `allowedDomains`, and scrubs the secret
  from the response, so the model never sees the raw value.
- A legacy plaintext Composio key is migrated into the vault and deleted at
  boot.
- Tests: `backend/tests/credentials.rs`, unit tests in `credentials.rs`.

## General page (`/admin/general`, `GET /api/system`)

Shows Timezone, Version and Compute and resources, modelled on Vellum's
General page. `GET /api/system` (session required, `backend/src/routes/system.rs`)
returns `version`, `cpu {percent, cores}`, `memory {totalMb, usedMb}` and
`disk {totalMb, usedMb}` for the `AMIRO_HOME` filesystem. CPU is a 250 ms
sample of `/proc/stat`, memory comes from `/proc/meminfo`, disk from `df -Pk`.
Fields the host cannot report are `null` and the UI shows "Unavailable".
The timezone choice is stored per browser in `localStorage`
(`amiro.timezone`), not on the server. Tests: `backend/tests/system.rs`.

## Limitations

- The vault key sits beside the encrypted file. This protects against casual
  disclosure (backups, screenshots, the UI), not against a process or user
  that can read `~/.amiro/protected/`. It is not process isolation.
- Secrets passed to the runtime as environment variables (for example
  `COMPOSIO_API_KEY`) are visible to that process and its children.
- `GET /api/system` metrics are Linux only and describe the host, not a
  per-user quota. There is no resize control.
- The timezone setting does not change server-side schedule behaviour.
- There is no implemented password recovery. The UI cannot reset a lost
  owner password, and no secure operator recovery or backup procedure is
  documented yet. Treat the owner password as something you must keep.
