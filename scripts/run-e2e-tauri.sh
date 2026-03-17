#!/bin/bash
##
## Run real Tauri E2E tests inside a Docker container
## Usage: ./scripts/run-e2e-tauri.sh [--rebuild]
##
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
IMAGE_NAME="markflow-e2e"

cd "$PROJECT_DIR"

# Build Docker image
if [[ "$1" == "--rebuild" ]] || ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  echo "=== Building E2E test Docker image (this may take a while on first run)... ==="
  docker build -f Dockerfile.e2e -t "$IMAGE_NAME" .
else
  echo "=== Using cached Docker image. Use --rebuild to force rebuild. ==="
fi

echo "=== Running Tauri E2E tests... ==="

# Run tests
docker run --rm \
  -e DISPLAY=:99 \
  "$IMAGE_NAME"

echo "=== E2E tests completed! ==="
