# Lumina

A self-hostable AI content extraction and analysis tool. Point it at audio, video, a YouTube URL, a web page, a PDF, or plain text — Lumina transcribes, summarizes, and lets you chat with the content. Everything runs locally; no data leaves your machine.

<p align="center">
  <img src="screenshot.png" alt="Lumina screenshot" width="700">
</p>

---

## What it does

| Tool | What you give it | What you get |
|---|---|---|
| **Summarize** | Audio, video, YouTube URL, webpage, PDF, image, or text | AI-generated summary, key points, mind map, action items, Q&A, meeting minutes |
| **Transcribe** | Audio or video file | Full transcript with word-level timestamps, SRT/VTT export |
| **Audio Enhance** | Any audio file | Noise reduction, vocal isolation, super-resolution, normalization |
| **Text to Speech** | Any text | High-quality speech synthesis via Kokoro; 28 English voices |
| **Batch** | Multiple files | All processed and summarized in one queue |
| **RSS Monitor** | RSS or podcast feed URL | Auto-transcribes new episodes as they arrive |
| **History** | — | Browse and search past results |
| **Prompts** | — | Customize AI prompts per summarization mode |

---

## Features

- **Universal input** — audio, video, YouTube, webpage, PDF, image, or raw text in one interface
- **Multiple summarization modes** — summary, key points, mind map, action items, Q&A, meeting minutes; fully prompt-customizable
- **Streaming responses** — LLM output streams token by token via SSE; no waiting for the full response
- **Source caching** — extracted content is cached in-session; switching modes re-runs only the LLM, not the extraction
- **In-context chat** — after any summarization, chat with the source document using the full extracted text
- **Translation** — translate any result to another language, streamed
- **Text to speech** — read any summarization result or translation aloud using Kokoro TTS; persistent audio player survives tab switching
- **Word-level timestamps** — transcripts include per-word timing for SRT/VTT subtitle export
- **Speaker diarization** — optional pyannote.audio integration (requires HuggingFace token)
- **Audio enhancement pipeline** — DeepFilterNet noise reduction, Demucs vocal isolation, LavaSR super-resolution
- **Batch processing** — queue multiple files and summarize them all in one run
- **RSS/podcast monitoring** — subscribe to feeds; new episodes are fetched and transcribed automatically
- **Prompt management** — edit or replace any built-in prompt template; custom prompts override defaults per mode
- **Search history** — full-text search over all past summarization results via SQLite FTS5
- **Pluggable engines** — swap transcription backends without changing anything else
- **HTTP API** — every tool accessible programmatically with API key auth and full OpenAPI docs at `/docs`
- **Fully self-contained** — no cloud APIs, no telemetry, no external calls (except to your own Ollama instance)

---

## Transcription engines

| Engine | Hardware | Notes |
|---|---|---|
| `faster-whisper` | CPU or GPU | **Default.** ~4× faster than openai-whisper via CTranslate2. Recommended for most setups. |
| `whisper` | CPU or GPU | Original OpenAI Whisper. Slower but widely compatible. |
| `canary` | **GPU required** | NVIDIA NeMo Canary. Top of the OpenASR leaderboard. English only with punctuation. |
| `qwen-audio` | **GPU required** | Qwen2.5-Audio from HuggingFace. Highest quality; highest VRAM requirement. |

### Whisper model sizes

Applies to `whisper` and `faster-whisper`.

| Size | VRAM | Notes |
|---|---|---|
| `tiny` | ~1 GB | Fastest, lowest accuracy |
| `base` | ~1 GB | |
| `small` | ~2 GB | Good CPU choice |
| `medium` | ~5 GB | |
| `large-v3` | ~10 GB | Highest accuracy |
| `large-v3-turbo` | ~1.5 GB | **Recommended for GPU.** Distil-Whisper large-v3 — ~8× faster than large-v3 with minimal quality loss. |

### Canary models

| Model | VRAM | Notes |
|---|---|---|
| `nvidia/canary-qwen-2.5b` | ~6 GB | FastConformer + Qwen3-1.7B backbone. #1 OpenASR leaderboard. English only. |
| `nvidia/canary-1b` | ~4 GB | EN/ES/FR/DE support. |

### Qwen Audio models

| Model | VRAM | Notes |
|---|---|---|
| `Qwen/Qwen2.5-Audio-3B-Instruct` | ~8 GB | Default. Good balance of quality and VRAM. |
| `Qwen/Qwen2.5-Audio-7B-Instruct` | ~16 GB | Higher quality if VRAM allows. |

---

## Text to Speech

Lumina uses [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (82M parameter neural TTS) for offline, high-quality English speech synthesis.

### Voices

28 English voices across four accent/gender groups:

| Group | Count | Examples |
|---|---|---|
| American Female (`af_`) | 11 | Bella, Nova, Sarah, Sky, Alloy, Heart, … |
| American Male (`am_`) | 9 | Michael, Fenrir, Adam, Santa, … |
| British Female (`bf_`) | 4 | Emma, Isabella, Alice, Lily |
| British Male (`bm_`) | 4 | George, Fable, Daniel, Lewis |

### Setup

1. Go to **Settings → Text to Speech**
2. Click **Download Model** — this downloads the Kokoro weights (~330 MB) and all 28 voice files into `./volumes/models/`
3. Select a default voice and enable TTS

You can preview any voice from the Settings page using the play button next to the voice selector.

### Using TTS

- **Summarize page** — a **Read Aloud** button appears in the result action bar once a result is available. Click it to generate and play the audio. The audio player renders above the results and persists while you switch between summarization modes or browser tabs.
- **Translations** — a **Read Aloud** button also appears below any translation result.
- **TTS page** — a dedicated tool for free-form text synthesis. Paste any text, choose a voice, generate, and download the `.wav`.

### Environment variables

```dotenv
TTS_ENABLED=true          # Show/hide TTS controls (default: true)
TTS_VOICE=af_bella        # Default voice (default: af_bella)
```

---

## Requirements

### Docker (recommended)

- [Docker](https://docs.docker.com/get-docker/) with the Compose plugin
- [just](https://github.com/casey/just) *(optional — `brew install just` / `cargo install just`)*
- For GPU: an NVIDIA GPU with [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) installed on the host

### Local development

- [uv](https://docs.astral.sh/uv/getting-started/installation/) — Python package manager
- Python 3.12+ *(uv installs this automatically)*
- `ffmpeg` on PATH (`brew install ffmpeg` / `apt install ffmpeg`)
- [Node.js](https://nodejs.org/) 20+ (for frontend development only)

---

## Quick start

```bash
# 1. Clone
git clone <repo-url> lumina
cd lumina

# 2. Configure
cp .env.example .env
$EDITOR .env   # set OLLAMA_URL, engine, model size, port, GPU flag, etc.

# 3. Start
just up        # build image + start detached
# or:
docker compose up -d --build
```

Open **http://localhost:8880** (or whatever `APP_PORT` you set).

On first start the container downloads configured model weights into `./volumes/models/`. Subsequent starts reuse the cache.

> **Ollama required for summarization.** Transcription and enhancement work without it. Point `OLLAMA_URL` at a running Ollama instance and set `OLLAMA_MODEL` to a model you have pulled (e.g. `llama3.2`, `mistral`, `gemma3`).

---

## Configuration

All runtime configuration is managed through the **Settings UI** and stored in the SQLite database. Environment variables (and `.env`) seed the database on first run only — after that, Settings changes take effect immediately without a restart.

### Key `.env` variables

```dotenv
# Port the UI and API are exposed on
APP_PORT=8880

# Ollama instance for AI summarization
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2

# Transcription engine: faster-whisper | whisper | canary | qwen-audio
TRANSCRIPTION_ENGINE=faster-whisper

# Model size for faster-whisper / whisper
WHISPER_MODEL_SIZE=large-v3-turbo

# GPU support
ENABLE_GPU=false
NVIDIA_VISIBLE_DEVICES=all

# API key for programmatic access (set in Settings UI or here)
API_KEY=

# Volume paths (host-side)
MODELS_VOLUME=./volumes/models
AUDIO_CACHE_VOLUME=./volumes/audio_cache
DATA_VOLUME=./volumes/data
```

See [`.env.example`](.env.example) for the full reference.

---

## GPU setup

### 1. Install nvidia-container-toolkit

```bash
# Ubuntu / Debian
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### 2. Enable in `.env`

```dotenv
ENABLE_GPU=true
NVIDIA_VISIBLE_DEVICES=all
```

### 3. Start normally

```bash
just up
```

---

## Local development

```bash
# Install Python deps into backend/.venv
just install

# Start backend with hot-reload (reads .env automatically)
just dev

# In a separate terminal — start the frontend dev server
cd frontend && npm install && npm run dev
```

The frontend dev server proxies `/api/*` to the backend. Pre-download the configured model first:

```bash
just download
```

---

## `just` recipes

```
just check          Verify tools (uv, docker, ffmpeg, GPU) and print config
just install        Create backend/.venv and install Python deps
just dev            Run backend locally with hot-reload
just download       Pre-download the configured model weights

just build          Build Docker image
just rebuild        Force full rebuild (no layer cache)

just up             Start detached (builds if needed)
just up-fg          Start in foreground
just restart        Stop then start
just down           Stop the app
just down-volumes   Stop and remove anonymous volumes

just logs           Tail live container logs
just shell          bash shell inside the running container
just status         Show container status
just config         Print resolved docker compose config

just clean-audio    Delete cached audio uploads
just clean-models   Delete downloaded model weights (prompts for confirmation)
just clean-all      Delete all volume data
```

---

## API

All tools are accessible via HTTP on the same port as the UI. Interactive docs are at **`/docs`** (Swagger UI).

### Authentication

Set an API key in **Settings → Security → API Key** or via the `API_KEY` env var. Generate one with:

```bash
openssl rand -hex 32
```

Pass it on any request to `/api/*`:

```
Authorization: Bearer <key>
# or
X-API-Key: <key>
```

If no API key is configured, the API is open (fine for isolated self-hosted use). Basic Auth (`AUTH_ENABLED=true` in Settings) is a separate option for protecting the UI.

### Transcription

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/transcribe` | Upload audio/video. Returns `{ "job_id" }`. Form field: `file`. |
| `GET` | `/api/status/{job_id}` | Poll job. Returns `{ status, result, segments, language }`. |
| `GET` | `/api/export/{job_id}` | Download transcript as `.txt`. |
| `GET` | `/api/export/{job_id}/srt` | Download as SRT subtitles. |
| `GET` | `/api/export/{job_id}/vtt` | Download as WebVTT. |
| `GET` | `/api/audio/{job_id}` | Stream the original audio. |
| `POST` | `/api/retranscribe/{job_id}` | Re-run transcription on a cached file. |
| `GET` | `/api/files` | List cached audio files. |
| `POST` | `/api/clip/{job_id}` | Extract a clip. Body: `{ "start": 0.0, "end": 30.0 }`. |

```bash
# Upload and poll
curl -X POST http://localhost:8880/api/transcribe \
  -H "X-API-Key: $API_KEY" \
  -F "file=@recording.mp3"
# → { "job_id": "abc123" }

curl http://localhost:8880/api/status/abc123 \
  -H "X-API-Key: $API_KEY"
# → { "status": "done", "result": "Hello world...", "segments": [...] }
```

### Summarization

All summarization endpoints stream [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events).

| Event field | Value |
|---|---|
| `phase` | `{ phase, detail }` — extraction progress |
| `extracted_content` | Raw extracted text |
| `text` | Streamed LLM token |
| `error` | Terminal error |
| `[DONE]` | Stream complete |

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/api/summarize` | `{ content, mode, model? }` | Summarize plain text. |
| `POST` | `/api/summarize/url` | `{ source, url, mode, prefer_captions? }` | Fetch a URL and summarize. `source`: `"youtube"` or `"url"`. |
| `POST` | `/api/summarize/file` | form: `file`, `file_type`, `mode` | Upload a file (audio, video, PDF) and summarize. |
| `POST` | `/api/summarize/image` | form: `file`, `mode` | Summarize an image via vision LLM. |

Available `mode` values: `summary`, `key_points`, `mind_map`, `action_items`, `q_and_a`, `meeting_minutes` (customizable in Settings → Prompts).

```bash
# Summarize a YouTube video
curl -X POST http://localhost:8880/api/summarize/url \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "source": "youtube", "url": "https://youtu.be/...", "mode": "summary" }'

# Summarize a local audio file
curl -X POST http://localhost:8880/api/summarize/file \
  -H "X-API-Key: $API_KEY" \
  -F "file=@meeting.mp3" \
  -F "file_type=audio" \
  -F "mode=meeting_minutes"

# Summarize a web page
curl -X POST http://localhost:8880/api/summarize/url \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "source": "url", "url": "https://example.com/article", "mode": "key_points" }'
```

### Chat & Translation

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/api/chat` | `{ content, messages }` | Multi-turn streaming chat about a document. `messages`: `[{ role, content }]`. |
| `POST` | `/api/translate` | `{ text, target_language }` | Stream a translation into `target_language`. |

### Audio Enhancement

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/enhance` | Upload audio for enhancement. Returns `{ "job_id" }`. |
| `GET` | `/api/enhance/{job_id}/download` | Download the enhanced audio. |
| `GET` | `/api/enhance/{job_id}/original` | Download the original. |
| `POST` | `/api/reenhance/{job_id}` | Re-run enhancement on a cached file. |

### Text to Speech

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tts/status` | `{ package, weights }` — whether Kokoro is installed and model is downloaded. |
| `GET` | `/api/tts/voices` | Map of all available voices with name, gender, and accent. |
| `GET` | `/api/tts/download` | SSE stream — download Kokoro model weights. Events: `{ progress }` / `[DONE]` / `error`. |
| `POST` | `/api/tts/synthesize` | Body: `{ text, voice? }`. Returns `audio/wav` binary. |

```bash
# Synthesize speech
curl -X POST http://localhost:8880/api/tts/synthesize \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "text": "Hello world", "voice": "af_bella" }' \
  --output speech.wav
```

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/info` | Engine name, model, GPU availability. |
| `GET` | `/api/ready` | Health check — `{ status: "ready" \| "loading" \| "error" }`. |
| `GET` | `/api/capabilities` | Supported engines and GPU state. |
| `GET` | `/api/settings` | All current settings. |
| `PUT` | `/api/settings` | Update settings. Body: partial settings object. |

### Separate API port

The API runs on the same port as the UI by default. To expose it on a dedicated host port, uncomment the `API_PORT` line in `docker-compose.yml`:

```yaml
ports:
  - "${APP_PORT:-8880}:8000"
  - "${API_PORT:-8881}:8000"   # ← uncomment
```

```dotenv
# .env
API_PORT=8881
```

---

## Project structure

```
lumina/
├── .env.example              # Fully documented config template
├── docker-compose.yml        # Base compose
├── docker-compose.gpu.yml    # GPU overlay
├── docker-compose.canary.yml # Canary/NeMo overlay
├── justfile                  # Task runner recipes
├── start.sh                  # Convenience launcher
├── unraid/
│   └── whisper-gui.xml       # Unraid Community Applications template
├── frontend/
│   ├── index.html
│   ├── package.json
│   └── src/
│       ├── pages/            # Summarize, Transcribe, Enhance, TTS, Batch, Feeds, History, Prompts, Settings
│       ├── components/       # Layout, ToolCard, MindMapDiagram, EnhancementPanel
│       ├── api/client.ts     # Typed API client
│       ├── context/          # SourceCacheContext (cross-tab extraction cache)
│       └── types/index.ts    # Shared TypeScript types
└── backend/
    ├── Dockerfile
    ├── pyproject.toml        # Python deps (uv)
    ├── entrypoint.sh         # Downloads models then starts uvicorn
    ├── main.py               # FastAPI app — all routes
    ├── db.py                 # SQLite settings, history, prompts, feeds
    ├── transcriber.py        # Engine loader
    ├── audio.py              # Enhancement pipeline
    ├── diarization.py        # Speaker diarization (pyannote.audio)
    ├── feed_monitor.py       # RSS/podcast background monitor
    ├── engines/
    │   ├── whisper_engine.py
    │   ├── faster_whisper_engine.py
    │   ├── canary_engine.py
    │   └── qwen_audio_engine.py
    ├── extractors/
    │   ├── audio.py          # Audio → transcript via engine
    │   ├── video.py          # Video → audio strip → transcript
    │   ├── youtube.py        # yt-dlp captions or audio → transcript
    │   ├── webpage.py        # Playwright + readability-lxml
    │   ├── pdf.py            # pdfplumber
    │   └── image.py          # base64 → vision LLM
    ├── llm/
    │   ├── client.py         # Ollama streaming client
    │   ├── prompts.py        # Built-in prompt templates
    │   └── context.py        # Context management for chat
    └── tts/
        ├── engine.py         # Kokoro TTSEngine singleton + download helpers
        ├── voices.py         # 28 English voice definitions
        └── preprocess.py     # Markdown → speech-friendly plain text
```

---

## Disk space

| Component | Size |
|---|---|
| Docker base image (CUDA + Python) | ~8 GB |
| faster-whisper `large-v3-turbo` | ~1.6 GB |
| faster-whisper `large-v3` | ~3 GB |
| `nvidia/canary-qwen-2.5b` | ~6 GB |
| `nvidia/canary-1b` | ~4 GB |
| `Qwen2.5-Audio-3B` | ~8 GB |
| `Qwen2.5-Audio-7B` | ~15 GB |
| Kokoro TTS (model + 28 voices) | ~660 MB |

Model weights are stored in `./volumes/models/` and survive container rebuilds.

---

## Unraid

An [Unraid Community Applications](https://unraid.net/community/apps) template is included at [`unraid/lumina.xml`](unraid/lumina.xml). It configures all ports, paths, and environment variables through the Unraid UI.

Set the **Repository** field to your registry image (e.g. `registry.example.com/lumina:latest`) and fill in the **API Key** field to secure programmatic access.

---

## License

MIT
