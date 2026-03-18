#!/bin/bash
set -e

# Start virtual display
Xvfb :99 -screen 0 1280x1024x24 &
sleep 1

# Start dbus
eval $(dbus-launch --sh-syntax)
export DBUS_SESSION_BUS_ADDRESS

# Serve the built frontend on port 1420 (debug Tauri binary loads from devUrl)
echo "=== Starting frontend dev server on port 1420 ==="
python3 -m http.server 1420 --directory /app/dist &
SERVE_PID=$!
# Wait for the server to be ready
for i in $(seq 1 10); do
  if curl -s http://localhost:1420 > /dev/null 2>&1; then
    echo "=== Frontend server ready ==="
    break
  fi
  sleep 0.5
done

# Find WebKitWebDriver path
WEBKIT_DRIVER=$(which WebKitWebDriver 2>/dev/null || find /usr -name WebKitWebDriver -type f 2>/dev/null | head -1)
echo "=== WebKitWebDriver at: ${WEBKIT_DRIVER:-NOT FOUND} ==="

# Start tauri-driver on port 4444
if [ -n "$WEBKIT_DRIVER" ]; then
  tauri-driver --native-driver "$WEBKIT_DRIVER" &
else
  tauri-driver &
fi
TAURI_DRIVER_PID=$!

# Wait for tauri-driver to be ready
echo "=== Waiting for tauri-driver to start... ==="
for i in $(seq 1 15); do
  if curl -s http://localhost:4444/status > /dev/null 2>&1; then
    echo "=== tauri-driver is ready (PID: $TAURI_DRIVER_PID) ==="
    break
  fi
  if ! kill -0 $TAURI_DRIVER_PID 2>/dev/null; then
    echo "=== tauri-driver exited unexpectedly ==="
    exit 1
  fi
  sleep 1
done

echo "=== Running E2E tests ==="

# Run WebDriverIO tests
cd /app
npx wdio run wdio.conf.ts
TEST_EXIT=$?

# Cleanup
kill $TAURI_DRIVER_PID 2>/dev/null || true

exit $TEST_EXIT
