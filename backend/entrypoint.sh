#!/usr/bin/env bash
set -euo pipefail

# Ensure venv is on PATH (belt-and-suspenders for entrypoint)
export PATH="/opt/venv/bin:$PATH"

echo "========================================"
echo " Lumina"
echo "========================================"

echo "[entrypoint] Pre-downloading / verifying model weights..."
python /app/download_models.py

echo "[entrypoint] Starting server on :8000 ..."
exec uvicorn main:app --host 0.0.0.0 --port 8000
