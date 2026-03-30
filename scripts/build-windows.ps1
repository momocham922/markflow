# MarkFlow Windows Build Script
# Run in PowerShell: .\scripts\build-windows.ps1
#
# Prerequisites (install once):
#   winget install Rustlang.Rustup
#   winget install OpenJS.NodeJS.LTS
#   npm install -g pnpm
#   winget install Microsoft.VisualStudio.2022.BuildTools
#     -> Select "C++ desktop development" workload

$ErrorActionPreference = "Stop"

Write-Host "=== MarkFlow Windows Build ===" -ForegroundColor Cyan

# Check prerequisites
$missing = @()

if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) { $missing += "Rust (winget install Rustlang.Rustup)" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $missing += "Node.js (winget install OpenJS.NodeJS.LTS)" }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { $missing += "pnpm (npm install -g pnpm)" }

if ($missing.Count -gt 0) {
    Write-Host "`nMissing prerequisites:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    Write-Host "`nInstall them and restart your terminal.`n" -ForegroundColor Red
    exit 1
}

Write-Host "Rust:  $(rustc --version)"
Write-Host "Node:  $(node --version)"
Write-Host "pnpm:  $(pnpm --version)"

# Install dependencies
Write-Host "`n=== Installing dependencies ===" -ForegroundColor Cyan
pnpm install
if ($LASTEXITCODE -ne 0) { Write-Host "pnpm install failed" -ForegroundColor Red; exit 1 }

# Signing key for updater
$keyFile = "$env:USERPROFILE\.tauri\markflow.key"
if (Test-Path $keyFile) {
    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyFile -Raw
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
    Write-Host "Signing key loaded from $keyFile"
} else {
    Write-Host "Signing key not found at $keyFile" -ForegroundColor Red
    Write-Host "Copy markflow.key from macOS: ~/.tauri/markflow.key -> $keyFile" -ForegroundColor Yellow
    exit 1
}

# Build
Write-Host "`n=== Building MarkFlow ===" -ForegroundColor Cyan
pnpm tauri build --bundles nsis
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed" -ForegroundColor Red; exit 1 }

# Show output
$version = (Get-Content package.json | ConvertFrom-Json).version
$bundleDir = "src-tauri\target\release\bundle"

Write-Host "`n=== Build complete! ===" -ForegroundColor Green
Write-Host "Version: $version"
Write-Host "`nArtifacts:"

$nsis = Get-ChildItem "$bundleDir\nsis\*.exe" -ErrorAction SilentlyContinue

if ($nsis) { Write-Host "  NSIS: $($nsis.FullName)" -ForegroundColor White }

Write-Host "`nNote: Unsigned build - Windows Defender may show a warning on install." -ForegroundColor Yellow
