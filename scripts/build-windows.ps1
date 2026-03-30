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

# Temporarily disable updater artifacts (requires signing key we don't have on Windows)
$confPath = "src-tauri\tauri.conf.json"
$conf = Get-Content $confPath -Raw
$needRestore = $false

if ($conf -match '"createUpdaterArtifacts"\s*:\s*true') {
    Write-Host "`n=== Disabling updater artifacts (no signing key) ===" -ForegroundColor Yellow
    $conf -replace '"createUpdaterArtifacts"\s*:\s*true', '"createUpdaterArtifacts": false' | Set-Content $confPath -NoNewline
    $needRestore = $true
}

try {
    # Build
    Write-Host "`n=== Building MarkFlow ===" -ForegroundColor Cyan
    pnpm tauri build
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }
}
finally {
    # Restore tauri.conf.json
    if ($needRestore) {
        $restored = (Get-Content $confPath -Raw) -replace '"createUpdaterArtifacts"\s*:\s*false', '"createUpdaterArtifacts": true'
        $restored | Set-Content $confPath -NoNewline
        Write-Host "=== Restored createUpdaterArtifacts: true ===" -ForegroundColor Yellow
    }
}

# Show output
$version = (Get-Content package.json | ConvertFrom-Json).version
$bundleDir = "src-tauri\target\release\bundle"

Write-Host "`n=== Build complete! ===" -ForegroundColor Green
Write-Host "Version: $version"
Write-Host "`nArtifacts:"

$msi = Get-ChildItem "$bundleDir\msi\*.msi" -ErrorAction SilentlyContinue
$nsis = Get-ChildItem "$bundleDir\nsis\*.exe" -ErrorAction SilentlyContinue

if ($msi) { Write-Host "  MSI:  $($msi.FullName)" -ForegroundColor White }
if ($nsis) { Write-Host "  NSIS: $($nsis.FullName)" -ForegroundColor White }

Write-Host "`nNote: Unsigned build - Windows Defender may show a warning on install." -ForegroundColor Yellow
