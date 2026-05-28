#!/bin/bash
# Build iOS and upload to TestFlight.
# Temporarily swaps identifier to com.markflow.app for iOS build,
# then restores com.markflow.editor for macOS compatibility.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_CONF="$ROOT/src-tauri/tauri.conf.json"
ARCHIVE="$ROOT/src-tauri/gen/apple/build/markflow_iOS.xcarchive"
APP_PLIST="$ARCHIVE/Products/Applications/MarkFlow.app/Info.plist"
ARCHIVE_PLIST="$ARCHIVE/Info.plist"
EXPORT_OPTIONS="$ROOT/src-tauri/gen/apple/ExportOptions.plist"

# Read target build number from project.yml
BUILD_NUM=$(grep 'CFBundleVersion:' "$ROOT/src-tauri/gen/apple/project.yml" | sed 's/.*"\([0-9]*\)".*/\1/')
echo "Target build number: $BUILD_NUM"

# 1. Temporarily swap identifier for iOS
echo "=== Swapping identifier to com.markflow.app ==="
sed -i '' 's/"identifier": "com.markflow.editor"/"identifier": "com.markflow.app"/' "$TAURI_CONF"

# Ensure we restore identifier even if build fails
restore_identifier() {
  sed -i '' 's/"identifier": "com.markflow.app"/"identifier": "com.markflow.editor"/' "$TAURI_CONF"
  echo "=== Restored identifier to com.markflow.editor ==="
}
trap restore_identifier EXIT

# 2. Clean build
echo "=== Building iOS ==="
rm -rf "$ROOT/src-tauri/gen/apple/build" "$HOME/Library/Developer/Xcode/DerivedData/markflow-"*
pnpm tauri ios build 2>&1 | tail -3 || true

# Verify xcarchive was created
if [ ! -d "$ARCHIVE" ]; then
  echo "ERROR: xcarchive not found at $ARCHIVE"
  exit 1
fi

# 3. Fix CFBundleVersion (Tauri overwrites with version string, TestFlight needs integer)
echo "=== Fixing CFBundleVersion to $BUILD_NUM ==="
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUM" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Set :ApplicationProperties:CFBundleVersion $BUILD_NUM" "$ARCHIVE_PLIST" 2>/dev/null || true

# 4. Export & upload
echo "=== Uploading to TestFlight ==="
rm -rf /tmp/markflow-export
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -exportPath /tmp/markflow-export 2>&1 | tail -5

echo "=== Done ==="
