# setup-and-run.ps1: Windows setup and run for Amiro.
#
# One-command bootstrap for a fresh Windows machine. Idempotent: safe to
# re-run, anything already installed is skipped.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-and-run.ps1 [-SkipFrontend] [-SkipNative] [-Yes]
#
# Flags:
#   -SkipFrontend   skip `pnpm build` (no out/ export yet)
#   -SkipNative     skip the Rust builds (run the cargo commands later)
#   -Yes            assume yes for install prompts (non-interactive)
#
# What it does, in order:
#   1. Installs Rust with rustup when `cargo` is missing.
#   2. Checks for Node 20 or newer (the adapter wants 22 or newer). When Node
#      is missing it tries winget, otherwise it prints install instructions
#      instead of forcing an arbitrary Node on you.
#   3. Enables corepack and activates pnpm 10.2.1 (matches package.json).
#   4. Runs `pnpm install` and `pnpm --dir adapter install`.
#   5. Builds the native binaries (backend/target/release/amiro-backend.exe
#      and runtime/target/release/amiro-runtime.exe), with the same flags as
#      scripts/build-native.sh. Uses Git Bash when present, else cargo.
#   6. Runs `pnpm build` (static export into out/).
#   7. Stages the Tauri Windows sidecars with src-tauri/build-sidecar.ps1.
param(
  [switch]$SkipFrontend,
  [switch]$SkipNative,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Confirm-Step([string]$Message) {
  if ($Yes) { return $true }
  $reply = Read-Host "$Message [y/N]"
  return ($reply -eq "y" -or $reply -eq "Y" -or $reply -eq "yes")
}

$installedRust = "skipped (already present)"
$installedNode = "skipped (already present)"
$installedPnpm = "skipped (already present)"

Write-Host ""
Write-Host "==> Amiro setup: Windows, repo $RepoRoot" -ForegroundColor Blue

# ---------------------------------------------------------------------------
# 1. Rust via rustup (only when cargo is missing)
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==> Rust toolchain" -ForegroundColor Blue
if (Get-Command cargo -ErrorAction SilentlyContinue) {
  Write-Host ("ok: cargo present: " + (cargo --version)) -ForegroundColor Green
} else {
  if (-not (Confirm-Step "cargo not found. Download and run rustup-init.exe?")) {
    Write-Error "declined Rust install. Re-run with -Yes to accept automatically."
    exit 1
  }
  $rustupExe = Join-Path $env:TEMP "rustup-init.exe"
  Write-Host "Downloading rustup-init..."
  Invoke-WebRequest -Uri https://win.rustup.rs -OutFile $rustupExe
  Write-Host "Installing rust..."
  & $rustupExe -y --default-toolchain stable
  Remove-Item $rustupExe -Force -ErrorAction SilentlyContinue
  $env:PATH += ";$HOME\.cargo\bin"
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Error "rustup finished but cargo is still not on PATH. Add $HOME\.cargo\bin to PATH and re-run."
    exit 1
  }
  $installedRust = "installed via rustup: $(cargo --version)"
  Write-Host "ok: $installedRust" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 2. Node >= 20 (adapter wants >= 22), via winget when missing
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==> Node.js (>= 20, adapter wants >= 22)" -ForegroundColor Blue
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
  $nodeMajor = node -p "process.versions.node.split('.')[0]"
  if ([int]$nodeMajor -ge 20) {
    Write-Host ("ok: node present: " + (node --version)) -ForegroundColor Green
    if ([int]$nodeMajor -lt 22) {
      Write-Host "warn: adapter/src/server.mjs and adapter/package.json want Node >= 22." -ForegroundColor Yellow
    }
    $nodeOk = $true
  } else {
    Write-Host ("warn: node " + (node --version) + " is older than 20") -ForegroundColor Yellow
  }
}
if (-not $nodeOk) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    if (-not (Confirm-Step "Install Node.js LTS with winget?")) {
      Write-Error "declined Node install. Install Node 22 from https://nodejs.org, then re-run."
      exit 1
    }
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
      Write-Error "winget finished but node is still not on PATH. Restart your shell and re-run."
      exit 1
    }
    $installedNode = "installed via winget: $(node --version)"
    Write-Host "ok: $installedNode" -ForegroundColor Green
  } else {
    Write-Error @"
Node >= 20 is required but none was found, and winget is not available.
This script will not install an arbitrary system Node. Pick one of these:
  1. Install Node.js LTS from https://nodejs.org, then re-run this script.
  2. Install winget, then re-run with -Yes for an automated install.
"@
    exit 1
  }
}

# ---------------------------------------------------------------------------
# 3. pnpm 10.2.1 via corepack
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==> pnpm 10.2.1 (matches package.json packageManager)" -ForegroundColor Blue
$wantPnpm = "10.2.1"
if ((Get-Command pnpm -ErrorAction SilentlyContinue) -and ((pnpm --version) -eq $wantPnpm)) {
  Write-Host ("ok: pnpm present: " + (pnpm --version)) -ForegroundColor Green
} else {
  if (Get-Command corepack -ErrorAction SilentlyContinue) {
    $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
    try {
      corepack enable
    } catch {
      Write-Error "corepack enable failed (it may need an elevated shell): $_"
      exit 1
    }
    corepack prepare "pnpm@$wantPnpm" --activate
  } else {
    Write-Host "warn: corepack not found on this Node, falling back to npm" -ForegroundColor Yellow
    npm install -g "pnpm@$wantPnpm"
  }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Error "pnpm install finished but pnpm is still not on PATH."
    exit 1
  }
  $installedPnpm = "installed: pnpm $(pnpm --version)"
  Write-Host "ok: $installedPnpm" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 4. JS dependencies (root and adapter)
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==> Installing JS dependencies" -ForegroundColor Blue
pnpm install
pnpm --dir adapter install
Write-Host "ok: pnpm install done (root and adapter/)" -ForegroundColor Green

# ---------------------------------------------------------------------------
# 5. Native binaries (same outputs and flags as scripts/build-native.sh)
# ---------------------------------------------------------------------------
$backendBin = Join-Path $RepoRoot "backend\target\release\amiro-backend.exe"
$runtimeBin = Join-Path $RepoRoot "runtime\target\release\amiro-runtime.exe"
if ($SkipNative) {
  Write-Host "warn: -SkipNative, not building Rust binaries." -ForegroundColor Yellow
} else {
  Write-Host ""
  Write-Host "==> Building native binaries" -ForegroundColor Blue
  if (-not (Test-Path (Join-Path $RepoRoot "backend\Cargo.toml"))) {
    Write-Error "missing native source manifest: backend/Cargo.toml"
    exit 1
  }
  if (-not (Test-Path (Join-Path $RepoRoot "runtime\Cargo.toml"))) {
    Write-Error "missing native source manifest: runtime/Cargo.toml"
    exit 1
  }
  $env:CARGO_BUILD_JOBS = if ($env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS } else { "2" }
  if (Get-Command bash -ErrorAction SilentlyContinue) {
    bash (Join-Path $RepoRoot "scripts\build-native.sh")
  } else {
    cargo build --manifest-path (Join-Path $RepoRoot "backend\Cargo.toml") --target-dir (Join-Path $RepoRoot "backend\target") --bin amiro-backend --locked --release
    cargo build --manifest-path (Join-Path $RepoRoot "runtime\Cargo.toml") --target-dir (Join-Path $RepoRoot "runtime\target") --bin amiro-runtime --no-default-features --locked --release
  }
  if (-not ((Test-Path $backendBin) -and (Test-Path $runtimeBin))) {
    Write-Error "build finished but a binary is missing. Expected $backendBin and $runtimeBin"
    exit 1
  }
  Write-Host "ok: native binaries built" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 6. Frontend static export (out/)
# ---------------------------------------------------------------------------
if ($SkipFrontend) {
  Write-Host "warn: -SkipFrontend, not running pnpm build. The backend serves out/, so build it before starting the app." -ForegroundColor Yellow
} else {
  Write-Host ""
  Write-Host "==> Building the frontend (pnpm build -> out/)" -ForegroundColor Blue
  pnpm build
  if (-not (Test-Path (Join-Path $RepoRoot "out\index.html"))) {
    Write-Error "pnpm build finished but out\index.html is missing."
    exit 1
  }
  Write-Host ("ok: frontend export ready at " + (Join-Path $RepoRoot "out")) -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 7. Tauri Windows sidecars
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==> Staging Tauri Windows sidecars" -ForegroundColor Blue
try {
  & (Join-Path $RepoRoot "src-tauri\build-sidecar.ps1")
} catch {
  Write-Host "warn: build-sidecar.ps1 did not finish (it needs both release binaries): $_" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 8. Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Amiro setup complete" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "Rust:         $installedRust"
Write-Host ("Node:         $installedNode (" + (node --version) + ")")
Write-Host ("pnpm:         $installedPnpm (" + (pnpm --version) + ")")
Write-Host "Binaries:"
if (Test-Path $backendBin) {
  Write-Host "  backend:      $backendBin"
} else {
  Write-Host "  backend:      $backendBin (not built, see -SkipNative)"
}
if (Test-Path $runtimeBin) {
  Write-Host "  runtime:      $runtimeBin"
} else {
  Write-Host "  runtime:      $runtimeBin (not built, see -SkipNative)"
}
if (Test-Path (Join-Path $RepoRoot "out\index.html")) {
  Write-Host ("  frontend:     " + (Join-Path $RepoRoot "out"))
} else {
  Write-Host ("  frontend:     " + (Join-Path $RepoRoot "out") + " (not built, see -SkipFrontend)")
}
Write-Host ""
Write-Host "Next commands:"
Write-Host "  Start the native backend (serves out/ and spawns the runtime bridge):"
Write-Host "    .\backend\target\release\amiro-backend.exe"
Write-Host '    # then open http://127.0.0.1:8787 and complete the one-time "Set up Amiro" page'
Write-Host "    # (or pre-set AMIRO_OWNER_EMAIL and AMIRO_OWNER_PASSWORD before first start)"
Write-Host ""
Write-Host "  Or run the dev loop (Node adapter, needs adapter deps):"
Write-Host "    powershell -ExecutionPolicy Bypass -File scripts\dev-backend.ps1"
Write-Host ""
Write-Host "  Desktop app (needs WebView2 plus the Rust and Node steps above):"
Write-Host "    cargo install tauri-cli --version `"^2`" --locked"
Write-Host "    cargo tauri dev"
Write-Host "    # note: tauri.conf.json beforeDevCommand calls bash, so Git Bash"
Write-Host "    # must be on PATH for `cargo tauri dev` to work on Windows."
Write-Host ""
Write-Host "Tests:"
Write-Host "  pnpm test                                      # frontend unit (vitest)"
Write-Host "  node --test adapter/test/*.test.mjs            # adapter unit tests"
Write-Host "  cargo test --manifest-path backend/Cargo.toml  # native backend tests"
Write-Host ""
Write-Host "Full walkthrough: docs/VM-SETUP.md"
