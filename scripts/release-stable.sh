#!/bin/bash
##
## Promote current build to a stable release.
##
## Usage: ./scripts/release-stable.sh
##
## Prerequisites:
##   1. Version already bumped to stable (e.g., 0.3.0) via bump-version.sh
##   2. Code committed and pushed
##   3. Signed build completed
##

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
echo "=== Stable release: v${VERSION} ==="

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

# Generate latest.json
SIG_CONTENT=$(cat "$SIG")
LATEST_JSON=$(python3 -c "
import json, datetime
data = {
    'version': '${VERSION}',
    'notes': 'MarkFlow v${VERSION}',
    'pub_date': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
    'platforms': {
        'darwin-aarch64': {
            'signature': '${SIG_CONTENT}',
            'url': 'https://github.com/momocham922/markflow/releases/latest/download/MarkFlow.app.tar.gz'
        }
    }
}
print(json.dumps(data, indent=2))
")
echo "$LATEST_JSON" > latest.json
echo "Generated latest.json for v${VERSION}"

# Create the stable release
gh release create "v${VERSION}" \
  "$DMG" \
  "$TAR" \
  "$SIG" \
  latest.json \
  --title "MarkFlow v${VERSION}" \
  --generate-notes

rm -f latest.json

echo ""
echo "=== Stable release v${VERSION} published! ==="
echo "All users will receive the update automatically."
