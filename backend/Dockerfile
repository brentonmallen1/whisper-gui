# Global build args must be declared before the first FROM so they can be used
# in FROM and COPY --from instructions across all stages.
ARG PLAYWRIGHT_BASE_IMAGE=registry.mallen.us/lumina:playwright-base

# ── Stage 0: Playwright base alias ───────────────────────────────────────────
# Docker doesn't support variable expansion in COPY --from, so we alias the
# configurable base image as a named stage here.
FROM ${PLAYWRIGHT_BASE_IMAGE} AS playwright-base

# ── Stage 1: Build React frontend ────────────────────────────────────────────
FROM node:20-slim AS node-builder

WORKDIR /repo/frontend

# Install dependencies in a cached layer (only re-runs when manifests change)
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --prefer-offline --no-audit --progress=false

# Copy source and build
# vite.config.ts sets outDir: '../backend/static', which resolves to /repo/backend/static
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Python builder ───────────────────────────────────────────────────
# build-essential and cargo (~800MB) are only needed to compile native Python
# extensions. They are NOT present in the final image.
FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04 AS python-builder

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git \
        curl \
        build-essential \
        cargo && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

WORKDIR /app
ENV VIRTUAL_ENV=/opt/venv
ENV UV_PROJECT_ENVIRONMENT=/opt/venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

ARG INSTALL_CANARY=false

# Install Python 3.12, create the virtualenv, and install torch.
# Torch is large and rarely changes — keep it in its own cached layer.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv python install 3.12 && \
    uv venv --python 3.12 $VIRTUAL_ENV && \
    uv pip install \
        "torch>=2.6.0" \
        "torchaudio>=2.6.0" \
        --index-url https://download.pytorch.org/whl/cu126

# Copy dependency manifests — this layer only re-runs when they change
COPY backend/pyproject.toml backend/uv.lock ./

RUN --mount=type=cache,target=/root/.cache/uv \
    if [ "$INSTALL_CANARY" = "true" ]; then \
        uv sync --frozen --no-install-project --extra canary; \
    else \
        uv sync --frozen --no-install-project; \
    fi

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
# Uses the CUDA base so GPU inference works. Chromium and ffmpeg are copied in
# from the lightweight playwright-base (ubuntu:24.04, ~1 GB) rather than being
# downloaded here, so releases don't re-fetch ~400 MB of browser binary.
#
# Build / refresh the playwright base first:  just build-playwright-base
FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04

ARG DEBIAN_FRONTEND=noninteractive

# System packages + Chromium OS dependencies.
# The Chromium deps below match playwright's Ubuntu 24.04 (noble) requirements.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git \
        curl \
        xz-utils \
        fonts-liberation \
        libasound2t64 \
        libatk-bridge2.0-0t64 \
        libatk1.0-0t64 \
        libcups2t64 \
        libdbus-1-3 \
        libgbm1 \
        libglib2.0-0t64 \
        libgtk-3-0t64 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libvulkan1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxfixes3 \
        libxi6 \
        libxkbcommon0 \
        libxrandr2 \
        libxss1 \
        libxtst6 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Copy Chromium browser binary and ffmpeg from the lightweight playwright base.
# Only these files are extracted — the ubuntu:24.04 layers themselves are not
# added to this image.
COPY --from=playwright-base /ms-playwright /ms-playwright
COPY --from=playwright-base /usr/local/bin/ffmpeg  /usr/local/bin/ffmpeg
COPY --from=playwright-base /usr/local/bin/ffprobe /usr/local/bin/ffprobe

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# The virtualenv's Python binary symlinks into the uv-managed Python directory,
# so both must be copied together from the builder for the links to resolve.
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
COPY --from=python-builder /root/.local/share/uv/python /root/.local/share/uv/python
COPY --from=python-builder /opt/venv /opt/venv

WORKDIR /app

ENV TZ=UTC
# Override with your local timezone, e.g. TZ=America/New_York

# ── Application source ────────────────────────────────────────────────────────
COPY backend/ .
COPY --from=node-builder /repo/backend/static ./static

RUN chmod +x entrypoint.sh && mkdir -p /models/hf /models/whisper /cache/audio /data

EXPOSE 8000

ENTRYPOINT ["./entrypoint.sh"]
