#!/bin/bash
# MarkFlow Auto-Recovery Script
# Runs independently via LaunchAgent to update the app even if it can't launch.
# Checks GitHub releases for newer versions and installs them.

APP_PATH="/Applications/MarkFlow.app"
REPO="momocham922/markflow"
LOG_PREFIX="[markflow-recovery]"

# Determine channel from installed version
get_installed_version() {
  if [ -f "$APP_PATH/Contents/Info.plist" ]; then
    /usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist" 2>/dev/null
  fi
}

INSTALLED=$(get_installed_version)
if [ -z "$INSTALLED" ]; then
  echo "$LOG_PREFIX App not found at $APP_PATH"
  exit 0
fi

# Check if app can actually launch (quick test)
APP_WORKS=true
if ! "$APP_PATH/Contents/MacOS/markflow" --version >/dev/null 2>&1; then
  APP_WORKS=false
  echo "$LOG_PREFIX App cannot launch — will force update"
fi

# Determine channel
if echo "$INSTALLED" | grep -q "beta"; then
  CHANNEL="beta"
  RELEASE_URL="https://api.github.com/repos/$REPO/releases/tags/beta"
else
  CHANNEL="stable"
  RELEASE_URL="https://api.github.com/repos/$REPO/releases/latest"
fi

# Fetch latest release info
RELEASE_JSON=$(curl -sf "$RELEASE_URL" 2>/dev/null)
if [ -z "$RELEASE_JSON" ]; then
  echo "$LOG_PREFIX Failed to fetch release info"
  exit 0
fi

# Extract version from tag
LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name".*"\(.*\)".*/\1/' | sed 's/^v//')
if [ -z "$LATEST" ]; then
  echo "$LOG_PREFIX Could not parse latest version"
  exit 0
fi

echo "$LOG_PREFIX Installed: $INSTALLED, Latest: $LATEST, Channel: $CHANNEL"

# Compare versions (skip if same and app works)
if [ "$INSTALLED" = "$LATEST" ] && [ "$APP_WORKS" = true ]; then
  echo "$LOG_PREFIX Up to date"
  exit 0
fi

# Find DMG asset URL
DMG_URL=$(echo "$RELEASE_JSON" | grep '"browser_download_url"' | grep '\.dmg"' | head -1 | sed 's/.*"\(https[^"]*\)".*/\1/')
if [ -z "$DMG_URL" ]; then
  echo "$LOG_PREFIX No DMG found in release"
  exit 0
fi

echo "$LOG_PREFIX Downloading $DMG_URL"
TMP_DMG="/tmp/MarkFlow-update.dmg"
curl -fL -o "$TMP_DMG" "$DMG_URL" 2>/dev/null
if [ ! -f "$TMP_DMG" ]; then
  echo "$LOG_PREFIX Download failed"
  exit 1
fi

# Mount, copy, unmount
MOUNT_POINT=$(hdiutil attach "$TMP_DMG" -nobrowse -noverify 2>/dev/null | grep "/Volumes/" | awk '{print $NF}')
if [ -z "$MOUNT_POINT" ]; then
  echo "$LOG_PREFIX Failed to mount DMG"
  rm -f "$TMP_DMG"
  exit 1
fi

# Kill running app if any
pkill -x markflow 2>/dev/null
sleep 1

# Copy new app
rm -rf "$APP_PATH"
cp -R "$MOUNT_POINT/MarkFlow.app" "$APP_PATH"
hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null
rm -f "$TMP_DMG"

echo "$LOG_PREFIX Updated to $LATEST"
# Launch the updated app
open "$APP_PATH"
