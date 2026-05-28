#!/bin/bash
##
## Prepare a setup bundle for Windows builds.
## Creates .windows-setup/ with the signing key.
##
## Usage: ./scripts/prepare-windows-setup.sh
##
## Transfer .windows-setup/ to the Windows machine (USB, AirDrop, network share).
## The Windows build script will auto-detect and install the key from this folder.
##

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SETUP_DIR="$ROOT/.windows-setup"

mkdir -p "$SETUP_DIR"

# Copy signing key
KEY="$HOME/.tauri/markflow.key"
if [ ! -f "$KEY" ]; then
  echo "ERROR: Signing key not found at $KEY"
  exit 1
fi
cp "$KEY" "$SETUP_DIR/markflow.key"

echo "=== Windows setup bundle created ==="
echo ""
echo "  $SETUP_DIR/"
echo "    markflow.key  — Tauri signing key"
echo ""
echo "Transfer this folder to the Windows machine's repo root."
echo "The build script will auto-install the key on first run."
