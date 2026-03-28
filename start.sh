#!/usr/bin/env bash
# start.sh — Launch Whisper GUI.
# Reads ENABLE_GPU from .env and automatically includes the GPU compose override.
# Any extra arguments are forwarded to `docker compose up` (e.g. -d, --build).
set -euo pipefail

if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
else
  echo "Warning: .env not found — using defaults."
fi

ENABLE_GPU="${ENABLE_GPU:-false}"

if [ "$ENABLE_GPU" = "true" ]; then
  echo "[start] GPU mode enabled."
  exec docker compose \
    -f docker-compose.yml \
    -f docker-compose.gpu.yml \
    up "$@"
else
  echo "[start] CPU mode."
  exec docker compose \
    -f docker-compose.yml \
    up "$@"
fi
