# Whisper GUI — task runner
# Install just: https://github.com/casey/just
#
# Usage:
#   just           — list all recipes
#   just dev       — run full dev stack (API + UI) in parallel
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
    @command -v node     >/dev/null && echo "  node:    $(node --version)" || echo "  node:    MISSING  →  https://nodejs.org"
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

# Install all dependencies — Python backend + Node frontend (recommended for first setup)
install: _install-python install-playwright install-ui
    @echo ""
    @echo "Done. Run \`just dev\` to start the dev servers."

# Install only Python deps into backend/.venv
_install-python:
    cd backend && uv sync

# Install Playwright's Chromium browser (required by the webpage extractor)
install-playwright:
    cd backend && uv run playwright install chromium

# Install frontend npm dependencies
install-ui:
    cd frontend && npm install

# ── Local Development ─────────────────────────────────────────────────────────

# Pre-download / update the configured model locally (outside Docker)
download:
    cd backend && uv run python download_models.py

# Run only the API server with hot-reload (no model pre-download — use when model already cached)
# Uses `python -m uvicorn` so reload subprocesses inherit the correct venv Python.
dev-api:
    cd backend && uv run python -m uvicorn main:app \
        --reload \
        --reload-exclude '.venv' \
        --reload-exclude 'cache' \
        --reload-exclude 'static' \
        --reload-exclude '*.pyc' \
        --reload-exclude '__pycache__' \
        --log-level warning \
        --port "${APP_PORT:-8080}"

# Run only the Vite dev server (proxies /api to API server).
# Auto-installs npm deps if node_modules is missing.
# Passes API_PORT so vite.config.ts proxies to the correct port.
dev-ui:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -d frontend/node_modules ]; then
        echo "node_modules not found — running npm install..."
        cd frontend && npm install
    fi
    cd frontend && API_PORT="${APP_PORT:-8080}" npm run dev

# Build the React frontend into backend/static/
build-ui:
    cd frontend && npm run build

# Run the full dev stack: API server + Vite dev server in parallel.
# Use this for active frontend work. Open http://localhost:5173 (Vite proxies /api).
dev:
    @echo "Starting API server on :${APP_PORT:-8080} and Vite dev server on :5173"
    @trap 'kill 0' EXIT; \
        just dev-api & \
        just dev-ui & \
        wait

# Run API server with model pre-download (mirrors Docker entrypoint — use for backend-only work)
dev-backend: download
    cd backend && uv run python -m uvicorn main:app \
        --reload \
        --reload-exclude '.venv' \
        --reload-exclude 'cache' \
        --reload-exclude 'static' \
        --reload-exclude '*.pyc' \
        --reload-exclude '__pycache__' \
        --log-level warning \
        --port "${APP_PORT:-8080}"

# Run dev server without hot-reload (quieter, no watchfiles)
dev-no-reload: download
    cd backend && uv run python -m uvicorn main:app \
        --port "${APP_PORT:-8080}"

# ── Docker: Build ─────────────────────────────────────────────────────────────

# Build the Docker image
build:
    docker compose {{ _compose_files }} build

# Force a full rebuild with no layer cache
rebuild:
    docker compose {{ _compose_files }} build --no-cache

# ── Playwright base ────────────────────────────────────────────────────────────

# Extract the locked playwright version from uv.lock
_playwright-version:
    @grep -A2 '^name = "playwright"$' backend/uv.lock | grep '^version' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'

# Build and push the playwright+ffmpeg base image.
# Only needs rebuilding when the playwright version in uv.lock or ffmpeg changes.
build-playwright-base:
    #!/usr/bin/env bash
    set -euo pipefail
    registry="${DOCKER_REGISTRY:-}"
    if [[ -z "$registry" ]]; then
        echo "Error: DOCKER_REGISTRY not set in .env"
        exit 1
    fi
    version=$(just _playwright-version)
    echo "Building playwright base (playwright==${version})..."
    docker buildx build \
        --platform linux/amd64 \
        --file backend/Dockerfile.playwright-base \
        --build-arg PLAYWRIGHT_VERSION="${version}" \
        --provenance=false \
        --tag "${registry}:playwright-base" \
        --push \
        .
    echo "✓ Pushed ${registry}:playwright-base"

# ── Docker: Run ───────────────────────────────────────────────────────────────

# Start the app in the background (builds image if needed)
up:
    docker compose {{ _compose_files }} up --build -d
    @echo ""
    @echo "Distill running at http://localhost:${APP_PORT:-8080}"
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
    docker compose logs -f lumina

# Open a bash shell inside the running container
shell:
    docker compose exec lumina bash

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

# ── Release ─────────────────────────────────────────────────────────────

# Generate CalVer version (YYYY.MM.DD or YYYY.MM.DD.N if tag exists)
_calver:
    #!/usr/bin/env bash
    base=$(date +%Y.%m.%d)
    # Check if base tag exists; if so, find next increment
    if git rev-parse "v${base}" >/dev/null 2>&1; then
        n=1
        while git rev-parse "v${base}.${n}" >/dev/null 2>&1; do
            ((n++))
        done
        echo "${base}.${n}"
    else
        echo "${base}"
    fi

# Build and push a release to DOCKER_REGISTRY (reads from .env)
release:
    #!/usr/bin/env bash
    set -euo pipefail

    registry="${DOCKER_REGISTRY:-}"
    if [[ -z "$registry" ]]; then
        echo "Error: DOCKER_REGISTRY not set in .env"
        exit 1
    fi

    # Abort if there are uncommitted changes
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "Error: uncommitted changes — commit or stash before releasing"
        exit 1
    fi

    version=$(just _calver)
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Releasing lumina v${version}"
    echo "  Registry: ${registry}"
    echo "═══════════════════════════════════════════════════════════════"

    # Build for linux/amd64 and push (context is repo root, Dockerfile in backend/).
    # --provenance=false produces a single-manifest image (required by some registries).
    # --cache-from/to reuses layers from the previous release to avoid re-downloading.
    docker buildx build \
        --platform linux/amd64 \
        --file backend/Dockerfile \
        --build-arg PLAYWRIGHT_BASE_IMAGE="${registry}:playwright-base" \
        --provenance=false \
        --cache-from "type=registry,ref=${registry}:buildcache" \
        --cache-to   "type=registry,ref=${registry}:buildcache,mode=max" \
        --tag "${registry}:${version}" \
        --tag "${registry}:latest" \
        --push \
        .

    # Tag the commit
    git tag -a "v${version}" -m "Release v${version}"
    git push origin "v${version}"

    echo ""
    echo "✓ Pushed ${registry}:${version}"
    echo "✓ Pushed ${registry}:latest"
    echo "✓ Tagged v${version}"

# Build and push a release with canary/NeMo support
release-canary:
    #!/usr/bin/env bash
    set -euo pipefail

    registry="${DOCKER_REGISTRY:-}"
    if [[ -z "$registry" ]]; then
        echo "Error: DOCKER_REGISTRY not set in .env"
        exit 1
    fi

    # Abort if there are uncommitted changes
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "Error: uncommitted changes — commit or stash before releasing"
        exit 1
    fi

    version=$(just _calver)
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Releasing lumina v${version}-canary"
    echo "  Registry: ${registry}"
    echo "═══════════════════════════════════════════════════════════════"

    # Build for linux/amd64 with canary support and push
    docker buildx build \
        --platform linux/amd64 \
        --file backend/Dockerfile \
        --build-arg INSTALL_CANARY=true \
        --build-arg PLAYWRIGHT_BASE_IMAGE="${registry}:playwright-base" \
        --provenance=false \
        --cache-from "type=registry,ref=${registry}:buildcache-canary" \
        --cache-to   "type=registry,ref=${registry}:buildcache-canary,mode=max" \
        --tag "${registry}:${version}-canary" \
        --tag "${registry}:canary" \
        --push \
        .

    # Tag the commit
    git tag -a "v${version}-canary" -m "Release v${version}-canary"
    git push origin "v${version}-canary"

    echo ""
    echo "✓ Pushed ${registry}:${version}-canary"
    echo "✓ Pushed ${registry}:canary"
    echo "✓ Tagged v${version}-canary"
