#!/bin/bash
##
## Entrypoint for sync E2E test containers.
## Starts Xvfb + dev server + tauri-driver, then exposes via socat on 0.0.0.0.
## Docker Compose maps external ports to differentiate instances.
##
set -e

# Start virtual display
Xvfb :99 -screen 0 1280x1024x24 &
sleep 1

# Start dbus
eval $(dbus-launch --sh-syntax)
export DBUS_SESSION_BUS_ADDRESS

# Serve the built frontend
echo "=== Starting frontend server on port 1420 ==="
python3 -m http.server 1420 --directory /app/dist &
for i in $(seq 1 10); do
  curl -s http://localhost:1420 > /dev/null 2>&1 && break
  sleep 0.5
done
echo "=== Frontend server ready ==="

# Find WebKitWebDriver
WEBKIT_DRIVER=$(which WebKitWebDriver 2>/dev/null || find /usr -name WebKitWebDriver -type f 2>/dev/null | head -1)
echo "=== WebKitWebDriver at: ${WEBKIT_DRIVER:-NOT FOUND} ==="

# Start tauri-driver on internal port 14444 (127.0.0.1 only)
INTERNAL_PORT=14444
echo "=== Starting tauri-driver on internal port $INTERNAL_PORT ==="
if [ -n "$WEBKIT_DRIVER" ]; then
  tauri-driver --port $INTERNAL_PORT --native-driver "$WEBKIT_DRIVER" &
else
  tauri-driver --port $INTERNAL_PORT &
fi
TAURI_DRIVER_PID=$!

# Wait for tauri-driver to be ready
for i in $(seq 1 15); do
  if curl -s "http://localhost:$INTERNAL_PORT/status" > /dev/null 2>&1; then
    echo "=== tauri-driver ready (PID: $TAURI_DRIVER_PID) ==="
    break
  fi
  if ! kill -0 $TAURI_DRIVER_PID 2>/dev/null; then
    echo "=== tauri-driver exited unexpectedly ==="
    exit 1
  fi
  sleep 1
done

# Expose on 0.0.0.0:4444 via socat (tauri-driver binds to 127.0.0.1 only)
echo "=== Exposing tauri-driver on 0.0.0.0:4444 via socat ==="
socat TCP-LISTEN:4444,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:$INTERNAL_PORT &
SOCAT_PID=$!

echo "=== Container ready. Waiting for WebDriver connections ==="
wait $TAURI_DRIVER_PID
