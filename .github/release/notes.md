**Amiro** is your own AI agent: it runs on your computer or your server, remembers you, talks with voice, connects to your apps and works on a schedule.

## Install

**Server / VM** (Linux, macOS — x86_64 and arm64):

```bash
curl -fsSL https://github.com/__REPO__/releases/download/__TAG__/install.sh | bash
```

Reach it from other machines and keep it running across reboots: `… | bash -s -- --public --service`. Then open the address it prints; a setup wizard creates your account.

**Desktop app**: download the file for your system below and open it.

## Which file do I need?

| File | For | How |
|---|---|---|
| `amiro-desktop-macos-aarch64.dmg` | Mac with Apple silicon (M1 or newer) | Open, drag Amiro to Applications. First launch: right-click → Open. |
| `amiro-desktop-macos-x86_64.dmg` | Intel Mac | Same as above. |
| `amiro-desktop-windows-x86_64-setup.exe` | Windows 10 / 11 | Run it. If SmartScreen warns: More info → Run anyway. |
| `amiro-desktop-linux-x86_64.AppImage` | Any Linux desktop (x86_64) | `chmod +x` it and run it. |
| `amiro-desktop-linux-x86_64.deb` | Debian / Ubuntu desktop | `sudo apt install ./amiro-desktop-linux-x86_64.deb` |
| `amiro-server-linux-x86_64.tar.gz`, `amiro-server-linux-aarch64.tar.gz`, `amiro-server-macos-aarch64.tar.gz`, `amiro-server-macos-x86_64.tar.gz` | Server builds | No need to download by hand: `install.sh` picks and verifies the right one. |
| `install.sh` | The one-command server installer | See above. |
| `SHA256SUMS` | Checksums for every file | `sha256sum -c SHA256SUMS --ignore-missing` |

Every file also has a GitHub build-provenance attestation: `gh attestation verify <file> -R __REPO__`.

Already installed? `amiro update` (server) — or download the new desktop installer. Docs: [setup guide](https://github.com/__REPO__/blob/__TAG__/docs/SETUP.md).
