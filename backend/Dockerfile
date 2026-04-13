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

# ── Stage 2: Python / CUDA runtime ───────────────────────────────────────────
FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git \
        curl \
        build-essential \
        cargo && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
# Static ffmpeg binary — avoids pulling in GTK, GL, and dozens of codec libs
RUN curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
    -o /tmp/ffmpeg.tar.xz && \
    tar -xf /tmp/ffmpeg.tar.xz -C /tmp && \
    mv /tmp/ffmpeg-*-static/ffmpeg /tmp/ffmpeg-*-static/ffprobe /usr/local/bin/ && \
    rm -rf /tmp/*

# Install uv from official distroless image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Install Python 3.12 via uv and create project virtualenv
WORKDIR /app
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

ENV UV_CACHE_DIR=/tmp/uv-cache
ENV PIP_NO_CACHE_DIR=1

RUN uv python install 3.12 && \
    uv venv --python 3.12 $VIRTUAL_ENV && \
    uv pip install \
        torch>=2.6.0 \
        torchaudio>=2.6.0 \
        --index-url https://download.pytorch.org/whl/cu126

# ── Install project dependencies ─────────────────────────────────────────────
# Copy pyproject.toml and uv.lock before source files so this layer is only
# invalidated when dependencies change, not on every code edit.
COPY backend/pyproject.toml backend/uv.lock ./

# TRANSCRIPTION_ENGINE=canary requires NeMo (heavy). Skip it otherwise.
ARG INSTALL_CANARY=false

RUN if [ "$INSTALL_CANARY" = "true" ]; then \
      uv sync --frozen --no-install-project --extra canary; \
    else \
      uv sync --frozen --no-install-project; \
    fi && \
    rm -rf /tmp/uv-cache

# ── Application source ────────────────────────────────────────────────────────
COPY backend/ .

# Copy built React frontend from stage 1
COPY --from=node-builder /repo/backend/static ./static

RUN chmod +x entrypoint.sh && mkdir -p /models/hf /models/whisper /cache/audio /data

# Install Playwright's Chromium browser + OS deps (needed by WebpageExtractor).
RUN uv run playwright install chromium --with-deps && \
    rm -rf /root/.cache/ms-playwright

# cleanup uv cache after install to reduce image size. We set UV_CACHE_DIR to /tmp/uv-cache above to ensure it doesn't end up in the final image layers at all.
RUN rm -rf /tmp/uv-cache

EXPOSE 8000

ENTRYPOINT ["./entrypoint.sh"]
