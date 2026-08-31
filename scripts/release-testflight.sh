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
if [ -z "$BUILD_NUM" ]; then
  echo "ERROR: Failed to extract CFBundleVersion from project.yml"
  exit 1
fi

# App Store Connect API key for the upload. xcodebuild would auto-discover keys
# in ~/.appstoreconnect/private_keys, but that directory now holds several keys,
# so the selection MUST be explicit or the upload is non-deterministic (it could
# pick the wrong key). Defaults are the owner's ASC API key IDENTIFIERS (the .p8
# secret itself stays local and is never committed); override via env if needed.
APPLE_API_KEY="${APPLE_API_KEY:-AQ996V29F4}"
APPLE_API_ISSUER="${APPLE_API_ISSUER:-fab7704b-d2a9-4ce6-9e58-c6a73c958c22}"
APPLE_API_KEY_PATH="${APPLE_API_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${APPLE_API_KEY}.p8}"
APPLE_API_KEY_PATH="${APPLE_API_KEY_PATH/#\~/$HOME}"  # expand leading ~ if set via env
if [ ! -f "$APPLE_API_KEY_PATH" ]; then
  echo "ERROR: App Store Connect API key not found at $APPLE_API_KEY_PATH"
  echo "       Set APPLE_API_KEY (key id) / APPLE_API_ISSUER / APPLE_API_KEY_PATH."
  exit 1
fi

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
# VITE_BILLING_ENABLED lights up the in-app purchase UI (Pro IAP). Without it the
# TestFlight build ships with billing dark and IAP cannot be tested. VITE_AI_PROXY_URL
# is read from .env by Vite (inline VITE_* env vars take priority in loadEnv).
VITE_BILLING_ENABLED=true pnpm tauri ios build 2>&1 | tail -3 || true

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
  -exportPath /tmp/markflow-export \
  -authenticationKeyPath "$APPLE_API_KEY_PATH" \
  -authenticationKeyID "$APPLE_API_KEY" \
  -authenticationKeyIssuerID "$APPLE_API_ISSUER" 2>&1 | tail -5

echo "=== Done ==="
