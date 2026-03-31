# MarkFlow Windows All-in-One: Setup → Build → Release
# ONE COMMAND: powershell -ExecutionPolicy Bypass -File .\scripts\build-and-release-windows.ps1
#
# First run: installs prerequisites automatically.
# Subsequent runs: just builds and releases.

param(
    [ValidateSet("beta", "stable")]
    [string]$Channel = "beta"
)

$ErrorActionPreference = "Stop"

# ── Resolve repo root ──────────────────────────────────────
$ROOT = Split-Path -Parent $PSScriptRoot
Set-Location $ROOT
Write-Host "=== MarkFlow Windows All-in-One ($Channel) ===" -ForegroundColor Cyan

# ── 1. Prerequisites ───────────────────────────────────────
Write-Host "`n--- Checking prerequisites ---" -ForegroundColor Cyan

$needsRestart = $false

# Rust
if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Rust..." -ForegroundColor Yellow
    winget install Rustlang.Rustup --source winget --accept-package-agreements --accept-source-agreements
    $needsRestart = $true
}

# Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Node.js..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements
    $needsRestart = $true
}

# pnpm
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "Installing pnpm..." -ForegroundColor Yellow
    npm install -g pnpm
}

# gh CLI
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "Installing GitHub CLI..." -ForegroundColor Yellow
    winget install GitHub.cli --source winget --accept-package-agreements --accept-source-agreements
    $needsRestart = $true
}

if ($needsRestart) {
    Write-Host "`nPrerequisites installed. Please restart your terminal and run this script again." -ForegroundColor Yellow
    exit 0
}

# VS Build Tools check (cl.exe)
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if ((Test-Path $vsWhere) -and (& $vsWhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)) {
    Write-Host "VS Build Tools: OK" -ForegroundColor Green
} else {
    Write-Host "ERROR: Visual Studio Build Tools with C++ workload not found." -ForegroundColor Red
    Write-Host "Install: winget install Microsoft.VisualStudio.2022.BuildTools" -ForegroundColor Yellow
    Write-Host "Then open Visual Studio Installer and add 'C++ desktop development' workload." -ForegroundColor Yellow
    exit 1
}

# gh auth check
$ghStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "GitHub CLI not authenticated. Running 'gh auth login'..." -ForegroundColor Yellow
    gh auth login
    if ($LASTEXITCODE -ne 0) { Write-Host "gh auth failed" -ForegroundColor Red; exit 1 }
}

# Signing key
$keyDir = Join-Path $env:USERPROFILE ".tauri"
$keyFile = Join-Path $keyDir "markflow.key"
if (-not (Test-Path $keyFile)) {
    # Try to find key from the setup bundle
    $bundleKey = Join-Path $ROOT ".windows-setup\markflow.key"
    if (Test-Path $bundleKey) {
        if (-not (Test-Path $keyDir)) { New-Item -ItemType Directory -Path $keyDir -Force | Out-Null }
        Copy-Item $bundleKey $keyFile
        Write-Host "Signing key installed from setup bundle" -ForegroundColor Green
    } else {
        Write-Host "ERROR: Signing key not found at $keyFile" -ForegroundColor Red
        Write-Host "Transfer from macOS: copy ~/.tauri/markflow.key to $keyFile" -ForegroundColor Yellow
        exit 1
    }
}

Write-Host "Rust:  $(rustc --version)" -ForegroundColor Green
Write-Host "Node:  $(node --version)" -ForegroundColor Green
Write-Host "pnpm:  $(pnpm --version)" -ForegroundColor Green
Write-Host "gh:    $(gh --version | Select-Object -First 1)" -ForegroundColor Green
Write-Host "Key:   OK" -ForegroundColor Green

# ── 2. Pull latest ─────────────────────────────────────────
Write-Host "`n--- Pulling latest ---" -ForegroundColor Cyan
git pull
if ($LASTEXITCODE -ne 0) { throw "git pull failed" }

# ── 3. Install deps ────────────────────────────────────────
Write-Host "`n--- Installing dependencies ---" -ForegroundColor Cyan
pnpm install
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }

# ── 4. Build ───────────────────────────────────────────────
Write-Host "`n--- Building ---" -ForegroundColor Cyan
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyFile -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

try {
    pnpm tauri build --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }
}
finally {
    Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

# ── 5. Release ─────────────────────────────────────────────
Write-Host "`n--- Releasing ($Channel) ---" -ForegroundColor Cyan

$version = (Get-Content (Join-Path $ROOT "package.json") | ConvertFrom-Json).version
$bundleDir = Join-Path $ROOT "src-tauri\target\release\bundle\nsis"

$nsisExe = Get-ChildItem (Join-Path $bundleDir "*.exe") -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch "\.sig$" } | Select-Object -First 1
$nsisSig = Get-ChildItem (Join-Path $bundleDir "*.exe.sig") -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $nsisExe -or -not $nsisSig) {
    Write-Host "ERROR: Build artifacts not found (.exe and .exe.sig required)" -ForegroundColor Red
    exit 1
}

if ($Channel -eq "beta") {
    $tag = "beta"
    $jsonName = "beta.json"
    $downloadBase = "https://github.com/momocham922/markflow/releases/download/beta"
} else {
    $tag = "v${version}"
    $jsonName = "latest.json"
    $downloadBase = "https://github.com/momocham922/markflow/releases/download/${tag}"
}

# Download existing JSON
$jsonPath = Join-Path $ROOT $jsonName
gh release download $tag --pattern $jsonName --dir $ROOT --clobber 2>$null
if (-not (Test-Path $jsonPath)) {
    Write-Host "ERROR: ${jsonName} not found in release '${tag}'." -ForegroundColor Red
    Write-Host "Run macOS release script first." -ForegroundColor Yellow
    exit 1
}

# Add Windows platform to JSON
$sigContent = (Get-Content $nsisSig.FullName -Raw).Trim()
$json = Get-Content $jsonPath -Raw | ConvertFrom-Json
$winPlatform = [PSCustomObject]@{
    signature = $sigContent
    url = "${downloadBase}/$($nsisExe.Name)"
}
$json.platforms | Add-Member -NotePropertyName "windows-x86_64" -NotePropertyValue $winPlatform -Force
$json | ConvertTo-Json -Depth 10 | Set-Content $jsonPath -NoNewline

# Upload to GitHub
gh release delete-asset $tag $nsisExe.Name --yes 2>$null
gh release delete-asset $tag $nsisSig.Name --yes 2>$null
gh release delete-asset $tag $jsonName --yes 2>$null

gh release upload $tag $nsisExe.FullName $nsisSig.FullName $jsonPath --clobber

Remove-Item $jsonPath -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== Windows ${Channel} v${version} released! ===" -ForegroundColor Green
Write-Host "Installer: $($nsisExe.Name)" -ForegroundColor White
Write-Host "Auto-update will be delivered to existing Windows users." -ForegroundColor White
