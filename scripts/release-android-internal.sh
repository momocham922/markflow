#!/usr/bin/env bash
set -euo pipefail

# ─── Android Internal Testing Release Script ─────────────────
# Builds a signed AAB and uploads to Google Play Internal Testing.
# Similar to release-testflight.sh — one command to build & distribute.
#
# Prerequisites (one-time setup):
#   1. Google Play Developer Console: create app with package "com.markflow.editor"
#   2. Create a release signing keystore:
#      keytool -genkeypair -v \
#        -keystore ~/.android/markflow-release.keystore \
#        -storepass <PASSWORD> -alias markflow -keypass <PASSWORD> \
#        -keyalg RSA -keysize 2048 -validity 10000 \
#        -dname "CN=MarkFlow,O=MarkFlow,C=JP"
#   3. Google Play Developer API: create service account, download JSON key
#      Save to: ~/.android/play-api-key.json
#   4. pip install google-api-python-client google-auth (for upload)
#   5. Set env vars or use defaults below
#
# Usage:
#   ./scripts/release-android-internal.sh
# ──────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(jq -r .version "$ROOT/package.json")
echo "=== Android Internal Testing: v${VERSION} ==="

# Environment
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/27.0.12077973}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# Signing config
KEYSTORE="${ANDROID_KEYSTORE:-$HOME/.android/markflow-release.keystore}"
KEYSTORE_PASS="${ANDROID_KEYSTORE_PASS:-}"
KEY_ALIAS="${ANDROID_KEY_ALIAS:-markflow}"
KEY_PASS="${ANDROID_KEY_PASS:-}"

# Google Play API
PLAY_API_KEY="${PLAY_API_KEY:-$HOME/.android/play-api-key.json}"
PACKAGE_NAME="com.markflow.editor"

# ─── Validate prerequisites ───
if [ ! -f "$KEYSTORE" ]; then
  echo "ERROR: Release keystore not found at $KEYSTORE"
  echo ""
  echo "Create one with:"
  echo "  keytool -genkeypair -v \\"
  echo "    -keystore $KEYSTORE \\"
  echo "    -storepass <PASSWORD> -alias markflow -keypass <PASSWORD> \\"
  echo "    -keyalg RSA -keysize 2048 -validity 10000 \\"
  echo "    -dname \"CN=MarkFlow,O=MarkFlow,C=JP\""
  exit 1
fi

if [ -z "$KEYSTORE_PASS" ]; then
  echo "ERROR: ANDROID_KEYSTORE_PASS not set"
  echo "  export ANDROID_KEYSTORE_PASS=<your-keystore-password>"
  exit 1
fi

# ─── Version code ───
# Tauri generates versionCode from semver (e.g., 0.5.0 → 5000).
# Play Store requires strictly increasing versionCode, so we add a build counter.
VCODE_FILE="$ROOT/.android-version-code"
if [ -f "$VCODE_FILE" ]; then
  LAST_VCODE=$(cat "$VCODE_FILE")
else
  LAST_VCODE=5000
fi
NEXT_VCODE=$((LAST_VCODE + 1))
echo "$NEXT_VCODE" > "$VCODE_FILE"
export ANDROID_VERSION_CODE="$NEXT_VCODE"
echo "=== versionCode: $NEXT_VCODE ==="

# ─── Build ───
echo "=== Building Android AAB (aarch64) ==="
cd "$ROOT"
# VITE_BILLING_ENABLED lights up the in-app purchase UI (Pro IAP) — same as the
# iOS TestFlight build (release-testflight.sh). Without it the internal build ships
# with billing dark and the Play subscription flow cannot be tested. VITE_AI_PROXY_URL
# is read from .env by Vite (inline VITE_* env vars take priority in loadEnv).
VITE_BILLING_ENABLED=true pnpm tauri android build --target aarch64

AAB="src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab"
# Gradle names the APK by whether the release signingConfig applied. This build
# HAS one (app/build.gradle.kts), so the output is `app-universal-release.apk`,
# already signed — the `-unsigned` name only appears without a signing config.
# Looking for the latter alone silently skipped APK creation entirely.
APK_DIR="src-tauri/gen/android/app/build/outputs/apk/universal/release"
UNSIGNED_APK="$APK_DIR/app-universal-release-unsigned.apk"
GRADLE_APK="$APK_DIR/app-universal-release.apk"

if [ ! -f "$AAB" ]; then
  echo "ERROR: AAB not found at $AAB"
  exit 1
fi

# ─── Sign AAB with jarsigner ───
SIGNED_AAB="src-tauri/gen/android/app/build/outputs/bundle/universalRelease/MarkFlow_${VERSION}_arm64.aab"
cp "$AAB" "$SIGNED_AAB"

echo "=== Signing AAB ==="
jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 \
  -keystore "$KEYSTORE" \
  -storepass "$KEYSTORE_PASS" \
  -keypass "${KEY_PASS:-$KEYSTORE_PASS}" \
  "$SIGNED_AAB" "$KEY_ALIAS" 2>&1 | tail -3

# ─── Also produce a signed APK for direct distribution ───
# Used when someone needs the build before their Play tester invite lands. It
# must carry the SAME release key as the Play build, or Play cannot upgrade
# over a sideloaded install.
SIGNED_APK="$APK_DIR/MarkFlow_${VERSION}_arm64.apk"
BUILD_TOOLS="$ANDROID_HOME/build-tools/34.0.0"
if [ -f "$UNSIGNED_APK" ]; then
  cp "$UNSIGNED_APK" "$SIGNED_APK"
  "$BUILD_TOOLS/zipalign" -f 4 "$SIGNED_APK" "${SIGNED_APK}.aligned"
  mv "${SIGNED_APK}.aligned" "$SIGNED_APK"
  "$BUILD_TOOLS/apksigner" sign \
    --ks "$KEYSTORE" \
    --ks-pass "pass:$KEYSTORE_PASS" \
    --ks-key-alias "$KEY_ALIAS" \
    --key-pass "pass:${KEY_PASS:-$KEYSTORE_PASS}" \
    "$SIGNED_APK"
  echo "APK (signed here): $SIGNED_APK"
elif [ -f "$GRADLE_APK" ]; then
  cp "$GRADLE_APK" "$SIGNED_APK"
  echo "APK (signed by Gradle): $SIGNED_APK"
else
  echo "WARNING: no APK found in $APK_DIR — skipping direct-distribution APK"
fi

# Whatever produced it, prove the APK carries the release key before anyone
# installs it: a debug-signed APK would block the Play upgrade path later.
if [ -f "$SIGNED_APK" ]; then
  APK_SHA=$("$BUILD_TOOLS/apksigner" verify --print-certs "$SIGNED_APK" 2>/dev/null \
    | awk -F": " '/SHA-256 digest/ {print toupper($2); exit}')
  KS_SHA=$(keytool -list -v -keystore "$KEYSTORE" -alias "$KEY_ALIAS" \
    -storepass "$KEYSTORE_PASS" 2>/dev/null \
    | awk -F"SHA256: " '/SHA256:/ {gsub(/:/,"",$2); print toupper($2); exit}')
  if [ -z "$APK_SHA" ] || [ "$APK_SHA" != "$KS_SHA" ]; then
    echo "ERROR: APK signer does not match the release keystore"
    echo "  apk:      ${APK_SHA:-<unsigned>}"
    echo "  keystore: $KS_SHA"
    exit 1
  fi
  echo "APK signer verified against release keystore"
fi

# ─── Upload to Google Play Internal Testing ───
if [ ! -f "$PLAY_API_KEY" ]; then
  echo ""
  echo "=== Skipping Google Play upload (no API key) ==="
  echo "To enable automatic upload:"
  echo "  1. Create service account in Google Cloud Console"
  echo "  2. Grant access in Google Play Console → API access"
  echo "  3. Download JSON key to: $PLAY_API_KEY"
  echo ""
  echo "=== Build complete — upload AAB manually ==="
  echo "AAB: $SIGNED_AAB"
  echo ""
  echo "Upload via: https://play.google.com/console"
  echo "  → MarkFlow → Internal testing → Create new release → Upload AAB"

  # Also upload APK to GitHub beta release for sideloading
  echo ""
  echo "=== Uploading APK to GitHub beta release ==="
  if [ -f "$SIGNED_APK" ]; then
    gh release upload beta "$SIGNED_APK" --clobber 2>&1 || echo "GitHub upload skipped (release may not exist)"
  fi
  exit 0
fi

echo "=== Uploading to Google Play Internal Testing ==="
python3 - "$PLAY_API_KEY" "$PACKAGE_NAME" "$SIGNED_AAB" "$VERSION" <<'PYEOF'
import sys
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

key_file, package, aab_path, version = sys.argv[1:5]

credentials = service_account.Credentials.from_service_account_file(
    key_file, scopes=["https://www.googleapis.com/auth/androidpublisher"]
)
service = build("androidpublisher", "v3", credentials=credentials)

# Create edit
edit = service.edits().insert(body={}, packageName=package).execute()
edit_id = edit["id"]

# Upload AAB
media = MediaFileUpload(aab_path, mimetype="application/octet-stream", resumable=True)
upload = service.edits().bundles().upload(
    packageName=package, editId=edit_id, media_body=media
).execute()
version_code = upload["versionCode"]
print(f"Uploaded AAB: versionCode={version_code}")

# Assign to internal + alpha (closed testing) tracks
release_body = {"versionCodes": [str(version_code)], "status": "completed", "name": version, "releaseNotes": [{"language": "en-US", "text": f"v{version}"}]}
for track_name in ["internal", "alpha"]:
    service.edits().tracks().update(
        packageName=package, editId=edit_id, track=track_name,
        body={"track": track_name, "releases": [release_body]}
    ).execute()
    print(f"Staged on {track_name}: v{version} (versionCode={version_code})")

# COMMIT the edit — without this the uploaded bundle and track changes are
# discarded when the edit expires, so nothing ever reaches testers. (This was
# missing: every release after versionCode 5032 silently failed to publish.)
service.edits().commit(packageName=package, editId=edit_id).execute()
print(f"Committed edit {edit_id}: v{version} (versionCode={version_code}) is live on internal + alpha")
PYEOF

echo ""
echo "=== Done! Testers will receive update via Play Store ==="
