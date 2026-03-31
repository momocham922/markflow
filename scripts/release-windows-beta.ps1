# MarkFlow Windows Beta Release Script
# Adds Windows artifacts to the existing "beta" GitHub release.
#
# Usage: .\scripts\release-windows-beta.ps1
#
# Prerequisites:
#   1. macOS beta already released via ./scripts/release-beta.sh
#   2. Windows signed build completed via .\scripts\build-windows.ps1
#   3. gh CLI installed and authenticated (winget install GitHub.cli)

$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $PSScriptRoot
Set-Location $ROOT

$version = (Get-Content (Join-Path $ROOT "package.json") | ConvertFrom-Json).version
Write-Host "=== Windows Beta Release: v${version} ===" -ForegroundColor Cyan

# Find Windows artifacts
$bundleDir = Join-Path $ROOT "src-tauri\target\release\bundle\nsis"
$nsisExe = Get-ChildItem (Join-Path $bundleDir "*.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
$nsisZip = Get-ChildItem (Join-Path $bundleDir "*.nsis.zip") -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch "\.sig$" } | Select-Object -First 1
$nsisSig = Get-ChildItem (Join-Path $bundleDir "*.nsis.zip.sig") -ErrorAction SilentlyContinue | Select-Object -First 1

$missingArtifacts = @()
if (-not $nsisExe) { $missingArtifacts += "NSIS installer (.exe)" }
if (-not $nsisZip) { $missingArtifacts += "NSIS updater (.nsis.zip)" }
if (-not $nsisSig) { $missingArtifacts += "NSIS signature (.nsis.zip.sig)" }

if ($missingArtifacts.Count -gt 0) {
    Write-Host "ERROR: Missing artifacts:" -ForegroundColor Red
    $missingArtifacts | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    Write-Host "Run .\scripts\build-windows.ps1 first." -ForegroundColor Yellow
    exit 1
}

# Check gh CLI
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: gh CLI not found. Install: winget install GitHub.cli" -ForegroundColor Red
    exit 1
}

# Download existing beta.json from the release
Write-Host "Downloading existing beta.json..." -ForegroundColor Cyan
$betaJsonPath = Join-Path $ROOT "beta.json"
try {
    gh release download beta --pattern "beta.json" --dir $ROOT --clobber 2>$null
} catch {
    Write-Host "ERROR: beta release not found. Run macOS release-beta.sh first." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $betaJsonPath)) {
    Write-Host "ERROR: Could not download beta.json. Run macOS release-beta.sh first." -ForegroundColor Red
    exit 1
}

# Read signature and update beta.json with Windows platform
$sigContent = Get-Content $nsisSig.FullName -Raw
$betaJson = Get-Content $betaJsonPath -Raw | ConvertFrom-Json

$winPlatform = [PSCustomObject]@{
    signature = $sigContent.Trim()
    url = "https://github.com/momocham922/markflow/releases/download/beta/$($nsisZip.Name)"
}
$betaJson.platforms | Add-Member -NotePropertyName "windows-x86_64" -NotePropertyValue $winPlatform -Force

$betaJson | ConvertTo-Json -Depth 10 | Set-Content $betaJsonPath -NoNewline
Write-Host "Updated beta.json with windows-x86_64 platform" -ForegroundColor Green

# Upload Windows artifacts to the existing beta release
Write-Host "Uploading Windows artifacts..." -ForegroundColor Cyan

# Delete old Windows artifacts if they exist (re-upload)
gh release delete-asset beta $nsisExe.Name --yes 2>$null
gh release delete-asset beta $nsisZip.Name --yes 2>$null
gh release delete-asset beta $nsisSig.Name --yes 2>$null
gh release delete-asset beta "beta.json" --yes 2>$null

# Upload new artifacts
gh release upload beta `
    $nsisExe.FullName `
    $nsisZip.FullName `
    $nsisSig.FullName `
    $betaJsonPath `
    --clobber

Remove-Item $betaJsonPath -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== Windows beta release v${version} published! ===" -ForegroundColor Green
Write-Host "Windows beta users will receive the update automatically."
