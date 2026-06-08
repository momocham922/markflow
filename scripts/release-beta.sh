#!/bin/bash
##
## Release a beta version to the "beta" GitHub release tag.
##
## Usage: ./scripts/release-beta.sh
##
## Prerequisites:
##   1. Version already bumped (e.g., 0.3.0-beta.1) via bump-version.sh
##   2. Code committed and pushed
##   3. Signed build completed
##
## What this does:
##   - Reads the version from package.json
##   - Downloads existing beta.json (preserves Windows entry if present)
##   - Updates beta.json with macOS platform
##   - Uploads macOS artifacts to the "beta" GitHub release (creates if needed)
##

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
echo "=== Beta release: v${VERSION} ==="

# Paths to build artifacts
DMG="src-tauri/target/release/bundle/dmg/MarkFlow_${VERSION}_aarch64.dmg"
TAR="src-tauri/target/release/bundle/macos/MarkFlow.app.tar.gz"
SIG="src-tauri/target/release/bundle/macos/MarkFlow.app.tar.gz.sig"

# Verify artifacts exist
for f in "$DMG" "$TAR" "$SIG"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: Missing artifact: $f"
    echo "Run signed build first:"
    echo '  TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/markflow.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm tauri build'
    exit 1
  fi
done

# Try to get Windows signature from release assets (CI may have built it already)
WIN_SIG=""
WIN_EXE_NAME="MarkFlow_${VERSION}_x64-setup.exe"
if gh release download beta --pattern "${WIN_EXE_NAME}.sig" --dir /tmp --clobber 2>/dev/null; then
  WIN_SIG=$(cat "/tmp/${WIN_EXE_NAME}.sig")
  echo "Found Windows signature for v${VERSION} in release assets"
else
  # Fallback: check existing beta.json for Windows entry with matching version
  if gh release download beta --pattern "beta.json" --dir /tmp --clobber 2>/dev/null; then
    WIN_SIG=$(python3 -c "
import json, sys
try:
    d = json.load(open('/tmp/beta.json'))
    if d.get('version') == '${VERSION}' and 'windows-x86_64' in d.get('platforms', {}):
        print(d['platforms']['windows-x86_64']['signature'])
except: pass
" 2>/dev/null)
    if [ -n "$WIN_SIG" ]; then
      echo "Preserved Windows entry from existing beta.json"
    fi
  fi
fi

# Generate beta.json
SIG_CONTENT=$(cat "$SIG")
python3 -c "
import json, datetime, sys

data = {
    'version': '${VERSION}',
    'notes': 'Beta release v${VERSION}',
    'pub_date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'platforms': {}
}

win_sig = '''${WIN_SIG}'''
if win_sig.strip():
    data['platforms']['windows-x86_64'] = {
        'signature': win_sig.strip(),
        'url': 'https://github.com/momocham922/markflow/releases/download/beta/${WIN_EXE_NAME}'
    }
    print('Including windows-x86_64', file=sys.stderr)

data['platforms']['darwin-aarch64'] = {
    'signature': '''${SIG_CONTENT}''',
    'url': 'https://github.com/momocham922/markflow/releases/download/beta/MarkFlow.app.tar.gz'
}

print(json.dumps(data, indent=2))
" > beta.json
echo "Generated beta.json for v${VERSION}"

# Create or update the "beta" release
if gh release view beta >/dev/null 2>&1; then
  # Delete old macOS assets (keep Windows assets intact)
  gh release delete-asset beta "MarkFlow.app.tar.gz" --yes 2>/dev/null || true
  gh release delete-asset beta "MarkFlow.app.tar.gz.sig" --yes 2>/dev/null || true
  gh release delete-asset beta "beta.json" --yes 2>/dev/null || true
  # Delete old DMGs (version in filename may differ)
  for asset in $(gh release view beta --json assets -q '.assets[].name' 2>/dev/null | grep '\.dmg$'); do
    gh release delete-asset beta "$asset" --yes 2>/dev/null || true
  done

  gh release upload beta \
    "$DMG" \
    "$TAR" \
    "$SIG" \
    beta.json \
    --clobber

  # Update release metadata
  gh release edit beta \
    --title "Beta v${VERSION}" \
    --notes "Beta release v${VERSION} - for testing before stable release." \
    --prerelease
else
  # Delete stale tag if exists
  git tag -d beta 2>/dev/null || true
  git push origin :refs/tags/beta 2>/dev/null || true

  gh release create beta \
    "$DMG" \
    "$TAR" \
    "$SIG" \
    beta.json \
    --title "Beta v${VERSION}" \
    --notes "Beta release v${VERSION} - for testing before stable release." \
    --prerelease
fi

rm -f beta.json /tmp/beta.json

echo ""
echo "=== Beta release v${VERSION} published! ==="
echo "Beta users will receive the update automatically."
echo ""
echo "To promote to stable:"
echo "  ./scripts/release-stable.sh"
