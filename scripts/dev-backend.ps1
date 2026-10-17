# Starts the Amiro Node adapter (adapter/src/server.mjs) for standalone
# frontend dev/testing on Windows. Replaces the old `go run .\cmd\server`
# backend-go flow. See scripts/dev-backend.sh for the full notes.

$env:AMIRO_PORT = "8787"
if (-not $env:AMIRO_HOME) { $env:AMIRO_HOME = "$env:USERPROFILE\.amiro-dev" }
if (-not $env:AMIRO_TOKEN) { $env:AMIRO_TOKEN = "" }
# Amiro runtime socket the adapter talks to. The legacy (pre-rename) variable is
# still honoured; the default is the runtime engine's real on-disk socket path.
$amiroSocket = $env:AMIRO_API_SOCKET
if (-not $amiroSocket) { $amiroSocket = $env:JCODE_API_SOCKET }
if (-not $amiroSocket) { $amiroSocket = "$env:USERPROFILE\.jcode\scratch\amiro-api.sock" }
$env:AMIRO_API_SOCKET = $amiroSocket

$desktopDir = Split-Path -Parent $PSScriptRoot
$adapterEntry = Join-Path $desktopDir "adapter\src\server.mjs"

if (-not (Test-Path $adapterEntry)) {
    Write-Error "adapter not found at $adapterEntry"
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "node not found on PATH -- the adapter is a Node server."
    exit 1
}

if (-not (Test-Path (Join-Path $desktopDir "adapter\node_modules\@1jehuang\jcode-sdk"))) {
    Write-Error "adapter dependencies are not installed. Run: cd adapter; pnpm install"
    exit 1
}

New-Item -ItemType Directory -Force -Path $env:AMIRO_HOME | Out-Null

Set-Location $desktopDir
node $adapterEntry
