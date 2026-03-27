#!/bin/bash
# Bump version in all 3 required files atomically.
# Usage: ./scripts/bump-version.sh 0.2.23

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.2.23"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 1. package.json
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$ROOT/package.json"

# 2. tauri.conf.json
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$ROOT/src-tauri/tauri.conf.json"

# 3. Cargo.toml (only the package version line, under [package])
python3 -c "
import re, sys
with open('$ROOT/src-tauri/Cargo.toml') as f:
    content = f.read()
content = re.sub(r'^(version\s*=\s*)\"[^\"]*\"', r'\g<1>\"$VERSION\"', content, count=1, flags=re.MULTILINE)
with open('$ROOT/src-tauri/Cargo.toml', 'w') as f:
    f.write(content)
"

# 4. iOS project.yml (CFBundleShortVersionString and CFBundleVersion)
IOS_PROJECT="$ROOT/src-tauri/gen/apple/project.yml"
if [ -f "$IOS_PROJECT" ]; then
  sed -i '' "s/CFBundleShortVersionString: .*/CFBundleShortVersionString: $VERSION/" "$IOS_PROJECT"
  sed -i '' "s/CFBundleVersion: .*/CFBundleVersion: \"$VERSION\"/" "$IOS_PROJECT"
fi

# Verify all 3 core files match
V1=$(grep '"version"' "$ROOT/package.json" | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/')
V2=$(grep '"version"' "$ROOT/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/')
V3=$(grep '^version' "$ROOT/src-tauri/Cargo.toml" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')

if [ "$V1" = "$VERSION" ] && [ "$V2" = "$VERSION" ] && [ "$V3" = "$VERSION" ]; then
  echo "All files bumped to $VERSION"
else
  echo "ERROR: Version mismatch!"
  echo "  package.json:     $V1"
  echo "  tauri.conf.json:  $V2"
  echo "  Cargo.toml:       $V3"
  exit 1
fi
