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

# Download existing beta.json to preserve Windows entry
EXISTING_JSON="{}"
if gh release download beta --pattern "beta.json" --dir /tmp --clobber 2>/dev/null; then
  EXISTING_JSON=$(cat /tmp/beta.json)
  echo "Downloaded existing beta.json (preserving Windows entry if present)"
fi

# Generate beta.json — merge macOS into existing (preserves windows-x86_64)
SIG_CONTENT=$(cat "$SIG")
python3 -c "
import json, datetime, sys

try:
    existing = json.loads('''${EXISTING_JSON}''')
except:
    existing = {}

existing_platforms = existing.get('platforms', {})

data = {
    'version': '${VERSION}',
    'notes': 'Beta release v${VERSION}',
    'pub_date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'platforms': {}
}

# Preserve Windows entry if it exists and version matches
if 'windows-x86_64' in existing_platforms and existing.get('version') == '${VERSION}':
    data['platforms']['windows-x86_64'] = existing_platforms['windows-x86_64']

# Add/update macOS entry
data['platforms']['darwin-aarch64'] = {
    'signature': '${SIG_CONTENT}',
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
