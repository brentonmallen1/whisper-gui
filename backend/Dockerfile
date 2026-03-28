FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv from official distroless image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Install Python 3.13 via uv and create project virtualenv
WORKDIR /app
RUN uv python install 3.13
RUN uv venv --python 3.13 /app/.venv

# Activate venv for all subsequent RUN, CMD, and ENTRYPOINT steps
ENV PATH="/app/.venv/bin:$PATH"
ENV VIRTUAL_ENV="/app/.venv"

# ── Install PyTorch with CUDA 12.6 (cached as its own layer — slow to download) ──
RUN uv pip install \
    torch>=2.6.0 \
    torchaudio>=2.6.0 \
    --index-url https://download.pytorch.org/whl/cu126

# ── Install project dependencies ─────────────────────────────────────────────
# Copy pyproject.toml and uv.lock before source files so this layer is only
# invalidated when dependencies change, not on every code edit.
COPY pyproject.toml uv.lock .
RUN uv sync --frozen --no-install-project

# ── Application source ────────────────────────────────────────────────────────
COPY . .

RUN chmod +x entrypoint.sh && mkdir -p /models/hf /models/whisper /cache/audio

EXPOSE 8000

ENTRYPOINT ["./entrypoint.sh"]
