# Whisper GUI — task runner
# Install just: https://github.com/casey/just
#
# Usage:
#   just           — list all recipes
#   just dev       — run dev server locally
#   just up        — start via Docker (reads .env)

set dotenv-load  # auto-load .env from project root
set shell := ["bash", "-euo", "pipefail", "-c"]

# Pick the right compose files based on ENABLE_GPU in .env
_compose_files := if env_var_or_default("ENABLE_GPU", "false") == "true" {
    "-f docker-compose.yml -f docker-compose.gpu.yml"
} else {
    "-f docker-compose.yml"
}

# Show available recipes
default:
    @just --list

# ── Setup ─────────────────────────────────────────────────────────────────────

# Verify required tools are installed
check:
    @echo "── Tool check ──────────────────────────────────"
    @command -v uv       >/dev/null && echo "  uv:      $(uv --version)" || echo "  uv:      MISSING  →  https://docs.astral.sh/uv/getting-started/installation"
    @command -v docker   >/dev/null && echo "  docker:  $(docker --version)" || echo "  docker:  MISSING"
    @command -v just     >/dev/null && echo "  just:    $(just --version)" || echo "  just:    MISSING  →  https://github.com/casey/just"
    @command -v ffmpeg   >/dev/null && echo "  ffmpeg:  ok" || echo "  ffmpeg:  missing (required for local dev, bundled in Docker)"
    @echo "── GPU ─────────────────────────────────────────"
    @command -v nvidia-smi >/dev/null \
        && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | awk '{print "  GPU:     " $0}' \
        || echo "  GPU:     not detected — CPU-only mode"
    @echo "── Config (.env) ───────────────────────────────"
    @echo "  ENGINE:  ${TRANSCRIPTION_ENGINE:-faster-whisper}"
    @echo "  MODEL:   ${WHISPER_MODEL_SIZE:-large-v3}"
    @echo "  GPU:     ${ENABLE_GPU:-false}"
    @echo "  PORT:    ${APP_PORT:-8080}"

# Install Python 3.13 and sync all deps into backend/.venv
install:
    cd backend && uv sync
    @echo ""
    @echo "Done. To activate locally:"
    @echo "  source backend/.venv/bin/activate"

# ── Local Development ─────────────────────────────────────────────────────────

# Pre-download / update the configured model locally (outside Docker)
download:
    cd backend && uv run python download_models.py

# Run the dev server locally with hot-reload (uses env vars from .env).
# Downloads the model first (mirrors entrypoint.sh) so uvicorn's file watcher
# doesn't restart the server mid-download and loop forever.
dev: download
    cd backend && uv run uvicorn main:app \
        --reload \
        --reload-exclude '.venv' \
        --reload-exclude 'cache' \
        --reload-exclude '*.pyc' \
        --reload-exclude '__pycache__' \
        --log-level warning \
        --port "${APP_PORT:-8080}"

# Run dev server without hot-reload (quieter, no watchfiles)
dev-no-reload: download
    cd backend && uv run uvicorn main:app \
        --port "${APP_PORT:-8080}"

# ── Docker: Build ─────────────────────────────────────────────────────────────

# Build the Docker image
build:
    docker compose {{ _compose_files }} build

# Force a full rebuild with no layer cache
rebuild:
    docker compose {{ _compose_files }} build --no-cache

# ── Docker: Run ───────────────────────────────────────────────────────────────

# Start the app in the background (builds image if needed)
up:
    docker compose {{ _compose_files }} up --build -d
    @echo ""
    @echo "Whisper GUI running at http://localhost:${APP_PORT:-8080}"
    @echo "  just logs   — tail logs"
    @echo "  just down   — stop"

# Start in the foreground (useful for debugging — Ctrl-C to stop)
up-fg:
    docker compose {{ _compose_files }} up --build

# Stop the app
down:
    docker compose {{ _compose_files }} down

# Stop the app and remove anonymous volumes
down-volumes:
    docker compose {{ _compose_files }} down -v

# Restart the app (stop → build → start)
restart: down up

# ── Docker: Inspect ───────────────────────────────────────────────────────────

# Tail live container logs
logs:
    docker compose logs -f whisper-gui

# Open a bash shell inside the running container
shell:
    docker compose exec whisper-gui bash

# Show running container status
status:
    docker compose {{ _compose_files }} ps

# Print the resolved docker compose config (useful for debugging)
config:
    docker compose {{ _compose_files }} config

# ── Maintenance ───────────────────────────────────────────────────────────────

# Delete cached audio uploads to free disk space
clean-audio:
    rm -rf volumes/audio_cache/*
    @echo "Audio cache cleared."

# Delete all downloaded model weights (re-downloaded on next start)
clean-models:
    @echo "This will delete all model weights in volumes/models/ and require a re-download."
    @read -p "Continue? [y/N] " confirm && [ "$$confirm" = "y" ]
    rm -rf volumes/models/*
    @echo "Model cache cleared."

# Delete all volume data (audio + models)
clean-all: clean-audio
    rm -rf volumes/models/*
    @echo "All volume data cleared."
