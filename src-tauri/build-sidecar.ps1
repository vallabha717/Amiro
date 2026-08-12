$targetTriple = if ($args.Length -gt 0) { $args[0] } else { ((rustc -Vv) | Select-String "^host:").ToString().Split(" ")[1] }

$goos = "windows"
$goarch = "amd64"
$ext = ".exe"

if ($targetTriple -like "*aarch64*") {
    $goarch = "arm64"
}

$outDir = "$PSScriptRoot\binaries"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = "$outDir\backend-${targetTriple}${ext}"

Write-Host "building backend-go for $targetTriple (GOOS=$goos GOARCH=$goarch) -> $outFile"
Set-Location "$PSScriptRoot\..\backend-go"
$env:GOOS = $goos
$env:GOARCH = $goarch
$env:CGO_ENABLED = "0"
$env:GOPROXY = "https://proxy.golang.org,direct"
$env:GOTOOLCHAIN = "auto"
go build -o $outFile .\cmd\server
Write-Host "done"
