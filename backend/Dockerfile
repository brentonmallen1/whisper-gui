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
FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04

ARG DEBIAN_FRONTEND=noninteractive

# Runtime-only system packages — build-essential and cargo are intentionally absent
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git \
        curl \
        xz-utils && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Static ffmpeg binary — avoids pulling in GTK, GL, and dozens of codec libs
RUN curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
    -o /tmp/ffmpeg.tar.xz && \
    tar -xf /tmp/ffmpeg.tar.xz -C /tmp && \
    mv /tmp/ffmpeg-*-static/ffmpeg /tmp/ffmpeg-*-static/ffprobe /usr/local/bin/ && \
    rm -rf /tmp/*

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

# Install Playwright's Chromium browser + OS deps BEFORE copying application
# code so that code changes don't invalidate this layer.
RUN /opt/venv/bin/playwright install chromium --with-deps && \
    rm -rf /root/.cache/ms-playwright

# ── Application source ────────────────────────────────────────────────────────
COPY backend/ .
COPY --from=node-builder /repo/backend/static ./static

RUN chmod +x entrypoint.sh && mkdir -p /models/hf /models/whisper /cache/audio /data

EXPOSE 8000

ENTRYPOINT ["./entrypoint.sh"]
