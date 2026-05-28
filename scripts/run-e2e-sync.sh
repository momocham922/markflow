#!/bin/bash
##
## Run multi-instance sync E2E tests.
## Launches 2 Tauri containers via Docker Compose,
## then runs WebDriverIO multiremote tests from the host.
##
## Usage:
##   ./scripts/run-e2e-sync.sh [--rebuild]
##
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Default test account credentials (created via Firebase Auth REST API)
export TEST_USER_A_EMAIL="${TEST_USER_A_EMAIL:-test-sync-a@markflow.app}"
export TEST_USER_A_PASSWORD="${TEST_USER_A_PASSWORD:-MF-e2e-test-2026!}"
export TEST_USER_B_EMAIL="${TEST_USER_B_EMAIL:-test-sync-b@markflow.app}"
export TEST_USER_B_PASSWORD="${TEST_USER_B_PASSWORD:-MF-e2e-test-2026!}"

echo "=== Sync E2E: User A = $TEST_USER_A_EMAIL ==="
echo "=== Sync E2E: User B = $TEST_USER_B_EMAIL ==="

# Build or reuse images
if [[ "$1" == "--rebuild" ]]; then
  echo "=== Building sync E2E Docker images (forced rebuild)... ==="
  docker compose -f docker-compose.e2e-sync.yml build --no-cache
else
  echo "=== Building sync E2E Docker images (cached)... ==="
  docker compose -f docker-compose.e2e-sync.yml build
fi

# Start containers in background
echo "=== Starting containers (app-a, app-b)... ==="
docker compose -f docker-compose.e2e-sync.yml up -d

# Wait for both tauri-driver instances to be ready
echo "=== Waiting for tauri-driver instances... ==="
for port in 4444 4445; do
  for i in $(seq 1 30); do
    if curl -s "http://localhost:$port/status" > /dev/null 2>&1; then
      echo "  tauri-driver on port $port ready"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "  ERROR: tauri-driver on port $port did not start"
      docker compose -f docker-compose.e2e-sync.yml logs
      docker compose -f docker-compose.e2e-sync.yml down
      exit 1
    fi
    sleep 2
  done
done

echo "=== Running sync E2E tests... ==="

# Run WebDriverIO multiremote tests from host
TEST_EXIT=0
npx wdio run wdio.sync.conf.ts || TEST_EXIT=$?

# Cleanup
echo "=== Stopping containers... ==="
docker compose -f docker-compose.e2e-sync.yml down

if [ $TEST_EXIT -eq 0 ]; then
  echo "=== Sync E2E tests PASSED! ==="
else
  echo "=== Sync E2E tests FAILED (exit code: $TEST_EXIT) ==="
fi

exit $TEST_EXIT
