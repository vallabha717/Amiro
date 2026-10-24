# Windows counterpart to build-sidecar.sh for the Amiro desktop shell.
#
# Stages the two real Windows executables Tauri's externalBin contract expects:
#   binaries/backend-<target-triple>.exe   the native Rust HTTP backend
#   binaries/runtime-<target-triple>.exe   the owned Amiro runtime
#
# The backend starts the runtime itself on demand
# (`runtime --no-update api-bridge --api-socket ...`), keeps it alive with pings,
# and restarts it if it exits. Both must be present: a bundle with only one of
# them has no engine.
param(
    [string]$TargetTriple = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$OutDir = Join-Path $ScriptDir "binaries"

if (-not $TargetTriple) {
    $hostLine = (& rustc -Vv | Select-String '^host:').ToString()
    $TargetTriple = $hostLine.Split(' ')[1]
}
if (-not $TargetTriple) {
    Write-Error "Could not determine the rust target triple (is rustc on PATH?). Pass one explicitly."
    exit 1
}

function Resolve-Binary([string]$releasePath, [string]$debugPath, [string]$buildHint) {
    if (Test-Path $releasePath) { return $releasePath }
    if (Test-Path $debugPath) { return $debugPath }
    Write-Error "missing binary; build it with: $buildHint"
    exit 1
}

$RuntimeBin = ${env:AMIRO_NATIVE_RUNTIME_BIN}
if (-not $RuntimeBin) {
    $RuntimeBin = Resolve-Binary `
        (Join-Path $RepoRoot "runtime/target/release/amiro-runtime.exe") `
        (Join-Path $RepoRoot "runtime/target/debug/amiro-runtime.exe") `
        "cargo build --manifest-path runtime/Cargo.toml --bin amiro-runtime --release"
}

$BackendBin = ${env:AMIRO_NATIVE_BACKEND_BIN}
if (-not $BackendBin) {
    $BackendBin = Resolve-Binary `
        (Join-Path $RepoRoot "backend/target/release/amiro-backend.exe") `
        (Join-Path $RepoRoot "backend/target/debug/amiro-backend.exe") `
        "cargo build --manifest-path backend/Cargo.toml --bin amiro-backend --release"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$RuntimeOut = Join-Path $OutDir "runtime-$TargetTriple.exe"
$BackendOut = Join-Path $OutDir "backend-$TargetTriple.exe"
Copy-Item -Force $RuntimeBin $RuntimeOut
Copy-Item -Force $BackendBin $BackendOut

Write-Host "staged owned runtime sidecar -> $RuntimeOut"
Write-Host "  binary: $RuntimeBin"
Write-Host "staged native backend sidecar -> $BackendOut"
Write-Host "  binary: $BackendBin"
