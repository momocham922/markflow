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
##   - Generates beta.json from the .sig file
##   - Creates or updates the "beta" GitHub release with the new artifacts
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

# Generate beta.json
SIG_CONTENT=$(cat "$SIG")
BETA_JSON=$(python3 -c "
import json, datetime
data = {
    'version': '${VERSION}',
    'notes': 'Beta release v${VERSION}',
    'pub_date': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
    'platforms': {
        'darwin-aarch64': {
            'signature': '${SIG_CONTENT}',
            'url': 'https://github.com/momocham922/markflow/releases/download/beta/MarkFlow.app.tar.gz'
        }
    }
}
print(json.dumps(data, indent=2))
")
echo "$BETA_JSON" > beta.json
echo "Generated beta.json for v${VERSION}"

# Delete existing "beta" release if it exists (to re-create with new assets)
gh release delete beta --yes 2>/dev/null || true
git tag -d beta 2>/dev/null || true
git push origin :refs/tags/beta 2>/dev/null || true

# Create the "beta" release as a pre-release
gh release create beta \
  "$DMG" \
  "$TAR" \
  "$SIG" \
  beta.json \
  --title "Beta v${VERSION}" \
  --notes "Beta release v${VERSION} - for testing before stable release." \
  --prerelease

rm -f beta.json

echo ""
echo "=== Beta release v${VERSION} published! ==="
echo "Beta users will receive the update automatically."
echo ""
echo "To promote to stable:"
echo "  ./scripts/release-stable.sh"
