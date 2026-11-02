# Amiro mobile (iOS and Android) — not started

This folder is reserved for the Tauri 2 mobile app. Nothing is built here yet.

What it will be: a small Tauri project that bundles the web UI
(`../web/out/`) and connects to an Amiro running elsewhere (your computer or
server). It does not start a backend on the phone. Connecting uses the device
code flow that already works in a phone browser today: enter the address, get
a code, approve it at `<address>/device` or in Settings → Devices. See
[docs/DEVICES.md](../../docs/DEVICES.md).

Still to do here:

- `tauri.conf.json` and a Rust crate with no sidecars; `tauri android init` and
  `tauri ios init` generate `gen/android` and `gen/apple` (ignored by git until
  we decide to commit them).
- Open `/pair` when no Amiro is connected yet.
- Android: allow plain-HTTP traffic for private network addresses only (Wi-Fi).
- iOS: safe-area insets, App Transport Security exceptions for Wi-Fi addresses.
- Later: push notifications, voice, Face ID / fingerprint.
- Updates: today a phone uses the server's screens, either in the browser or
  added to the Home Screen (Safari: Share → Add to Home Screen; Chrome: Add to
  Home screen). It is always on the server's version: coming back to it after
  the server updated reloads it with the new screens. A built app bundles the
  screens, so it will need its own update path: the app stores, or the
  desktop app's signed `latest.json` feed for sideloaded builds (see
  `settings/updates.mdx`).
