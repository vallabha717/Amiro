# Setting up Amiro

Amiro sets itself up the first time you open it. You can click through the
onboarding wizard, describe the whole setup in a config file, or mix the two.
The same flow works in a browser, in the desktop app, and on a remote VM.

## The onboarding wizard

On a fresh install, opening Amiro shows the wizard (`/onboarding`):

| Step | What it does | Can you skip it? |
| --- | --- | --- |
| Welcome | Says where Amiro is running (this computer or your server). | — |
| You | Your name, a login (email or username), a password, and your timezone (detected from the browser). This creates the single owner account. | No. This is the only required step. |
| Your agent | Name, look (Headphones, Sprout, Starfish, Dreamer) and colour. The mascot on the right updates as you choose. | Yes. Later in **Agent → Customize**. |
| Brain | Connect an AI provider: paste an Anthropic, OpenAI, OpenRouter or Gemini key, or open "Subscriptions, local models and more providers" for OAuth sign-ins and local endpoints. | Yes. Later in **Admin → Providers**. |
| Ready | A checklist of what's done. Each skipped step says where to finish it, with a "Do it now" link. | — |

Skipped steps also show up as a **Finish setting up** card at the bottom of
the sidebar. The card disappears once the step is done, or when you dismiss it.
To run the wizard again, go to **Admin → General → Setup → Run setup again**.

Who sees the wizard:

- A fresh install: everyone opening it, until the owner account exists.
- The owner, after signing in, until they finish the wizard. If the owner was
  created from a config file, the wizard opens at the first unfinished step.
- Not existing installs. At its first start, an install that already has chat
  history is marked as set up.
- Nobody, when `[onboarding] skip = true` or `AMIRO_SKIP_ONBOARDING=1` is set
  (for fully scripted installs).

## Setting up from files

Every setting the wizard asks for can also come from files.

1. **Environment variables**: these always win.
2. **`.env` files**, read in this order, where the first file to set a key wins:
   - `AMIRO_ENV_FILE`
   - `./.env` (the directory Amiro starts in)
   - `~/.amiro/.env`
3. **`amiro.toml`**: `--config <path>` or `AMIRO_CONFIG`, otherwise
   `./amiro.toml`, otherwise `~/.amiro/amiro.toml`.

A file never overrides a variable that is already set.

To get a commented starter file:

```bash
amiro-backend init-config
```

This writes `~/.amiro/amiro.toml`. Pass a path to write it somewhere else. The
full reference is [`amiro.example.toml`](../amiro.example.toml), and each
setting in it also names its environment variable. The main ones:

```toml
[server]
host = "0.0.0.0"        # reach it from other machines (use a token!)
port = 3000
token = "long-random"   # injected into the pages Amiro serves

[owner]                 # creates the owner on first start; the password step is skipped
email = "you@example.com"
password_file = "~/.amiro/owner-password"
name = "Ada"
timezone = "Europe/London"

[agent]                 # applied once, while the agent has never been customised
name = "Juno"
avatar = "sprout"       # headphones | sprout | starfish | dreamer
color = "teal"          # green orange pink purple teal yellow indigo cobalt black

[providers]             # imported into the encrypted credential store
anthropic_api_key = "sk-ant-…"
```

How each part behaves:

- **Owner.** Created only while no account exists. Prefer `password_file`
  over `password`, so the secret isn't in the config file itself.
- **Agent.** Applied only while the agent has never been saved, so a change
  made later in the app is never overwritten.
- **Provider keys.** Imported at startup, once per key: Amiro remembers a
  fingerprint of the key, never the key itself. If you change the key in the
  file, it is imported again on the next start. Keys that are only in the
  shell environment of whoever started the server are not imported.
- **Unknown settings.** A typo such as `[owner] emial` is reported at startup
  instead of being silently ignored. `[composio] api_key` is read by the
  Connectors integration. A free-form `[env]` table copies any other variable
  into the environment.

## Where to run it

### Desktop app (macOS, Windows, Linux)

Download the installer for your OS from the
[latest release](https://github.com/vallabha717/Amiro/releases/latest)
(`.dmg` for macOS, `.msi`/`.exe` for Windows, `.deb`/`.rpm`/`.AppImage` for
Linux) and open Amiro: the wizard starts. The app runs its own private server on a random local port with a
fresh secret every launch, and keeps its data in `~/.amiro`
(`%USERPROFILE%\.amiro` on Windows). Sign-ins last 30 days.

To build the installers yourself:

```bash
pnpm install
node scripts/build-sidecar.mjs --build   # backend + runtime for this OS
pnpm desktop:package                     # = npx @tauri-apps/cli@2 build
```

## Releases (CI/CD)

`.github/workflows/release.yml` builds one release containing:

| Asset | For |
| --- | --- |
| `amiro-desktop-macos-aarch64.dmg`, `amiro-desktop-macos-x86_64.dmg` | Desktop app on Apple silicon / Intel Macs |
| `amiro-desktop-windows-x86_64-setup.exe` | Desktop app on Windows 10/11 |
| `amiro-desktop-linux-x86_64.AppImage`, `amiro-desktop-linux-x86_64.deb` | Desktop app on Linux (any distro / Debian-Ubuntu) |
| `amiro-server-{linux,macos}-{x86_64,aarch64}.tar.gz` | Server builds; `install.sh` picks the right one |
| `install.sh` | The curl installer |
| `SHA256SUMS` | Checksums for every file (`sha256sum -c SHA256SUMS --ignore-missing`) |

Each release also carries a GitHub build-provenance attestation for every
file (`gh attestation verify <file> -R vallabha717/Amiro`). The release
description comes from `.github/release/notes.md` plus the generated
changelog.

To cut a release, either:

- push a tag: `git tag v1.27.0 && git push origin v1.27.0`; or
- in the Actions tab, run **Release** and enter a version (it creates the tag).

The release stays a draft while it builds, and is published as *latest* once
the server archives and checksums are uploaded. That is when
`releases/latest/download/install.sh` starts serving it. If a single desktop
platform fails, the rest of the release still ships.

The **Desktop app** workflow (`.github/workflows/desktop.yml`) can also run on
its own, from the Actions tab or on PRs that touch `src-tauri/`; its
installers are workflow artifacts. Signing is optional: set the `APPLE_*`
secrets to sign and notarize on macOS.

To build a server archive locally, run
`scripts/package-server.sh v1.2.3 [target] [out-dir]`. To test the installer
against it, run
`AMIRO_INSTALL_ARCHIVE=dist/amiro-server-….tar.gz bash install.sh`.

### On a server or VM: one command

```bash
curl -fsSL https://github.com/vallabha717/Amiro/releases/latest/download/install.sh | bash
```

This works on Linux and macOS, on x86_64 and arm64, and needs no root. The
installer:

- downloads the release for this machine and checks its SHA-256;
- installs it to `~/.amiro/app/<version>` and links the `amiro` command into
  `~/.local/bin`;
- writes `~/.amiro/amiro.toml` with port 3000 and a random token;
- starts the server and prints the address to open.

Useful options go after `bash -s --`:

```bash
# A VM you reach over the network, kept running across reboots:
curl -fsSL https://github.com/vallabha717/Amiro/releases/latest/download/install.sh | bash -s -- --public --service
# A specific version / port, install only:
curl -fsSL https://github.com/vallabha717/Amiro/releases/latest/download/install.sh | bash -s -- --version v1.26.0 --port 8080 --no-start
```

Afterwards, `amiro` manages it:

| Command | What it does |
| --- | --- |
| `amiro start` / `stop` / `restart` / `status` | Run it in the background (`start --foreground` to watch it). |
| `amiro url` | The address to open. |
| `amiro logs [-f]` | The server log. |
| `amiro service install [--system]` | Start at boot (a systemd user service, or launchd on macOS). `--system` installs a system unit with sudo. |
| `amiro config [edit]` | Show `amiro.toml` with secrets hidden, or open it in `$EDITOR`. |
| `amiro reset-password` | Set a new owner password. |
| `amiro update [vX.Y.Z]` | Install the latest (or given) release and restart. |
| `amiro doctor` | Check the install, including OpenSSL 3, which the agent runtime needs on Linux. |
| `amiro uninstall [--purge]` | Remove the app. `--purge` also removes all data. |

On Linux the agent runtime needs OpenSSL 3 (Ubuntu 22.04+, Debian 12+,
Fedora, RHEL 9). `amiro doctor` says how to install it if it's missing.

### On a server or VM: from source

```bash
scripts/setup-vm.sh                  # dependencies + build (Debian/Ubuntu, macOS)
amiro-backend init-config            # then edit ~/.amiro/amiro.toml
scripts/amiro-server.sh start --daemon
scripts/amiro-server.sh install-service   # optional: systemd
```

`amiro-server.sh` reads `[server] host`, `port` and `token` from the same
`amiro.toml`, so the script and the server agree. With `host = "0.0.0.0"`,
always set a token, and put TLS (Caddy or nginx) in front of anything
reachable from the internet. The wizard's last step lists the URLs Amiro can
be reached at. See [VM-SETUP.md](VM-SETUP.md) for the full walkthrough.

To reach a VM's Amiro from your laptop without exposing it, forward the port
(`ssh -L 3000:127.0.0.1:3000 vm`, or the VS Code Ports panel) and open
http://localhost:3000.

## Forgot your password?

Amiro has no email recovery: it runs on your machine. On the machine running
Amiro, run:

```bash
amiro reset-password                         # installed with install.sh
amiro-backend reset-password                 # from a source checkout; asks twice
amiro-backend reset-password --login you@example.com   # also change the login
```

This signs out every session. If no owner exists yet, it creates one. On a
server where `AMIRO_HOME` isn't `~/.amiro`, run the command with the same
`AMIRO_HOME` (or the same `amiro.toml`) as the server.

In the desktop app, the server binary sits next to the app:

| OS | Command |
| --- | --- |
| macOS | `/Applications/Amiro.app/Contents/MacOS/backend reset-password` |
| Windows | `"C:\Program Files\Amiro\backend.exe" reset-password` |
| Linux (deb/rpm) | `/usr/bin/backend reset-password` |

## API

| Route | Purpose |
| --- | --- |
| `GET /api/auth/status` | `{needsSetup, mode}`. Public, so the wizard knows whether to show the account step. |
| `POST /api/auth/setup` | `{email, password, name?, timezone?}` creates the owner. Only works while no account exists. |
| `GET /api/onboarding` | Each step's state, where its settings came from (`amiro.toml` or `.env`), and the deployment URLs. Owner only. |
| `POST /api/onboarding/profile` | `{name?, timezone?}`. Refreshes `USER.md` if it is still as seeded. |
| `POST /api/onboarding/complete` | `{skipped: ["agent" \| "provider"]}`. |
| `POST /api/onboarding/reset` | Show the wizard again. |

Code locations:

- Backend: `backend/src/config.rs` (files), `backend/src/onboarding.rs`
  (state, config import, migration), and the CLI in `backend/src/main.rs`.
- UI: `src/components/onboarding/`.
