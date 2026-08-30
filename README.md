# Amiro Desktop

A native desktop AI chat app. It pairs a [Tauri](https://tauri.app) (Rust) shell with a statically-exported [Next.js](https://nextjs.org) frontend and a small self-contained **Go backend** that runs as a sidecar process — no external database or server to stand up, everything (chat history, threads, settings) lives in a local SQLite file, and LLM provider keys are stored in your OS's native credential store, never in a config file.

This is a from-scratch rewrite of the [better-chatbot](https://github.com/cgoinglove/better-chatbot) web app's server, rebranded as Amiro: same feature set, but packaged as a single-binary desktop app instead of a Node server + Postgres deployment.

## Features

- Multi-provider chat: OpenAI, Anthropic, Google, xAI, Groq, OpenRouter, Ollama, plus custom/self-hosted OpenAI-compatible endpoints
- Real network token streaming
- [MCP](https://modelcontextprotocol.io) tool & server integration, including full OAuth support for remote MCP servers (RFC 9728/8414/7591/7636)
- Workflows, callable as tools from chat
- Agent Skills: `SKILL.md` folders discovered from `.agents`/`.amiro`/`.claude`/`.codex`, invoked with `/` in any composer, authored (create/edit/delete/duplicate, Generate with AI) from the Skills page
- Multimodal attachments (images/files) reach the model
- Admin user-management panel (list/search/role/ban/delete)
- Provider API keys stored in the OS-native credential store (Keychain on macOS, Credential Manager on Windows, Secret Service/KWallet on Linux) — set them from in-app Settings, not a `.env` file
- Local SQLite database, no external DB required
- i18n: English, Spanish, French, Japanese, Korean, Norwegian, Chinese

## Architecture

```
┌─────────────────────────────────────────────┐
│ Tauri shell (Rust)                           │
│  - spawns the Go sidecar on app launch       │
│  - generates a per-launch shared-secret token│
│  - opens a webview window                    │
└───────────────┬───────────────┬─────────────┘
                │ spawns         │ injects window.__BACKEND_PORT__ /
                │                │ __BACKEND_TOKEN__ before first paint
                ▼                ▼
┌───────────────────────────┐   ┌───────────────────────────────────┐
│ backend-go sidecar         │   │ Next.js frontend (static export)   │
│  - binds a random loopback │◄──┤  - out/ loaded into the webview    │
│    port, prints it on      │   │  - talks to the sidecar over       │
│    stdout                  │   │    http://127.0.0.1:<port>,        │
│  - SQLite under the OS     │   │    authenticated with the shared   │
│    app-data dir            │   │    secret                          │
│  - provider keys via OS    │   └───────────────────────────────────┘
│    keychain                │
└───────────────────────────┘
```

Because the frontend is a static export, `pnpm dev`/`pnpm build` run outside the real Tauri shell need a manually-started backend and a `.env.local` telling the frontend where to find it — see [Frontend-only dev](#alternative-frontend-only-dev-no-tauri-shell) below.

## Prerequisites

Install these on every OS before continuing:

| Tool | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org) | ≥ 20.9.0 | Next.js 16's own floor |
| [pnpm](https://pnpm.io) | 10.x | repo pins `pnpm@10.2.1`; `corepack enable && corepack prepare pnpm@10.2.1 --activate`, or `npm i -g pnpm` |
| [Go](https://go.dev/dl/) | ≥ 1.26.5 | `backend-go/go.mod` pins this toolchain; `go build` will auto-fetch it if your installed Go is older and `GOTOOLCHAIN` allows network access |
| [Rust + Cargo](https://rustup.rs) | ≥ 1.77.2 | via `rustup` |
| [Tauri CLI](https://v2.tauri.app/reference/cli/) | 2.x | **not** an npm package here — install with `cargo install tauri-cli --version "^2" --locked`, then invoke as `cargo tauri ...` |

### Linux (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Fedora: `sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel`
Arch: `sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg`

Provider API keys are written to the Secret Service D-Bus API (via `go-keyring`), so a keyring daemon (GNOME Keyring, KWallet) needs to be running — normal desktop sessions already have one. On a headless/minimal Linux box you'll need to start one yourself (e.g. `gnome-keyring-daemon --start`) before saving keys works.

### macOS

```bash
xcode-select --install
```

### Windows

- Install "Desktop development with C++" via the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) installer.
- The [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) is required — it's preinstalled on Windows 11 and most updated Windows 10 machines; install it manually otherwise.
- Run the commands below from PowerShell (or Git Bash for the `.sh` scripts, which need a POSIX shell).

## Getting started

```bash
git clone <this-repo-url>
cd desktop
pnpm install
```

## Run it (development)

From `desktop/`:

```bash
cargo tauri dev
```

This one command does everything: it runs `tauri.conf.json`'s `beforeDevCommand`, which builds the Go sidecar for your host target (`src-tauri/build-sidecar.sh`, dropped into `src-tauri/binaries/`) and starts `pnpm dev -p 3210`, then opens the Tauri window against that dev server. The first run also pulls Cargo dependencies, so it can take a few minutes; subsequent runs are fast.

Once the window is open, add your LLM provider keys from **Settings → Providers** inside the app — they're written straight to your OS keychain.

### Alternative: frontend-only dev (no Tauri shell)

Useful for pure UI work, since it skips the Rust build entirely. Two terminals, both from `desktop/`:

**Terminal 1** — start the Go backend standalone:

```bash
./scripts/dev-backend.sh
```

**Terminal 2** — start the Next.js dev server:

```bash
pnpm dev -p 3210
```

For the frontend to find that backend, create `desktop/.env.local` (gitignored, not shipped in the repo) with:

```bash
NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8787
NEXT_PUBLIC_BACKEND_TOKEN=dev-test-token-1786373638
```

These values must match `scripts/dev-backend.sh`'s `BETTERCHATBOT_PORT`/`BETTERCHATBOT_AUTH_TOKEN`. This path is dev/test-only — the real packaged app never uses `.env.local`; it gets its port and token injected by the Rust shell at launch instead.

## Serving the dashboard in a browser (`amiro serve`)

The desktop app is not the only way to reach Amiro. `amiro serve` compiles
the exported Next.js dashboard into the Go binary and serves it on the same
listener as the API — one executable, no Node runtime, reachable from a
browser on this machine or, if you ask for it, from another device on your
network.

Build a binary with the dashboard inside it:

```bash
pnpm build && ./scripts/build-ui.sh     # export the frontend, stage it for go:embed
cd backend-go
go build -tags embedui -o bin/amiro ./cmd/amiro
```

`go build` without `-tags embedui` still works and produces a binary that
serves the API and reports that it carries no dashboard — a Go contributor
never has to run a frontend build. `amiro version` tells you which you have:

```
amiro dev
dashboard c13fe09381ec        # or "dashboard (not embedded ...)"
```

Then:

```bash
amiro serve                                  # http://127.0.0.1:<free port>
amiro serve --port 8080 --open               # pinned port, opens a browser
amiro serve --host 0.0.0.0 --port 8080       # reachable from your network
amiro serve --ui-dir ../out                  # serve an export from disk, no Go rebuild
amiro serve --no-ui                          # API only, shared secret required
amiro --serve --port 8080                    # the TUI *and* the dashboard, one backend
```

`amiro --serve` is the combined mode: the terminal UI and a browser-reachable
dashboard over a single embedded backend and a single database, so a thread
started in one shows up in the other. Its URL sits in the TUI status bar.

### About `--host 0.0.0.0`

This makes Amiro reachable by every host on your network, and Amiro runs
shell commands and reads files on behalf of whoever signs in. It is a
deliberate opt-in, never a default, and it prints a warning saying so.

What protects it:

- **Accounts.** Everyone reaching the port gets the sign-in page; every API
  route that matters is behind a session.
- **CSRF.** Cross-site requests are refused outright, using the browser-set
  `Sec-Fetch-Site` header (which a page cannot forge) rather than a token a
  served page would have to be handed. See
  `internal/middleware.RequireTokenOrBrowser`.
- **Rate limiting** on `/api/auth/login` and `/api/auth/register`, installed
  only for a non-loopback bind.
- **No blanket CORS.** The any-`localhost:<port>` allowance the desktop
  sidecar uses is switched off; `--allow-origin` adds exact origins if you
  genuinely need cross-origin access.

Only do this on a network you trust.

## Building a production installer

```bash
cargo tauri build
```

This runs `beforeBuildCommand` (sidecar build + `pnpm build`, a static export into `out/`), then packages platform installers under `src-tauri/target/release/bundle/`:

- **Linux**: `.deb`, `.rpm`, `.AppImage`
- **macOS**: `.app`, `.dmg`
- **Windows**: `.msi`, `.exe` (NSIS)

Tauri does not cross-compile installers — build each platform's installer on that platform (or on a CI runner for that OS).

## Configuration reference

- **`desktop/.env`** (gitignored, create it yourself if needed) — read directly by `scripts/dev-backend.sh` and the Go backend:
  - `OPENAI_COMPATIBLE_DATA` — JSON array wiring up custom/self-hosted OpenAI-compatible model endpoints, e.g. `[{"provider":"MyServer","apiKey":"...","baseUrl":"https://...","models":[{"apiName":"...","uiName":"...","supportsTools":true}]}]`
  - `OLLAMA_BASE_URL` — defaults to `http://localhost:11434/api`
  - `EXA_API_KEY` — enables the `@web` search tool
- **`desktop/.env.local`** (gitignored) — only consumed by `pnpm dev`/`pnpm build` run standalone; see [Frontend-only dev](#alternative-frontend-only-dev-no-tauri-shell) above. The packaged app ignores it.
- **OpenAI / Anthropic / Google / xAI / Groq / OpenRouter keys** — entered in-app under Settings and stored in the OS keychain (`backend-go/internal/secrets/keyring_store.go`), not in any env file. `.env.example`'s "LLM Provider API Keys" section is inherited from the original server-deployed `better-chatbot`; it does not reflect how the shipped desktop app sources those particular keys at runtime.

## Testing

Frontend, from `desktop/`:

```bash
pnpm test          # vitest unit tests
pnpm check-types    # tsc --noEmit
pnpm lint           # biome
pnpm check          # the full local gate: lint:fix + check-types + test
```

Backend, from `desktop/backend-go`:

```bash
go build ./...
go vet ./...
go test ./...
```

> `pnpm test:e2e` (Playwright) is wired up in `package.json`, but this repo doesn't yet include a `playwright.config.*`, so it isn't runnable as-is.

## Project layout

```
desktop/
├── src/                    # Next.js app, statically exported into the Tauri webview
├── src-tauri/               # Rust shell: sidecar lifecycle, window creation, bundler config
│   ├── src/lib.rs           # spawns/kills the Go sidecar, injects port+token into the webview
│   ├── build-sidecar.sh     # cross-compiles backend-go into src-tauri/binaries/
│   └── tauri.conf.json
├── backend-go/               # Go sidecar: HTTP API, SQLite storage, provider calls (vendors
│   │                         # the Bifrost core engine), OS-keychain secrets
│   ├── cmd/server            # entrypoint
│   ├── internal/             # api/, ai/, auth/, config/, db/, mcp/, secrets/, storage/, ...
│   └── tests/                # e2e, migration, repository test suites
├── scripts/dev-backend.sh    # standalone backend runner for frontend-only dev
├── messages/                 # next-intl translation files
└── docs/
```

## Troubleshooting

- **`backend sidecar binary not found next to the app executable`** — `build-sidecar.sh` didn't run or failed; make sure `rustc` and `go` are both on `PATH`, then re-run `cargo tauri dev`.
- **Linux: window fails to open / GTK-related errors** — missing `libwebkit2gtk-4.1-dev` or related packages; see [Prerequisites](#linux-debianubuntu).
- **Linux headless/CI: saving a provider key fails** — no Secret Service/D-Bus session running; start `gnome-keyring-daemon` (or run inside a full desktop session).
- **Windows: blank window on launch** — install the WebView2 Runtime.
- **401s from the app itself (not from a provider)** — only relevant in the [frontend-only dev flow](#alternative-frontend-only-dev-no-tauri-shell): `NEXT_PUBLIC_BACKEND_TOKEN` in `.env.local` doesn't match the token the backend was actually started with.

## License

`package.json` declares this project MIT-licensed. **No `LICENSE` file is committed yet** — add one with the appropriate copyright holder before treating this repo as open source.
