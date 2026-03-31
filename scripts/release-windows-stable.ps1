# MarkFlow Windows Stable Release Script
# Adds Windows artifacts to the existing stable GitHub release.
#
# Usage: .\scripts\release-windows-stable.ps1
#
# Prerequisites:
#   1. macOS stable already released via ./scripts/release-stable.sh
#   2. Windows signed build completed via .\scripts\build-windows.ps1
#   3. gh CLI installed and authenticated (winget install GitHub.cli)

$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $PSScriptRoot
Set-Location $ROOT

$version = (Get-Content (Join-Path $ROOT "package.json") | ConvertFrom-Json).version
$tag = "v${version}"
Write-Host "=== Windows Stable Release: ${tag} ===" -ForegroundColor Cyan

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

# Download existing latest.json from the release
Write-Host "Downloading existing latest.json..." -ForegroundColor Cyan
$latestJsonPath = Join-Path $ROOT "latest.json"
try {
    gh release download $tag --pattern "latest.json" --dir $ROOT --clobber 2>$null
} catch {
    Write-Host "ERROR: Release ${tag} not found. Run macOS release-stable.sh first." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $latestJsonPath)) {
    Write-Host "ERROR: Could not download latest.json. Run macOS release-stable.sh first." -ForegroundColor Red
    exit 1
}

# Read signature and update latest.json with Windows platform
$sigContent = Get-Content $nsisSig.FullName -Raw
$latestJson = Get-Content $latestJsonPath -Raw | ConvertFrom-Json

$winPlatform = [PSCustomObject]@{
    signature = $sigContent.Trim()
    url = "https://github.com/momocham922/markflow/releases/download/${tag}/$($nsisZip.Name)"
}
$latestJson.platforms | Add-Member -NotePropertyName "windows-x86_64" -NotePropertyValue $winPlatform -Force

$latestJson | ConvertTo-Json -Depth 10 | Set-Content $latestJsonPath -NoNewline
Write-Host "Updated latest.json with windows-x86_64 platform" -ForegroundColor Green

# Upload Windows artifacts to the existing release
Write-Host "Uploading Windows artifacts..." -ForegroundColor Cyan

gh release delete-asset $tag $nsisExe.Name --yes 2>$null
gh release delete-asset $tag $nsisZip.Name --yes 2>$null
gh release delete-asset $tag $nsisSig.Name --yes 2>$null
gh release delete-asset $tag "latest.json" --yes 2>$null

gh release upload $tag `
    $nsisExe.FullName `
    $nsisZip.FullName `
    $nsisSig.FullName `
    $latestJsonPath `
    --clobber

Remove-Item $latestJsonPath -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== Windows stable release ${tag} published! ===" -ForegroundColor Green
Write-Host "All Windows users will receive the update automatically."
