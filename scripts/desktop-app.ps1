# ============================================================================
# desktop-app.ps1 -- Cross-platform launcher for Amiro Desktop on Windows.
#
# Launches the native compiled Tauri desktop binary if present, or starts the
# local amiro-backend with AMIRO_DESKTOP=1 on loopback and opens a dedicated
# desktop app window in Edge/Chrome with native notifications enabled.
#
# Usage:
#   .\scripts\desktop-app.ps1 [command] [-Port <port>] [-NoBrowser]
#
# Commands:
#   start             Launch Amiro Desktop (default)
#   stage-sidecars    Stage backend and runtime sidecar binaries
#   build             Build the desktop application package
#   dev               Run desktop development mode
#   status            Check desktop app runtime and process status
#   -Help             Print this help message
# ============================================================================
param(
    [Parameter(Position = 0)]
    [string]$Command = "start",

    [int]$Port = 3000,
    [switch]$NoBrowser = $false,
    [switch]$Help = $false
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$StateDir = Join-Path $RepoRoot ".amiro-desktop"
$PidFile = Join-Path $StateDir "desktop-backend.pid"
$LogFile = Join-Path $StateDir "desktop-backend.log"
$TokenFile = Join-Path $StateDir "desktop-token"

function Show-Usage {
    Write-Host @"
desktop-app.ps1 -- Cross-platform launcher for Amiro Desktop on Windows.

Usage:
  .\scripts\desktop-app.ps1 [command] [-Port <port>] [-NoBrowser]

Commands:
  start             Launch Amiro Desktop (default)
  stage-sidecars    Stage backend and runtime sidecar binaries
  build             Build the desktop application package
  dev               Run desktop development mode
  status            Check desktop app runtime and process status
  -Help             Print this help message
"@
}

if ($Help -or $Command -eq "--help" -or $Command -eq "-h") {
    Show-Usage
    exit 0
}

function Get-TargetTriple {
    try {
        $hostLine = (& rustc -Vv | Select-String '^host:').ToString()
        return $hostLine.Split(' ')[1]
    } catch {
        return "x86_64-pc-windows-msvc"
    }
}

function Find-NativeTauriBinary {
    $candidates = @(
        (Join-Path $RepoRoot "clients\desktop\target\release\amiro.exe"),
        (Join-Path $RepoRoot "clients\desktop\target\debug\amiro.exe")
    )
    foreach ($cand in $candidates) {
        if (Test-Path $cand) { return $cand }
    }
    return $null
}

function Resolve-Backend {
    $candidates = @(
        (Join-Path $RepoRoot "backend\target\release\amiro-backend.exe"),
        (Join-Path $RepoRoot "backend\target\debug\amiro-backend.exe")
    )
    foreach ($cand in $candidates) {
        if (Test-Path $cand) { return $cand }
    }
    $fromPath = Get-Command amiro-backend.exe -ErrorAction SilentlyContinue
    if ($fromPath) { return $fromPath.Source }
    return $null
}

function Test-PortListening([int]$testPort) {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect("127.0.0.1", $testPort, $null, $null)
        $wait = $iar.AsyncWaitHandle.WaitOne(200, $false)
        if ($wait -and $tcp.Connected) {
            $tcp.EndConnect($iar)
            $tcp.Close()
            return $true
        }
        $tcp.Close()
    } catch {}
    return $false
}

function Ensure-DesktopToken {
    if (Test-Path $TokenFile) {
        $existing = Get-Content $TokenFile -Raw
        if ($existing) { return $existing.Trim() }
    }
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $rng = New-Object byte[] 32
    (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($rng)
    $token = [System.BitConverter]::ToString($rng).Replace("-", "").ToLower()
    Set-Content -Path $TokenFile -Value $token
    return $token
}

function Launch-DesktopWindow([string]$url) {
    if ($NoBrowser) {
        Write-Host "App URL: $url (browser launch suppressed via -NoBrowser)"
        return
    }

    $edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    $chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"

    if (Test-Path $edgePath) {
        Start-Process -FilePath $edgePath -ArgumentList "--app=$url"
        return
    }
    if (Test-Path $chromePath) {
        Start-Process -FilePath $chromePath -ArgumentList "--app=$url"
        return
    }
    Start-Process $url
}

function Invoke-StageSidecars {
    Write-Host "Staging Tauri sidecars..."
    & (Join-Path $RepoRoot "clients\desktop\build-sidecar.ps1")
}

function Invoke-Build {
    Write-Host "Building Amiro Desktop for Windows..."
    Invoke-StageSidecars
    $cargoTauri = Get-Command cargo-tauri -ErrorAction SilentlyContinue
    if ($cargoTauri) {
        & cargo tauri build
    } else {
        & cargo build --manifest-path (Join-Path $RepoRoot "clients\desktop\Cargo.toml") --release
    }
}

function Invoke-Dev {
    $cargoTauri = Get-Command cargo-tauri -ErrorAction SilentlyContinue
    if ($cargoTauri) {
        & cargo tauri dev
    } else {
        Write-Host "cargo-tauri not found; launching desktop app in dev mode..."
        Invoke-Start
    }
}

function Invoke-Status {
    Write-Host "=== Amiro Desktop Status (Windows) ==="
    $triple = Get-TargetTriple
    Write-Host "Target Triple:   $triple"

    $native = Find-NativeTauriBinary
    if ($native) {
        Write-Host "Native Desktop:  Found ($native)"
    } else {
        Write-Host "Native Desktop:  Not compiled (will use dedicated Desktop App Window fallback)"
    }

    $backend = Resolve-Backend
    if ($backend) {
        Write-Host "Backend Sidecar: Found ($backend)"
    } else {
        Write-Host "Backend Sidecar: Missing (build with cargo build --manifest-path backend/Cargo.toml)"
    }

    $stagedBackend = Join-Path $RepoRoot "clients\desktop\binaries\backend-$triple.exe"
    $stagedRuntime = Join-Path $RepoRoot "clients\desktop\binaries\runtime-$triple.exe"
    if ((Test-Path $stagedBackend) -and (Test-Path $stagedRuntime)) {
        Write-Host "Staged Sidecars: Yes (backend & runtime staged in clients\desktop\binaries)"
    } else {
        Write-Host "Staged Sidecars: Not staged (run: .\scripts\desktop-app.ps1 stage-sidecars)"
    }

    $listening = Test-PortListening $Port
    if ($listening) {
        Write-Host "Port $Port:        Listening"
    } else {
        Write-Host "Port $Port:        Idle"
    }
}

function Invoke-Start {
    $native = Find-NativeTauriBinary
    if ($native) {
        Write-Host "Launching compiled native Tauri desktop app: $native"
        Start-Process -FilePath $native
        return
    }

    Write-Host "Native Tauri binary not found; starting Amiro Desktop in dedicated window mode..."
    $backend = Resolve-Backend
    if (-not $backend) {
        Write-Error "Neither native Tauri binary nor amiro-backend.exe found. Build backend first."
        exit 1
    }

    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $targetPort = $Port
    while (Test-PortListening $targetPort) {
        # Check if already Amiro
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$targetPort/api/system" -TimeoutSec 1 -ErrorAction SilentlyContinue
            if ($resp) {
                Write-Host "Attached to running Amiro server on 127.0.0.1:$targetPort"
                Launch-DesktopWindow "http://127.0.0.1:$targetPort"
                return
            }
        } catch {}
        $targetPort++
    }

    $token = Ensure-DesktopToken
    $env:AMIRO_DESKTOP = "1"
    $env:AMIRO_HOST = "127.0.0.1"
    $env:AMIRO_PORT = "$targetPort"
    $env:AMIRO_TOKEN = "$token"
    $env:AMIRO_AUTH_TOKEN = "$token"
    $env:AMIRO_ALLOWED_ORIGIN = "http://localhost:$targetPort,http://127.0.0.1:$targetPort"
    if (-not $env:AMIRO_HOME) {
        $env:AMIRO_HOME = (Join-Path $env:USERPROFILE ".amiro")
    }

    Write-Host "Starting amiro-backend with AMIRO_DESKTOP=1 on 127.0.0.1:$targetPort..."
    $proc = Start-Process -FilePath $backend -RedirectStandardOutput $LogFile -RedirectStandardError $LogFile -PassThru
    Set-Content -Path $PidFile -Value $proc.Id

    $waited = 0
    while ($waited -lt 30) {
        if (Test-PortListening $targetPort) { break }
        Start-Sleep -Seconds 1
        $waited++
    }

    $url = "http://127.0.0.1:$targetPort"
    Write-Host "Opening Amiro Desktop window at $url..."
    Launch-DesktopWindow $url
}

switch ($Command.ToLower()) {
    "start"          { Invoke-Start }
    "stage-sidecars" { Invoke-StageSidecars }
    "build"          { Invoke-Build }
    "dev"            { Invoke-Dev }
    "status"         { Invoke-Status }
    default          {
        Write-Error "Unknown command: $Command. Run with -Help for usage."
        exit 1
    }
}
