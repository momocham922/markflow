#!/bin/bash
##
## Publish auto-update manifests + artifacts to the self-hosted GCS bucket
## (served at markflow.jp/updates/…). This is the distribution channel that
## replaces public GitHub Releases so the GitHub repo can be made PRIVATE
## without breaking the app's auto-updater (decision #1).
##
## Usage:
##   ./scripts/release-updates-gcs.sh beta      # publish beta channel
##   ./scripts/release-updates-gcs.sh stable    # publish stable channel
##
## Prerequisites:
##   1. Version already bumped via bump-version.sh
##   2. Signed macOS build completed (same artifacts as release-beta/stable.sh)
##   3. GCS bucket exists + is public-read + markflow-site /updates route is live
##      (one-time setup — see MONETIZATION.md §8 distribution-migration runbook)
##   4. gcloud/gsutil authenticated for account with bucket write (ga.crossmedia)
##
## Env overrides:
##   MARKFLOW_UPDATE_BUCKET  (default: markflow-updates)
##   MARKFLOW_UPDATE_BASEURL (default: https://markflow.jp/updates)
##   GCLOUD_ACCOUNT          (default: ga.crossmedia@gmail.com; "" = active acct)
##
## Layout produced:
##   gs://<bucket>/latest.json                         (stable manifest)
##   gs://<bucket>/beta.json                           (beta manifest)
##   gs://<bucket>/<channel>/MarkFlow.app.tar.gz       (macOS updater payload)
##   gs://<bucket>/<channel>/MarkFlow_<ver>_aarch64.dmg
##   gs://<bucket>/<channel>/MarkFlow_<ver>_x64-setup.exe   (Windows, if available)
##

set -euo pipefail

CHANNEL="${1:-beta}"
if [ "$CHANNEL" != "beta" ] && [ "$CHANNEL" != "stable" ]; then
  echo "ERROR: channel must be 'beta' or 'stable' (got '$CHANNEL')"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUCKET="${MARKFLOW_UPDATE_BUCKET:-markflow-updates}"
BASEURL="${MARKFLOW_UPDATE_BASEURL:-https://markflow.jp/updates}"
# markflow-app-2026 ops must pin the authorized account (active acct drifts across
# parallel Claude windows). Set GCLOUD_ACCOUNT="" to use the active account.
# gsutil honors the active gcloud account, so pin it explicitly before uploading.
ACCOUNT="${GCLOUD_ACCOUNT-ga.crossmedia@gmail.com}"
if [ -n "$ACCOUNT" ]; then
  echo "Using gcloud account: $ACCOUNT"
  gcloud config set account "$ACCOUNT" >/dev/null 2>&1 || true
fi

VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
if [ "$CHANNEL" = "beta" ]; then
  MANIFEST="beta.json"
else
  MANIFEST="latest.json"
fi
echo "=== GCS update publish: channel=$CHANNEL v${VERSION} → gs://${BUCKET} ==="

# --- macOS artifacts (required) ---
DMG="src-tauri/target/release/bundle/dmg/MarkFlow_${VERSION}_aarch64.dmg"
TAR="src-tauri/target/release/bundle/macos/MarkFlow.app.tar.gz"
SIG="src-tauri/target/release/bundle/macos/MarkFlow.app.tar.gz.sig"
for f in "$DMG" "$TAR" "$SIG"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: Missing artifact: $f"
    echo "Run signed build first:"
    echo '  TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/markflow.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm tauri build'
    exit 1
  fi
done
MAC_SIG=$(cat "$SIG")

# --- Windows artifacts (optional; built by CI). During the transition window we
#     mirror them from the GitHub beta release. Once the repo is private, place
#     the exe + .sig locally at the paths below before running. ---
WIN_EXE_NAME="MarkFlow_${VERSION}_x64-setup.exe"
WIN_EXE_LOCAL="src-tauri/target/release/bundle/nsis/${WIN_EXE_NAME}"
WIN_SIG_LOCAL="${WIN_EXE_LOCAL}.sig"
WIN_SIG=""
if [ -f "$WIN_EXE_LOCAL" ] && [ -f "$WIN_SIG_LOCAL" ]; then
  WIN_SIG=$(cat "$WIN_SIG_LOCAL")
  echo "Using local Windows artifact: $WIN_EXE_LOCAL"
fi
# Transition helper: pull Windows exe+sig from the GitHub beta release if present.
if [ -z "$WIN_SIG" ] && [ "$CHANNEL" = "beta" ] && command -v gh >/dev/null 2>&1; then
  if gh release download beta --pattern "${WIN_EXE_NAME}" --dir /tmp --clobber 2>/dev/null \
     && gh release download beta --pattern "${WIN_EXE_NAME}.sig" --dir /tmp --clobber 2>/dev/null; then
    WIN_EXE_LOCAL="/tmp/${WIN_EXE_NAME}"
    WIN_SIG=$(cat "/tmp/${WIN_EXE_NAME}.sig")
    echo "Mirrored Windows artifact from GitHub beta release"
  fi
fi

# --- Generate manifest with markflow.jp/updates URLs ---
python3 - "$MANIFEST" "$VERSION" "$CHANNEL" "$BASEURL" "$MAC_SIG" "$WIN_SIG" "$WIN_EXE_NAME" <<'PY'
import json, sys, datetime
manifest, version, channel, baseurl, mac_sig, win_sig, win_exe = sys.argv[1:8]
data = {
    "version": version,
    "notes": ("Beta release v%s" % version) if channel == "beta" else ("MarkFlow v%s" % version),
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {},
}
data["platforms"]["darwin-aarch64"] = {
    "signature": mac_sig,
    "url": "%s/%s/MarkFlow.app.tar.gz" % (baseurl, channel),
}
if win_sig.strip():
    data["platforms"]["windows-x86_64"] = {
        "signature": win_sig.strip(),
        "url": "%s/%s/%s" % (baseurl, channel, win_exe),
    }
open(manifest, "w").write(json.dumps(data, indent=2))
print("Generated %s (%s)" % (manifest, ", ".join(data["platforms"].keys())))
PY

# --- Upload artifacts (channel subdir) + manifest (bucket root) ---
GS="gs://${BUCKET}"
echo "Uploading artifacts to ${GS}/${CHANNEL}/ …"
gsutil -h "Cache-Control:public, max-age=31536000, immutable" cp "$TAR" "${GS}/${CHANNEL}/MarkFlow.app.tar.gz"
gsutil -h "Cache-Control:public, max-age=31536000, immutable" cp "$DMG" "${GS}/${CHANNEL}/MarkFlow_${VERSION}_aarch64.dmg"
if [ -n "$WIN_SIG" ] && [ -f "$WIN_EXE_LOCAL" ]; then
  gsutil -h "Cache-Control:public, max-age=31536000, immutable" cp "$WIN_EXE_LOCAL" "${GS}/${CHANNEL}/${WIN_EXE_NAME}"
fi
echo "Uploading manifest ${MANIFEST} to ${GS}/ …"
# Manifests must never be served stale — no-cache so a new release is seen at once.
gsutil -h "Cache-Control:no-cache, max-age=0" cp "$MANIFEST" "${GS}/${MANIFEST}"

rm -f "$MANIFEST"

echo ""
echo "=== Published ${CHANNEL} channel v${VERSION} to ${GS} ==="
echo "Verify:  curl -fsS ${BASEURL}/${MANIFEST} | head -c 400"
