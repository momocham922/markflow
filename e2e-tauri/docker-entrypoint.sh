#!/bin/bash
set -e

# Start virtual display
Xvfb :99 -screen 0 1280x1024x24 &
sleep 1

# Start dbus
eval $(dbus-launch --sh-syntax)
export DBUS_SESSION_BUS_ADDRESS

# Start tauri-driver on port 4444
tauri-driver &
TAURI_DRIVER_PID=$!
sleep 2

echo "=== tauri-driver started (PID: $TAURI_DRIVER_PID) ==="
echo "=== Running E2E tests ==="

# Run WebDriverIO tests
cd /app
npx wdio run wdio.conf.ts
TEST_EXIT=$?

# Cleanup
kill $TAURI_DRIVER_PID 2>/dev/null || true

exit $TEST_EXIT
