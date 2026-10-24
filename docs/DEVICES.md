# Devices: phones and other apps

Amiro runs in one place (the desktop app on your computer, or a server). Other
devices use that Amiro: they do not run the agent themselves. This is the same
split Vellum uses for its iOS and Android apps.

```
Phone / other desktop app  ──HTTP(S)──►  The Amiro that runs the agent
  only the UI                              backend + runtime
```

## Connecting a device (device code flow)

Connecting works like signing in to the GitHub CLI or a TV app (OAuth 2.0
Device Authorization Grant, RFC 8628):

```
Device (phone / desktop app)                Your Amiro
1. enter the address once       ─────────►  POST /api/devices/authorize
                                ◄─────────  device code (secret) + user code WXYZ-1234
2. shows "WXYZ-1234", polls     ─────────►  POST /api/devices/token  (every 5 s)
                                            authorization_pending …
3.            owner approves: <address>/device in any browser (signed in),
              or Settings → Devices → Waiting for approval on that computer
4. next poll                    ◄─────────  its own session token → connected
```

- Only the owner approves. The approval screen shows the device's name,
  platform, the address it asked from and when, with a warning: approve only a
  code on a device you are holding. That is the defence against someone
  sending you their code.
- Codes expire after 10 minutes and are answered once. A device polling faster
  than every 5 seconds is told `slow_down`. One address may start 5 requests
  per 15 minutes, at most 50 wait at once, and 10 wrong codes typed at
  `/device` pause lookups for 15 minutes.
- The server keeps only a hash of the device code. The session token is made
  when the device collects it, so it is never stored in the request.
- `/device` sends a signed-out visitor to sign-in and back (`?next=`).
- The device must use `https://` unless the address is on your own network
  (private IPs, `localhost`, `*.local`, Tailscale `100.64.0.0/10` and
  `*.ts.net`): you sign in on `/device`, so the password must not cross the
  internet unencrypted.

The approved device signs in as the owner, so it can do everything the owner
can. It stays signed in until you remove it under **Paired devices** (or set
`AMIRO_DEVICE_SESSION_TTL_DAYS`). Changing the owner password also signs out
every device.

Settings → Devices shows this Amiro's address and a QR code that opens
`<address>/pair` on a phone, so there is nothing to type on the phone.

## Phone access (desktop app)

The desktop app's backend listens on `127.0.0.1` only. **Allow phones on my
network** opens a second listener on every interface (port 8790,
`AMIRO_REMOTE_PORT`). That listener:

- serves the UI and `GET /api/auth/status` to anyone (no secrets in them),
- accepts the device's two steps, `POST /api/devices/authorize` and
  `POST /api/devices/token` (the device code is the credential),
- answers everything else only for a paired device's session. Password
  sign-in and ordinary sessions are refused, so on Wi-Fi you approve on the
  computer itself and a password never crosses the network there.

Traffic on that listener is plain HTTP. Use it on a network you trust, or reach
the computer through a private network such as Tailscale.

A server install (`AMIRO_HOST=0.0.0.0`) is reachable already, so it has no
phone-access switch. Paired devices skip its `AMIRO_TOKEN` sidecar check; their
session stands in for it.

## Desktop app connected to a server

When the desktop app is approved by another Amiro, it stores that address and the
device session in `localStorage` (`amiro.remote-origin`,
`amiro.remote-session-token`) and sends every request there. It never sends
its own sidecar secret to the other Amiro. Its local sign-in is kept, so
**Switch back to this computer** (Settings → Devices, `/pair`, or the sign-in
page) returns to the local backend without signing in again.

## API

| Route | Who | What |
| --- | --- | --- |
| `POST /api/devices/authorize` | anyone | `{name, platform}` → `{deviceCode, userCode, verificationPath, verificationPathComplete, expiresIn, interval}` |
| `POST /api/devices/token` | the device | `{deviceCode}` → `{token, user, device}`, or 400 `{error}`: `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, `invalid_request` |
| `GET /api/devices?origin=` | owner | paired devices, waiting requests, phone-access status, addresses with QR codes |
| `GET /api/devices/requests/lookup?code=` | owner | the waiting request with that user code |
| `POST /api/devices/requests/{id}/approve` · `/deny` | owner | answer a request |
| `PUT /api/devices/remote-access` | owner | `{enabled, port?}` |
| `DELETE /api/devices/{id}` | owner | remove a device; its session stops working at once |

Code: `backend/src/devices.rs`, the listeners in `backend/src/main.rs`, the UI
in `clients/web/src/components/devices/`, `clients/web/src/app/pair/` (the device), `clients/web/src/app/device/`
(approving) and `clients/web/src/lib/backend/config.ts`.

## Not done yet

- The Tauri mobile app (iOS and Android) itself. The web UI works in a phone
  browser after pairing and can be added to the home screen.
- Push notifications, and HTTPS for the phone-access listener.
