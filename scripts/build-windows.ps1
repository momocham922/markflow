# MarkFlow Windows Build Script
# Run in PowerShell: .\scripts\build-windows.ps1
#
# Prerequisites (install once):
#   winget install Rustlang.Rustup
#   winget install OpenJS.NodeJS.LTS
#   npm install -g pnpm
#   winget install Microsoft.VisualStudio.2022.BuildTools
#     -> Select "C++ desktop development" workload
#
# Signing key (required for auto-updater):
#   Copy from macOS: ~/.tauri/markflow.key -> %USERPROFILE%\.tauri\markflow.key

$ErrorActionPreference = "Stop"

# Resolve repo root from script location
$ROOT = Split-Path -Parent $PSScriptRoot

Write-Host "=== MarkFlow Windows Build ===" -ForegroundColor Cyan
Write-Host "Root: $ROOT"

Set-Location $ROOT

if (-not (Test-Path "src-tauri\tauri.conf.json")) {
    Write-Host "ERROR: src-tauri\tauri.conf.json not found in $ROOT" -ForegroundColor Red
    exit 1
}

# Check prerequisites
$missing = @()
if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) { $missing += "Rust (winget install Rustlang.Rustup)" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $missing += "Node.js (winget install OpenJS.NodeJS.LTS)" }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { $missing += "pnpm (npm install -g pnpm)" }

if ($missing.Count -gt 0) {
    Write-Host "`nMissing prerequisites:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    exit 1
}

Write-Host "Rust:  $(rustc --version)"
Write-Host "Node:  $(node --version)"
Write-Host "pnpm:  $(pnpm --version)"

# Signing key (required)
$keyFile = Join-Path $env:USERPROFILE ".tauri\markflow.key"
if (-not (Test-Path $keyFile)) {
    Write-Host "`nERROR: Signing key not found at $keyFile" -ForegroundColor Red
    Write-Host "Copy from macOS: scp mac:~/.tauri/markflow.key $keyFile" -ForegroundColor Yellow
    exit 1
}

$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyFile -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
Write-Host "Signing key loaded" -ForegroundColor Green

try {
    # Install dependencies
    Write-Host "`n=== Installing dependencies ===" -ForegroundColor Cyan
    pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }

    # Build
    Write-Host "`n=== Building MarkFlow ===" -ForegroundColor Cyan
    pnpm tauri build
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }
}
finally {
    Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

# Show output
$version = (Get-Content (Join-Path $ROOT "package.json") | ConvertFrom-Json).version
$bundleDir = Join-Path $ROOT "src-tauri\target\release\bundle"

Write-Host "`n=== Build complete! ===" -ForegroundColor Green
Write-Host "Version: $version"
Write-Host "`nArtifacts:"

$nsis = Get-ChildItem (Join-Path $bundleDir "nsis\*.exe") -ErrorAction SilentlyContinue
$nsisZip = Get-ChildItem (Join-Path $bundleDir "nsis\*.nsis.zip") -ErrorAction SilentlyContinue
$nsisSig = Get-ChildItem (Join-Path $bundleDir "nsis\*.nsis.zip.sig") -ErrorAction SilentlyContinue

if ($nsis) { Write-Host "  Installer: $($nsis.FullName)" -ForegroundColor White }
if ($nsisZip) { Write-Host "  Updater:   $($nsisZip.FullName)" -ForegroundColor White }
if ($nsisSig) { Write-Host "  Signature: $($nsisSig.FullName)" -ForegroundColor White }

Write-Host "`nNext: run .\scripts\release-windows-beta.ps1 to publish" -ForegroundColor Cyan
