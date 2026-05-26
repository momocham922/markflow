#!/usr/bin/env bash
set -euo pipefail

# ─── Android APK Release Script ──────────────────────────────
# Builds a signed APK for direct distribution (sideloading).
# Google Play AAB upload is separate (future).
#
# Prerequisites:
#   brew install openjdk@17
#   Android SDK + NDK installed at ~/Library/Android/sdk
#   Rust targets: aarch64-linux-android
#
# Usage:
#   ./scripts/release-android.sh
# ──────────────────────────────────────────────────────────────

VERSION=$(jq -r .version package.json)
echo "=== Android release: v${VERSION} ==="

# Environment
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/27.0.12077973}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# Keystore for APK signing (debug keystore for now)
KEYSTORE="${ANDROID_KEYSTORE:-$HOME/.android/debug.keystore}"
KEYSTORE_PASS="${ANDROID_KEYSTORE_PASS:-android}"
KEY_ALIAS="${ANDROID_KEY_ALIAS:-androiddebugkey}"
KEY_PASS="${ANDROID_KEY_PASS:-android}"

# Build
echo "=== Building Android APK (aarch64) ==="
pnpm tauri android build --target aarch64

UNSIGNED_APK="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
SIGNED_APK="src-tauri/gen/android/app/build/outputs/apk/universal/release/MarkFlow_${VERSION}_arm64.apk"

if [ ! -f "$UNSIGNED_APK" ]; then
  echo "ERROR: APK not found at $UNSIGNED_APK"
  exit 1
fi

# Ensure debug keystore exists
if [ ! -f "$KEYSTORE" ]; then
  echo "=== Creating debug keystore ==="
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" \
    -storepass "$KEYSTORE_PASS" \
    -alias "$KEY_ALIAS" \
    -keypass "$KEY_PASS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=MarkFlow Debug,O=MarkFlow,C=JP"
fi

# Sign APK
echo "=== Signing APK ==="
cp "$UNSIGNED_APK" "$SIGNED_APK"

# zipalign first
"$ANDROID_HOME/build-tools/34.0.0/zipalign" -f 4 "$SIGNED_APK" "${SIGNED_APK}.aligned"
mv "${SIGNED_APK}.aligned" "$SIGNED_APK"

# apksigner
"$ANDROID_HOME/build-tools/34.0.0/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-pass "pass:$KEYSTORE_PASS" \
  --ks-key-alias "$KEY_ALIAS" \
  --key-pass "pass:$KEY_PASS" \
  "$SIGNED_APK"

echo ""
echo "=== Android release v${VERSION} complete ==="
echo ""
echo "APK (signed): $SIGNED_APK"
echo "AAB (unsigned): src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab"
echo ""
echo "To install on device:"
echo "  adb install $SIGNED_APK"
