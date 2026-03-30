#!/bin/bash
# Build iOS and upload to TestFlight.
# Handles Bundle ID mismatch (com.markflow.editor → com.markflow.app)
# and Tauri's CFBundleVersion overwrite.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVE="$ROOT/src-tauri/gen/apple/build/markflow_iOS.xcarchive"
APP_PLIST="$ARCHIVE/Products/Applications/MarkFlow.app/Info.plist"
ARCHIVE_PLIST="$ARCHIVE/Info.plist"
EXPORT_OPTIONS="$ROOT/src-tauri/gen/apple/ExportOptions.plist"

# Read target build number from project.yml
BUILD_NUM=$(grep 'CFBundleVersion:' "$ROOT/src-tauri/gen/apple/project.yml" | sed 's/.*"\([0-9]*\)".*/\1/')
echo "Target build number: $BUILD_NUM"

# 1. Clean build
echo "=== Building iOS ==="
rm -rf "$ROOT/src-tauri/gen/apple/build" "$HOME/Library/Developer/Xcode/DerivedData/markflow-"*
pnpm tauri ios build 2>&1 | tail -3

# 2. Fix Bundle ID (Tauri uses com.markflow.editor, App Store needs com.markflow.app)
echo "=== Fixing Bundle ID ==="
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.markflow.app" "$APP_PLIST"

# 3. Fix CFBundleVersion (Tauri overwrites with version string, TestFlight needs integer)
echo "=== Fixing CFBundleVersion to $BUILD_NUM ==="
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUM" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Set :ApplicationProperties:CFBundleVersion $BUILD_NUM" "$ARCHIVE_PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :ApplicationProperties:CFBundleIdentifier com.markflow.app" "$ARCHIVE_PLIST" 2>/dev/null || true

# 4. Export & upload
echo "=== Uploading to TestFlight ==="
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -exportPath /tmp/markflow-export 2>&1 | tail -5

echo "=== Done ==="
