# Clients

Every way to use Amiro lives here, one folder per client, the way Vellum keeps
its `clients/`. They all talk to the same backend (`backend/`) over its HTTP API;
none of them runs the agent itself except through that backend.

| Folder | What | Built with |
| --- | --- | --- |
| [`web/`](web/) | The UI: every page, in a browser or inside the apps below. Statically exported to `web/out/`, which the backend serves and the desktop app bundles. | Next.js (static export) |
| [`desktop/`](desktop/) | The desktop app for macOS, Windows and Linux. Starts `amiro-backend` and `amiro-runtime` on this computer as sidecars and shows `web/out/`. | Tauri 2 |
| [`mobile/`](mobile/) | The phone app for iOS and Android. Not started yet. | Tauri 2 mobile |

Why not one folder per platform (`ios/`, `android/`, `macos/`, `windows/`) like
Vellum? Vellum builds its phone apps with Capacitor, which keeps a separate
native project per platform. Tauri builds iOS and Android from one Rust project
(it generates `mobile/gen/apple` and `mobile/gen/android`), and macOS, Windows
and Linux from another, so one folder per Tauri project fits Amiro.

The repo root `package.json` is the one Node package, so commands run from the
repo root: `pnpm dev`, `pnpm build` (→ `clients/web/out/`), `pnpm test`,
`pnpm check-types`, `pnpm desktop:package`.
