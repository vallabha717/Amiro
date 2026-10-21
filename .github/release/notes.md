**Amiro** is your own AI agent: it runs on your computer or your server, remembers you, talks with voice, connects to your apps and works on a schedule.

## Install

**Server / VM** (Linux, macOS — x86_64 and arm64):

```bash
curl -fsSL https://github.com/__REPO__/releases/download/__TAG__/install.sh | bash
```

Reach it from other machines and keep it running across reboots: `… | bash -s -- --public --service`. Then open the address it prints; a setup wizard creates your account.

## Which file do I need?

| File | For | How |
|---|---|---|
| `amiro-server-linux-x86_64.tar.gz`, `amiro-server-linux-aarch64.tar.gz`, `amiro-server-macos-aarch64.tar.gz`, `amiro-server-macos-x86_64.tar.gz` | Server builds | No need to download by hand: `install.sh` picks and verifies the right one. |
| `install.sh` | The one-command server installer | See above. |
| `SHA256SUMS` | Checksums for every file | `sha256sum -c SHA256SUMS --ignore-missing` |

Every file also has a GitHub build-provenance attestation: `gh attestation verify <file> -R __REPO__`.

Already installed? `amiro update`. Docs: [setup guide](https://github.com/__REPO__/blob/__TAG__/docs/SETUP.md).
