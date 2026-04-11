import asyncio
import base64
import json
import os
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

# ── Local dev cache defaults ───────────────────────────────────────────────
# Set before any HuggingFace library is imported so they pick up the right
# cache location. Docker overrides these via docker-compose.yml env vars.
_CACHE_BASE = Path(__file__).parent / "cache"

if "HF_HOME" not in os.environ:
    os.environ["HF_HOME"] = str(_CACHE_BASE / "models" / "hf")
if "WHISPER_DOWNLOAD_ROOT" not in os.environ:
    os.environ["WHISPER_DOWNLOAD_ROOT"] = str(_CACHE_BASE / "models" / "whisper")
# TORCH_HOME — used by older demucs versions / torch.hub downloads
if "TORCH_HOME" not in os.environ:
    os.environ["TORCH_HOME"] = str(_CACHE_BASE / "models" / "torch")
# ──────────────────────────────────────────────────────────────────────────

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel
from fastapi.security import HTTPBasic, HTTPBasicCredentials

import db
from db import init_db, get_all_settings, update_settings as db_update_settings
from llm import OllamaClient
from llm.prompts import get_prompt
from transcriber import load_engine
from audio import AudioPipeline, EnhancementOptions, get_model_status, download_model

_STATIC_DIR = Path(__file__).parent / "static"

# Audio cache path — env-var only since changing it at runtime would orphan files.
AUDIO_CACHE = Path(os.getenv("AUDIO_CACHE_DIR", _CACHE_BASE / "audio"))
AUDIO_CACHE.mkdir(parents=True, exist_ok=True)

# Allowed audio extensions — structural constraint, not a runtime setting.
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".webm", ".opus", ".aac", ".wma"}

# File extensions routed to VideoExtractor (ffmpeg audio strip first).
_VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".m4v"}

security = HTTPBasic(auto_error=False)

# ── Settings (DB-backed) ───────────────────────────────────────────────────
# Loaded at startup via init_db() + _reload_settings(), then refreshed
# whenever the /api/settings PUT endpoint is called.
_settings: dict[str, str] = {}


def _reload_settings() -> None:
    global _settings
    _settings = get_all_settings()


# Helpers — always read from the live _settings dict.
def _auth_enabled() -> bool:
    return _settings.get("auth_enabled", "false").lower() in ("true", "1", "yes")


def _auth_username() -> str:
    return _settings.get("auth_username", "admin")


def _auth_password() -> str:
    return _settings.get("auth_password", "")


def _app_name() -> str:
    return _settings.get("app_name", "Lumina")


def _api_key() -> str:
    return _settings.get("api_key", "")


# Settings that require an engine restart when changed.
_ENGINE_SETTINGS = {"transcription_engine", "whisper_model_size", "compute_type", "language"}

# ── Authentication ─────────────────────────────────────────────────────────
def verify_auth(credentials: HTTPBasicCredentials | None = Depends(security)) -> bool:
    """Verify HTTP Basic Auth credentials if auth is enabled."""
    if not _auth_enabled():
        return True

    pwd = _auth_password()
    if not pwd:
        raise HTTPException(
            status_code=500,
            detail="auth_enabled=true but auth_password is not set. Configure it in Settings.",
        )

    if credentials is None:
        raise HTTPException(
            status_code=401,
            detail="Authentication required",
            headers={"WWW-Authenticate": f'Basic realm="{_app_name()}"'},
        )

    username_ok = secrets.compare_digest(credentials.username.encode(), _auth_username().encode())
    password_ok = secrets.compare_digest(credentials.password.encode(), pwd.encode())

    if not (username_ok and password_ok):
        raise HTTPException(
            status_code=401,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": f'Basic realm="{_app_name()}"'},
        )

    return True


# ── In-memory job store ────────────────────────────────────────────────────
_jobs: dict[str, dict] = {}
_lock = threading.Lock()

# ── Engine state ───────────────────────────────────────────────────────────
_engine = None
_engine_status = "loading"   # loading | ready | error
_engine_message = "Starting up..."


def _load_engine_background() -> None:
    """Load (or reload) the transcription engine in a background thread.

    Sets env vars from DB settings before calling load_engine() so that
    existing engine files (which read from os.environ) pick up the right values.
    """
    global _engine, _engine_status, _engine_message

    engine_name = _settings.get("transcription_engine", "faster-whisper")
    model_name  = _settings.get("whisper_model_size", "large-v3-turbo")
    compute     = _settings.get("compute_type", "int8")
    language    = _settings.get("language", "")

    # Propagate DB settings into environment so engine files pick them up.
    os.environ["TRANSCRIPTION_ENGINE"] = engine_name
    os.environ["WHISPER_MODEL_SIZE"]   = model_name
    os.environ["COMPUTE_TYPE"]         = compute
    if language:
        os.environ["LANGUAGE"] = language
    elif "LANGUAGE" in os.environ:
        del os.environ["LANGUAGE"]

    _engine_message = f"Loading {engine_name} · {model_name}…"

    try:
        _engine = load_engine()
        _engine_status = "ready"
        _engine_message = "Ready"
    except Exception as exc:
        _engine_status = "error"
        _engine_message = str(exc)


def _purge_old_audio() -> None:
    """Delete audio files (and their sidecars) older than audio_cache_ttl_hours."""
    ttl = int(_settings.get("audio_cache_ttl_hours", "72"))
    if ttl <= 0:
        return
    cutoff = time.time() - (ttl * 3600)
    for f in list(AUDIO_CACHE.iterdir()):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
        except OSError:
            pass


async def _purge_loop() -> None:
    _purge_old_audio()
    while True:
        await asyncio.sleep(3600)
        _purge_old_audio()


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Init DB and load settings BEFORE starting the engine thread so
    # _load_engine_background reads the correct DB-backed values.
    init_db()
    _reload_settings()

    thread = threading.Thread(target=_load_engine_background, daemon=True)
    thread.start()

    if int(_settings.get("audio_cache_ttl_hours", "72")) > 0:
        asyncio.create_task(_purge_loop())

    # Start feed monitor (no-op if feedparser/apscheduler not installed)
    import feed_monitor
    feed_monitor.start()

    yield

    feed_monitor.stop()


app = FastAPI(title="Lumina", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Auth middleware (covers static asset requests) ─────────────────────────
@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    # API key: if set, a matching X-API-Key header or Bearer token on /api/*
    # grants access regardless of whether Basic Auth is enabled.
    key = _api_key()
    if key and request.url.path.startswith("/api/"):
        auth_hdr = request.headers.get("Authorization", "")
        candidate = request.headers.get("X-API-Key") or (
            auth_hdr[7:] if auth_hdr.startswith("Bearer ") else ""
        )
        if candidate and secrets.compare_digest(candidate.encode(), key.encode()):
            return await call_next(request)

    if not _auth_enabled():
        return await call_next(request)

    pwd = _auth_password()
    if not pwd:
        return Response(
            content="auth_enabled=true but auth_password is not set.",
            status_code=500,
        )

    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Basic "):
        try:
            decoded = base64.b64decode(auth_header[6:]).decode("utf-8")
            username, password = decoded.split(":", 1)
            if (secrets.compare_digest(username.encode(), _auth_username().encode()) and
                    secrets.compare_digest(password.encode(), pwd.encode())):
                return await call_next(request)
        except Exception:
            pass

    return Response(
        content="Authentication required",
        status_code=401,
        headers={"WWW-Authenticate": f'Basic realm="{_app_name()}"'},
    )


# ── Engine loading page ────────────────────────────────────────────────────
def _loading_page(message: str, is_error: bool = False) -> str:
    color = "#ef4444" if is_error else "#6366f1"
    name = _app_name() if _settings else "Lumina"
    spinner = "" if is_error else """
      <div style="width:40px;height:40px;border-radius:50%;
        border:3px solid #c8cdd5;border-top-color:#6366f1;
        animation:spin .8s linear infinite;margin-bottom:20px;
      "></div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>"""
    reload_script = "" if is_error else """
      <script>
        const el = document.getElementById('msg');
        const poll = async () => {
          try {
            const r = await fetch('/api/ready');
            const d = await r.json();
            if (d.message) el.textContent = d.message;
            if (d.status === 'ready')  { location.reload(); return; }
            if (d.status === 'error')  { el.textContent = 'Error: ' + d.message; return; }
          } catch (_) { el.textContent = 'Waiting for server\u2026'; }
          setTimeout(poll, 1500);
        };
        poll();
      </script>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{name}</title>
  <style>
    *{{box-sizing:border-box;margin:0;padding:0}}
    body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          background:#e6e8ec;display:flex;align-items:center;
          justify-content:center;min-height:100vh;}}
    .card{{background:#eef0f3;border:1px solid #c8cdd5;border-radius:12px;
           padding:48px 40px;text-align:center;max-width:420px;width:90%;}}
    h1{{font-size:1.3rem;font-weight:700;color:#1e2330;margin-bottom:24px}}
    p{{font-size:.88rem;line-height:1.6;color:{color}}}
  </style>
</head>
<body>
  <div class="card">
    <h1>{name}</h1>
    {spinner}
    <p id="msg">{message}</p>
  </div>
  {reload_script}
</body>
</html>"""


# ── Readiness (no auth — called by loading page before credentials exist) ──
@app.get("/api/ready")
async def get_ready():
    return {"status": _engine_status, "message": _engine_message}


# ── Capabilities ───────────────────────────────────────────────────────────
@app.get("/api/capabilities")
async def get_capabilities(_: bool = Depends(verify_auth)):
    """
    Report which transcription engines are actually usable in this environment.
    Used by the Settings UI to disable options that can't be selected.

    Checks:
      faster-whisper / whisper — always available (base deps)
      canary     — requires NeMo, only installed with --extra canary
      qwen-audio — always has transformers but requires a CUDA GPU
    """
    import importlib.util
    import torch

    gpu = torch.cuda.is_available()

    nemo = importlib.util.find_spec("nemo") is not None

    return {
        "gpu": gpu,
        "engines": {
            "faster-whisper": {"available": True},
            "whisper":        {"available": True},
            "canary":         {
                "available": nemo and gpu,
                "reason":    None if (nemo and gpu)
                             else ("NeMo not installed — rebuild with INSTALL_CANARY=true" if not nemo
                                   else "Requires a CUDA GPU"),
            },
            "qwen-audio":     {
                "available": gpu,
                "reason":    None if gpu else "Requires a CUDA GPU",
            },
        },
    }


# ── Engine info ────────────────────────────────────────────────────────────
@app.get("/api/info")
async def get_info(_: bool = Depends(verify_auth)):
    import torch
    gpu_available = torch.cuda.is_available()
    return {
        "status":        _engine_status,
        "engine":        _settings.get("transcription_engine", "faster-whisper"),
        "model":         _engine.model_name if _engine else None,
        "gpu_available": gpu_available,
        "gpu_name":      torch.cuda.get_device_name(0) if gpu_available else None,
    }


# ── Settings API ───────────────────────────────────────────────────────────
@app.get("/api/settings")
async def get_settings(_: bool = Depends(verify_auth)):
    return get_all_settings()


@app.put("/api/settings")
async def put_settings(updates: dict[str, str], _: bool = Depends(verify_auth)):
    old = get_all_settings()
    new = db_update_settings(updates)
    _reload_settings()

    engine_changed = any(
        old.get(k) != new.get(k)
        for k in _ENGINE_SETTINGS
        if k in updates
    )

    return {"settings": new, "restart_required": engine_changed}


@app.post("/api/reload-engine")
async def reload_engine(_: bool = Depends(verify_auth)):
    """Re-initialize the transcription engine using current DB settings."""
    global _engine_status, _engine_message
    _engine_status  = "loading"
    _engine_message = "Reloading engine..."
    thread = threading.Thread(target=_load_engine_background, daemon=True)
    thread.start()
    return {"status": "reloading"}


# ── Ollama ─────────────────────────────────────────────────────────────────

def _ollama_client() -> OllamaClient:
    """Construct an OllamaClient from the current live settings."""
    return OllamaClient(
        base_url=_settings.get("ollama_url", "http://localhost:11434"),
        timeout=float(_settings.get("ollama_timeout", "120")),
    )


@app.get("/api/ollama/test")
async def ollama_test():
    """
    Test connectivity to the configured Ollama instance.
    No auth required — called from the Settings UI before credentials are confirmed.
    Returns {"ok": bool, "message": str}.
    """
    result = await _ollama_client().test_connection()
    return result


@app.get("/api/ollama/models")
async def ollama_models(_: bool = Depends(verify_auth)):
    """
    List models installed in the configured Ollama instance.
    Returns {"models": [{name, size, parameter_size}, ...]} or empty list on error.
    """
    models = await _ollama_client().list_models()
    return {"models": models}


# ── Prompts ────────────────────────────────────────────────────────────────

class PromptCreate(BaseModel):
    name:          str
    mode:          str
    system_prompt: str = ""
    template:      str


class PromptUpdate(BaseModel):
    name:          str
    system_prompt: str = ""
    template:      str


@app.get("/api/prompts")
async def list_prompts(_: bool = Depends(verify_auth)):
    """List all prompts (built-in + custom), ordered built-in first then by name."""
    return db.get_all_prompts()


@app.post("/api/prompts", status_code=201)
async def create_prompt(body: PromptCreate, _: bool = Depends(verify_auth)):
    """Create a new custom prompt."""
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="name is required")
    if not body.template.strip():
        raise HTTPException(status_code=400, detail="template is required")
    if "{content}" not in body.template:
        raise HTTPException(status_code=400, detail="template must contain {content}")
    return db.create_prompt(
        name=body.name.strip(),
        mode=body.mode.strip(),
        system_prompt=body.system_prompt,
        template=body.template,
    )


@app.put("/api/prompts/{prompt_id}")
async def update_prompt(prompt_id: str, body: PromptUpdate, _: bool = Depends(verify_auth)):
    """Update a prompt (name, system_prompt, template). Mode cannot be changed."""
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="name is required")
    if "{content}" not in body.template:
        raise HTTPException(status_code=400, detail="template must contain {content}")
    result = db.update_prompt(
        prompt_id=prompt_id,
        name=body.name.strip(),
        system_prompt=body.system_prompt,
        template=body.template,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return result


@app.delete("/api/prompts/{prompt_id}", status_code=204)
async def delete_prompt(prompt_id: str, _: bool = Depends(verify_auth)):
    """Delete a custom prompt. Built-in prompts cannot be deleted."""
    ok = db.delete_prompt(prompt_id)
    if not ok:
        raise HTTPException(status_code=403, detail="Built-in prompts cannot be deleted")


@app.post("/api/prompts/reset")
async def reset_prompts(_: bool = Depends(verify_auth)):
    """Reset all built-in prompts to their hardcoded defaults."""
    db.reset_default_prompts()
    return {"ok": True}


# ── History ────────────────────────────────────────────────────────────────

class HistoryCreate(BaseModel):
    mode:          str
    source:        str
    source_detail: str = ""
    result:        str
    reasoning:     str = ""


@app.get("/api/history/search")
async def search_history(q: str = Query(..., min_length=1), _: bool = Depends(verify_auth)):
    """Full-text search across history results."""
    return db.search_history(q)


@app.get("/api/history")
async def list_history(_: bool = Depends(verify_auth)):
    """Return the 50 most recent summarization history entries."""
    return db.list_history()


@app.post("/api/history", status_code=201)
async def create_history(body: HistoryCreate, _: bool = Depends(verify_auth)):
    """Save a completed summarization to history."""
    if not body.result.strip():
        raise HTTPException(status_code=400, detail="result is required")
    return db.create_history_entry(
        mode=body.mode,
        source=body.source,
        source_detail=body.source_detail,
        result=body.result,
        reasoning=body.reasoning,
    )


@app.delete("/api/history/{entry_id}", status_code=204)
async def delete_history_entry(entry_id: str, _: bool = Depends(verify_auth)):
    """Delete a single history entry."""
    ok = db.delete_history_entry(entry_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Entry not found")


@app.delete("/api/history", status_code=204)
async def clear_history(_: bool = Depends(verify_auth)):
    """Delete all history entries."""
    db.clear_history()


# ── RSS/Podcast feeds ─────────────────────────────────────────────────────

class FeedCreate(BaseModel):
    url:              str
    check_interval:   int  = 3600   # seconds
    auto_summarize:   bool = True
    summarize_mode:   str  = "summary"


@app.get("/api/feeds")
async def list_feeds(_: bool = Depends(verify_auth)):
    return db.list_feeds()


@app.post("/api/feeds", status_code=201)
async def create_feed(body: FeedCreate, _: bool = Depends(verify_auth)):
    import feed_monitor, feedparser

    available, reason = feed_monitor.check_available()
    if not available:
        raise HTTPException(status_code=503, detail=reason)

    # Validate URL and fetch initial title
    try:
        parsed = feedparser.parse(body.url)
        title = parsed.feed.get("title", "") or ""
    except Exception:
        title = ""

    feed = db.create_feed(
        url=body.url,
        title=title,
        check_interval=body.check_interval,
        auto_summarize=body.auto_summarize,
        summarize_mode=body.summarize_mode,
    )
    # Kick off an immediate check in the background
    threading.Thread(
        target=feed_monitor.check_feed, args=(feed["id"],), daemon=True
    ).start()
    return feed


@app.delete("/api/feeds/{feed_id}", status_code=204)
async def delete_feed(feed_id: str, _: bool = Depends(verify_auth)):
    ok = db.delete_feed(feed_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Feed not found")


@app.get("/api/feeds/{feed_id}/entries")
async def list_feed_entries(feed_id: str, _: bool = Depends(verify_auth)):
    return db.list_feed_entries(feed_id)


@app.post("/api/feeds/{feed_id}/check")
async def check_feed_now(feed_id: str, background_tasks: BackgroundTasks, _: bool = Depends(verify_auth)):
    import feed_monitor
    available, reason = feed_monitor.check_available()
    if not available:
        raise HTTPException(status_code=503, detail=reason)
    background_tasks.add_task(feed_monitor.check_feed, feed_id)
    return {"status": "checking"}


@app.get("/api/feeds/status")
async def feeds_status(_: bool = Depends(verify_auth)):
    """Return whether feed monitoring dependencies are available."""
    import feed_monitor
    available, reason = feed_monitor.check_available()
    return {"available": available, "reason": reason}


# ── Audio enhancement models ───────────────────────────────────────────────

@app.get("/api/audio/models")
async def get_audio_models(_: bool = Depends(verify_auth)):
    """
    Return package installation and weight-download status for each
    audio enhancement model.
    Shape: { "deepfilternet": {"package": bool, "weights": bool}, ... }
    """
    return get_model_status()


class DownloadModelsRequest(BaseModel):
    models: list[str]   # e.g. ["deepfilternet", "demucs", "lavasr"]


@app.post("/api/audio/models/download")
async def download_audio_models(req: DownloadModelsRequest, _: bool = Depends(verify_auth)):
    """
    Download model weights for one or more enhancement models.
    Streams SSE progress events; each model downloads sequentially.

    Events:
      {"model": "...", "status": "downloading"}
      {"model": "...", "status": "done"}
      {"model": "...", "status": "error", "error": "..."}
      [DONE]
    """
    async def event_stream():
        for name in req.models:
            yield f"data: {json.dumps({'model': name, 'status': 'downloading'})}\n\n"
            try:
                await asyncio.to_thread(download_model, name)
                yield f"data: {json.dumps({'model': name, 'status': 'done'})}\n\n"
            except Exception as exc:
                yield f"data: {json.dumps({'model': name, 'status': 'error', 'error': str(exc)})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=_SSE_HEADERS)


# ── Text-to-Speech ────────────────────────────────────────────────────────

from tts import TTSEngine, get_tts_status, download_tts_model, VOICES
from tts.preprocess import preprocess_for_speech


@app.get("/api/tts/status")
async def tts_status(_: bool = Depends(verify_auth)):
    """Return TTS package/weights availability."""
    return get_tts_status()


@app.get("/api/tts/voices")
async def tts_voices(_: bool = Depends(verify_auth)):
    """Return available voices with metadata."""
    return {"voices": VOICES}


@app.post("/api/tts/download")
async def tts_download(_: bool = Depends(verify_auth)):
    """
    Download Kokoro TTS model weights.
    Streams SSE progress events.

    Events:
      {"status": "downloading", "message": "..."}
      {"status": "done",        "message": "..."}
      {"status": "error",       "error":   "..."}
      [DONE]
    """
    async def event_stream():
        yield f"data: {json.dumps({'status': 'downloading', 'message': 'Downloading Kokoro TTS model\u2026'})}\n\n"
        try:
            await asyncio.to_thread(download_tts_model)
            yield f"data: {json.dumps({'status': 'done', 'message': 'Model ready'})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'status': 'error', 'error': str(exc)})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=_SSE_HEADERS)


class TTSSynthesizeRequest(BaseModel):
    text:  str
    voice: str | None = None  # Falls back to tts_voice setting


@app.post("/api/tts/synthesize")
async def tts_synthesize(req: TTSSynthesizeRequest, _: bool = Depends(verify_auth)):
    """
    Synthesize text to speech and return audio/wav.
    Uses the configured default voice if none is specified.
    """
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text is required")

    voice = req.voice or _settings.get("tts_voice", "af_bella")
    speech_text = preprocess_for_speech(req.text)
    engine = TTSEngine()
    try:
        audio_bytes = await asyncio.to_thread(engine.synthesize, speech_text, voice)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return Response(content=audio_bytes, media_type="audio/wav")


# ── Translation ───────────────────────────────────────────────────────────

class TranslateRequest(BaseModel):
    text:            str
    target_language: str
    source_language: str = "auto"


@app.post("/api/translate")
async def translate_text(req: TranslateRequest, _: bool = Depends(verify_auth)):
    """
    Stream a translation via SSE using the configured Ollama model.

    Events:
      {"text": "...chunk..."}   — LLM output token
      {"error": "..."}          — terminal error
      [DONE]
    """
    async def event_stream():
        model = _settings.get("ollama_model", "")
        if not model:
            yield f'data: {json.dumps({"error": "No Ollama model configured — go to Settings → Ollama."})}\n\n'
            yield "data: [DONE]\n\n"
            return

        src = "" if req.source_language == "auto" else f" from {req.source_language}"
        prompt = (
            f"Translate the following text{src} to {req.target_language}.\n"
            f"Output ONLY the translation — no explanations, no introductory phrases.\n\n"
            f"{req.text}"
        )
        system = "You are a professional translator. Provide accurate, natural translations."
        client = _ollama_client()
        try:
            async for chunk in client.generate_stream(prompt, model=model, system=system):
                yield f"data: {json.dumps({'text': chunk})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=_SSE_HEADERS)


# ── Chat ───────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    content:  str                  # source document text to chat about
    messages: list[dict]           # conversation history: [{role, content}, ...]
    model:    str | None = None    # optional model override


@app.post("/api/chat")
async def chat_endpoint(req: ChatRequest, _: bool = Depends(verify_auth)):
    """
    Multi-turn chat about a source document, streamed via SSE.

    The source content is injected into the system prompt.  Old history is
    automatically summarized when the context budget is exceeded.

    Events:
      {"text": "...chunk..."}         — LLM output token
      {"notice": "..."}               — informational (context compression, truncation)
      {"error": "..."}                — terminal error
      [DONE]
    """
    from llm.context import build_system_prompt, prepare_messages

    async def event_stream():
        model = req.model or _settings.get("ollama_model", "")
        if not model:
            yield f'data: {json.dumps({"error": "No Ollama model configured — go to Settings → Ollama to select one."})}\n\n'
            yield "data: [DONE]\n\n"
            return

        system_prompt, was_truncated = build_system_prompt(req.content)
        if was_truncated:
            yield f"data: {json.dumps({'notice': 'The source content was truncated to fit the context window.'})}\n\n"

        client = _ollama_client()
        try:
            messages, compression_notice = await prepare_messages(
                system_prompt, req.messages, client, model
            )
        except Exception as exc:
            yield f"data: {json.dumps({'error': f'Context preparation failed: {exc}'})}\n\n"
            yield "data: [DONE]\n\n"
            return

        if compression_notice:
            yield f"data: {json.dumps({'notice': compression_notice})}\n\n"

        try:
            async for chunk in client.chat_stream(messages, model):
                yield f"data: {json.dumps({'text': chunk})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"

        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=_SSE_HEADERS)


# ── Summarization ──────────────────────────────────────────────────────────

class SummarizeRequest(BaseModel):
    content: str
    mode: str = "summary"       # summary | key_points | mind_map
    model: str | None = None    # override the model from settings


@app.post("/api/summarize")
async def summarize_content(req: SummarizeRequest, _: bool = Depends(verify_auth)):
    """
    Stream an AI summary of plain text content via Server-Sent Events.

    Emits:  data: {"text": "..."}  |  data: [DONE]  |  data: {"error": "..."}
    The gemma4 thinking block (<|channel>...<channel|>) is passed through as-is.
    """
    async def event_stream():
        async for sse_line in _llm_summarize_sse(req.content, req.mode, req.model):
            yield sse_line

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


# ── Shared LLM streaming helper ────────────────────────────────────────────

async def _llm_summarize_sse(content: str, mode: str, model_override: str | None):
    """
    Async generator — yields SSE lines for an LLM summarization run.
    Shared by all three /api/summarize* endpoints.
    """
    model = model_override or _settings.get("ollama_model", "")
    if not model:
        yield f'data: {json.dumps({"error": "No Ollama model configured — go to Settings → Ollama to select one."})}\n\n'
        yield "data: [DONE]\n\n"
        return

    prompt_data = get_prompt(mode)
    prompt      = prompt_data["template"].format(content=content)
    system      = prompt_data["system"]
    thinking    = _settings.get("ollama_thinking_enabled", "true") == "true"
    budget      = int(_settings.get("ollama_token_budget", "280"))

    try:
        async for chunk in _ollama_client().generate_stream(
            prompt, model, system,
            thinking_enabled=thinking,
            token_budget=budget,
        ):
            yield f"data: {json.dumps({'text': chunk})}\n\n"
    except Exception as exc:
        yield f"data: {json.dumps({'error': str(exc)})}\n\n"

    yield "data: [DONE]\n\n"


async def _extract_and_summarize_sse(extractor, source_arg, mode: str, model_override: str | None):
    """
    Async generator that:
      1. Runs an extractor, forwarding status events as SSE phase events.
      2. Streams the LLM summarization of the extracted content.
    """
    q: asyncio.Queue = asyncio.Queue()

    async def on_status(phase: str, detail: str) -> None:
        q.put_nowait({"phase": phase, "detail": detail})

    extract_task = asyncio.create_task(extractor.extract(source_arg, on_status))

    # Forward phase events while extraction runs
    while not extract_task.done():
        try:
            yield f"data: {json.dumps(q.get_nowait())}\n\n"
        except asyncio.QueueEmpty:
            await asyncio.sleep(0.05)

    # Drain any remaining events
    while not q.empty():
        yield f"data: {json.dumps(q.get_nowait())}\n\n"

    # Unwrap result or surface error
    try:
        content = extract_task.result()
    except Exception as exc:
        yield f"data: {json.dumps({'error': f'Extraction failed: {exc}'})}\n\n"
        yield "data: [DONE]\n\n"
        return

    # Emit extracted text so the frontend can use it for chat
    # Cap at SOURCE_CONTENT_LIMIT to avoid huge SSE payloads
    _SOURCE_LIMIT = 32_000
    yield f"data: {json.dumps({'extracted_content': content[:_SOURCE_LIMIT]})}\n\n"

    # Transcript mode: return raw extracted text without LLM processing
    if mode == "transcript":
        yield f"data: {json.dumps({'text': content})}\n\n"
        yield "data: [DONE]\n\n"
        return

    async for sse_line in _llm_summarize_sse(content, mode, model_override):
        yield sse_line


_SSE_HEADERS = {"X-Accel-Buffering": "no", "Cache-Control": "no-cache"}


# ── Summarize from file (audio / video / PDF) ──────────────────────────────

@app.post("/api/summarize/file")
async def summarize_file(
    source:            str        = Form(...),         # "audio" | "pdf"
    mode:              str        = Form("summary"),
    file:              UploadFile = File(...),
    enhance_normalize: bool       = Form(False),
    enhance_denoise:   bool       = Form(False),
    enhance_isolate:   bool       = Form(False),
    enhance_separate:  bool       = Form(False),
    enhance_upsample:  bool       = Form(False),
    _: bool = Depends(verify_auth),
):
    """
    Upload a file and stream an AI summary via SSE.

    source="audio"  — audio or video file → (optional enhancement) → Whisper → LLM
    source="pdf"    — PDF file → pdfplumber → LLM
    """
    from extractors.audio import AudioExtractor
    from extractors.video import VideoExtractor
    from extractors.pdf   import PDFExtractor

    contents = await file.read()
    suffix   = Path(file.filename or "upload").suffix.lower()

    tmp = Path(tempfile.mktemp(suffix=suffix))
    tmp.write_bytes(contents)

    opts = EnhancementOptions(
        normalize=enhance_normalize,
        denoise  =enhance_denoise,
        isolate  =enhance_isolate,
        separate =enhance_separate,
        upsample =enhance_upsample,
    )
    pipeline = AudioPipeline() if opts.any_active else None

    async def event_stream():
        try:
            if source == "pdf":
                extractor = PDFExtractor()
            elif source == "audio":
                if suffix in _VIDEO_EXTENSIONS:
                    extractor = VideoExtractor(engine=_engine, pipeline=pipeline, options=opts)
                else:
                    extractor = AudioExtractor(engine=_engine, pipeline=pipeline, options=opts)
            else:
                yield f"data: {json.dumps({'error': f'Unknown source type: {source}'})}\n\n"
                yield "data: [DONE]\n\n"
                return

            async for sse_line in _extract_and_summarize_sse(extractor, tmp, mode, None):
                yield sse_line
        finally:
            tmp.unlink(missing_ok=True)

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=_SSE_HEADERS)


# ── Summarize from URL (YouTube / webpage) ─────────────────────────────────

class SummarizeUrlRequest(BaseModel):
    source: str             # "youtube" | "url"
    url: str
    mode: str = "summary"
    model: str | None = None
    prefer_captions: bool = True   # YouTube: try captions first


@app.post("/api/summarize/url")
async def summarize_url(req: SummarizeUrlRequest, _: bool = Depends(verify_auth)):
    """
    Fetch a URL and stream an AI summary via SSE.

    source="youtube" — yt-dlp captions (fast) or audio download → Whisper → LLM
    source="url"     — Playwright page fetch → readability → LLM
    """
    from extractors.youtube import YouTubeExtractor
    from extractors.webpage import WebpageExtractor

    async def event_stream():
        if req.source == "youtube":
            extractor = YouTubeExtractor(engine=_engine, prefer_captions=req.prefer_captions, cookies=_settings.get("youtube_cookies") or None)
            source_arg = req.url
        elif req.source == "url":
            extractor = WebpageExtractor()
            source_arg = req.url
        else:
            yield f"data: {json.dumps({'error': f'Unknown source type: {req.source}'})}\n\n"
            yield "data: [DONE]\n\n"
            return

        async for sse_line in _extract_and_summarize_sse(extractor, source_arg, req.mode, req.model):
            yield sse_line

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=_SSE_HEADERS)


# ── Summarize from image (vision LLM) ─────────────────────────────────────

_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


async def _llm_summarize_image_sse(b64: str, mode: str, model_override: str | None):
    """
    Async generator — yields SSE lines for an image summarization run.
    Passes the base64-encoded image to the LLM alongside the mode's prompt.
    """
    model = model_override or _settings.get("ollama_model", "")
    if not model:
        yield f'data: {json.dumps({"error": "No Ollama model configured — go to Settings → Ollama to select one."})}\n\n'
        yield "data: [DONE]\n\n"
        return

    prompt_data = get_prompt(mode)
    # Substitute {content} with a generic stand-in so existing templates work for images.
    prompt   = prompt_data["template"].format(content="the provided image")
    system   = prompt_data["system"]
    thinking = _settings.get("ollama_thinking_enabled", "true") == "true"
    budget   = int(_settings.get("ollama_token_budget", "280"))

    try:
        async for chunk in _ollama_client().generate_stream(
            prompt, model, system,
            images=[b64],
            thinking_enabled=thinking,
            token_budget=budget,
        ):
            yield f"data: {json.dumps({'text': chunk})}\n\n"
    except Exception as exc:
        yield f"data: {json.dumps({'error': str(exc)})}\n\n"

    yield "data: [DONE]\n\n"


@app.post("/api/summarize/image")
async def summarize_image(
    mode: str        = Form("summary"),
    file: UploadFile = File(...),
    _:   bool        = Depends(verify_auth),
):
    """
    Upload an image and stream a vision-LLM summary via SSE.

    Requires a vision-capable model (e.g. llava, gemma3, moondream) selected
    in Settings → Ollama. Text-only models will return an error.
    """
    from extractors.image import ImageExtractor

    contents = await file.read()
    suffix   = Path(file.filename or "image").suffix.lower()

    if suffix not in _IMAGE_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported image type: {suffix}. Allowed: jpg, jpeg, png, webp, gif",
        )

    tmp = Path(tempfile.mktemp(suffix=suffix))
    tmp.write_bytes(contents)

    async def event_stream():
        try:
            extractor = ImageExtractor()
            b64 = extractor.extract(tmp)
            async for sse_line in _llm_summarize_image_sse(b64, mode, None):
                yield sse_line
        except ValueError as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
            yield "data: [DONE]\n\n"
        finally:
            tmp.unlink(missing_ok=True)

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=_SSE_HEADERS)


# ── Transcription ──────────────────────────────────────────────────────────
def _run_transcription(
    job_id: str,
    audio_path: Path,
    options: EnhancementOptions | None = None,
) -> None:
    enhanced = audio_path

    # Run enhancement pipeline first (if any stages are active)
    if options and options.any_active:
        def _status(phase: str, detail: str) -> None:
            with _lock:
                _jobs[job_id]["status"]        = "enhancing"
                _jobs[job_id]["status_detail"] = detail

        try:
            pipeline = AudioPipeline()
            enhanced = pipeline.run_sync(audio_path, options, _status)
        except Exception as exc:
            with _lock:
                _jobs[job_id]["status"] = "error"
                _jobs[job_id]["error"]  = f"Enhancement failed: {exc}"
            return

    with _lock:
        _jobs[job_id]["status"] = "processing"

    try:
        raw = _engine.transcribe(str(enhanced))
        # Engines return a dict with text + segments; handle legacy str just in case
        if isinstance(raw, dict):
            text     = raw.get("text", "")
            segments = raw.get("segments", [])
            language = raw.get("language", "")
        else:
            text     = raw
            segments = []
            language = ""

        # Persist segments in sidecar for SRT/VTT export
        sidecar = AUDIO_CACHE / f"{job_id}.json"
        if sidecar.exists():
            try:
                meta = json.loads(sidecar.read_text())
                meta["segments"] = segments
                meta["language"] = language
                sidecar.write_text(json.dumps(meta))
            except Exception:
                pass

        with _lock:
            _jobs[job_id]["status"]   = "done"
            _jobs[job_id]["result"]   = text
            _jobs[job_id]["segments"] = segments
            _jobs[job_id]["language"] = language
    except Exception as exc:
        traceback.print_exc()
        with _lock:
            _jobs[job_id]["status"] = "error"
            _jobs[job_id]["error"]  = str(exc) or repr(exc)
    finally:
        if enhanced != audio_path:
            enhanced.unlink(missing_ok=True)


def _run_enhancement(
    job_id: str,
    audio_path: Path,
    options: EnhancementOptions,
) -> None:
    """Background task: run the enhancement pipeline without transcription."""

    def _status(phase: str, detail: str) -> None:
        with _lock:
            _jobs[job_id]["status"]        = "enhancing"
            _jobs[job_id]["status_detail"] = detail

    try:
        pipeline = AudioPipeline()
        enhanced = pipeline.run_sync(audio_path, options, _status)

        if enhanced != audio_path:
            # Move the temp enhanced file to a stable location in the cache
            enhanced_name = f"{job_id}_enhanced{enhanced.suffix}"
            enhanced_path = AUDIO_CACHE / enhanced_name
            enhanced.rename(enhanced_path)
        else:
            # No-op enhancement — serve the original
            enhanced_path = audio_path

        # Update the sidecar with enhanced file info
        sidecar = AUDIO_CACHE / f"{job_id}.json"
        if sidecar.exists():
            meta = json.loads(sidecar.read_text())
            meta["enhanced_file"] = enhanced_path.name
            meta["enhancement_options"] = {
                "normalize": options.normalize,
                "denoise":   options.denoise,
                "isolate":   options.isolate,
                "upsample":  options.upsample,
            }
            sidecar.write_text(json.dumps(meta))

        with _lock:
            _jobs[job_id]["status"]        = "done"
            _jobs[job_id]["status_detail"] = ""
            _jobs[job_id]["enhanced_path"] = str(enhanced_path)

    except Exception as exc:
        traceback.print_exc()
        with _lock:
            _jobs[job_id]["status"] = "error"
            _jobs[job_id]["error"]  = str(exc) or repr(exc)


def _sanitize_filename(filename: str) -> str:
    name = Path(filename).name
    return "".join(c for c in name if c.isalnum() or c in "._- ").strip() or "audio"


@app.post("/api/transcribe")
async def transcribe(
    background_tasks: BackgroundTasks,
    file:              UploadFile = File(...),
    enhance_normalize: bool       = Form(False),
    enhance_denoise:   bool       = Form(False),
    enhance_isolate:   bool       = Form(False),
    enhance_separate:  bool       = Form(False),
    enhance_upsample:  bool       = Form(False),
    _: bool = Depends(verify_auth),
):
    if _engine_status != "ready":
        raise HTTPException(status_code=503, detail="Engine is still loading — please wait.")

    suffix = Path(file.filename or "audio").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {suffix}. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    contents = await file.read()
    size_mb = len(contents) / (1024 * 1024)
    max_mb  = int(_settings.get("max_upload_size_mb", "500"))

    if max_mb > 0 and size_mb > max_mb:
        raise HTTPException(
            status_code=413,
            detail=f"File too large: {size_mb:.1f} MB. Maximum: {max_mb} MB",
        )

    job_id     = str(uuid.uuid4())
    audio_path = AUDIO_CACHE / f"{job_id}{suffix}"

    with open(audio_path, "wb") as f:
        f.write(contents)

    sidecar = AUDIO_CACHE / f"{job_id}.json"
    sidecar.write_text(json.dumps({
        "job_id":      job_id,
        "filename":    file.filename,
        "audio_file":  audio_path.name,
        "size":        audio_path.stat().st_size,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }))

    opts = EnhancementOptions(
        normalize=enhance_normalize,
        denoise  =enhance_denoise,
        isolate  =enhance_isolate,
        separate =enhance_separate,
        upsample =enhance_upsample,
    )

    with _lock:
        _jobs[job_id] = {
            "status":        "pending",
            "status_detail": "",
            "result":        None,
            "segments":      [],
            "language":      "",
            "error":         None,
            "filename":      file.filename,
            "audio_path":    str(audio_path),
        }

    background_tasks.add_task(_run_transcription, job_id, audio_path, opts)
    return {"job_id": job_id}


@app.get("/api/status/{job_id}")
async def get_status(job_id: str, _: bool = Depends(verify_auth)):
    with _lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/api/audio/{job_id}")
async def get_audio(job_id: str, _: bool = Depends(verify_auth)):
    with _lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    audio_path = Path(job.get("audio_path", ""))
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    filename = _sanitize_filename(job.get("filename") or audio_path.name)
    return FileResponse(audio_path, media_type="audio/mpeg", filename=filename)


@app.get("/api/export/{job_id}")
async def export_txt(job_id: str, _: bool = Depends(verify_auth)):
    with _lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "done":
        raise HTTPException(status_code=400, detail="Transcription not complete")

    stem = _sanitize_filename(Path(job.get("filename") or "transcription").stem)
    return PlainTextResponse(
        job["result"],
        headers={"Content-Disposition": f'attachment; filename="{stem}.txt"'},
    )


def _fmt_srt_time(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms  = divmod(rem, 1_000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _fmt_vtt_time(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms  = divmod(rem, 1_000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def _get_job_segments(job_id: str) -> tuple[dict, list[dict]]:
    """Return (job, segments) — falls back to sidecar for segments if needed."""
    with _lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.get("status") != "done":
        raise HTTPException(status_code=400, detail="Transcription not complete")
    segments = job.get("segments") or []
    # If job was restored from sidecar (server restart), load segments from disk
    if not segments:
        sidecar = AUDIO_CACHE / f"{job_id}.json"
        if sidecar.exists():
            try:
                meta = json.loads(sidecar.read_text())
                segments = meta.get("segments", [])
            except Exception:
                pass
    return job, segments


@app.get("/api/export/{job_id}/srt")
async def export_srt(job_id: str, _: bool = Depends(verify_auth)):
    job, segments = _get_job_segments(job_id)
    if not segments:
        raise HTTPException(status_code=400, detail="No segment timestamps available for this transcription")

    lines: list[str] = []
    for i, seg in enumerate(segments, 1):
        lines.append(str(i))
        lines.append(f"{_fmt_srt_time(seg['start'])} --> {_fmt_srt_time(seg['end'])}")
        lines.append(seg["text"].strip())
        lines.append("")
    content = "\n".join(lines)
    stem = _sanitize_filename(Path(job.get("filename") or "subtitles").stem)
    return PlainTextResponse(
        content,
        headers={"Content-Disposition": f'attachment; filename="{stem}.srt"'},
    )


@app.get("/api/export/{job_id}/vtt")
async def export_vtt(job_id: str, _: bool = Depends(verify_auth)):
    job, segments = _get_job_segments(job_id)
    if not segments:
        raise HTTPException(status_code=400, detail="No segment timestamps available for this transcription")

    lines: list[str] = ["WEBVTT", ""]
    for seg in segments:
        lines.append(f"{_fmt_vtt_time(seg['start'])} --> {_fmt_vtt_time(seg['end'])}")
        lines.append(seg["text"].strip())
        lines.append("")
    content = "\n".join(lines)
    stem = _sanitize_filename(Path(job.get("filename") or "subtitles").stem)
    return PlainTextResponse(
        content,
        media_type="text/vtt",
        headers={"Content-Disposition": f'attachment; filename="{stem}.vtt"'},
    )


# ── Audio clip extraction ───────────────────────────────────────────────────

class ClipRequest(BaseModel):
    start:  float       # seconds
    end:    float       # seconds
    format: str = "mp3" # mp3 | wav | m4a


@app.post("/api/clip/{job_id}")
async def extract_clip(job_id: str, req: ClipRequest, _: bool = Depends(verify_auth)):
    """Extract a time-range clip from an uploaded audio file using ffmpeg."""
    with _lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    audio_path = Path(job.get("audio_path", ""))
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    if req.end <= req.start:
        raise HTTPException(status_code=400, detail="end must be greater than start")

    allowed_formats = {"mp3", "wav", "m4a", "flac"}
    fmt = req.format.lower()
    if fmt not in allowed_formats:
        raise HTTPException(status_code=400, detail=f"Unsupported format: {fmt}")

    clip_id = str(uuid.uuid4())[:8]
    clip_name = f"{job_id}_clip_{clip_id}.{fmt}"
    clip_path = AUDIO_CACHE / clip_name

    codec_map = {"mp3": "libmp3lame", "wav": "pcm_s16le", "m4a": "aac", "flac": "flac"}
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(req.start),
        "-i", str(audio_path),
        "-t", str(req.end - req.start),
        "-c:a", codec_map[fmt],
        "-vn",
        str(clip_path),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except subprocess.CalledProcessError as exc:
        raise HTTPException(status_code=500, detail=f"ffmpeg error: {exc.stderr.decode()[:200]}")

    return {"clip_id": clip_id, "filename": clip_name, "job_id": job_id}


@app.get("/api/clip/{job_id}/{clip_id}/download")
async def download_clip(job_id: str, clip_id: str, _: bool = Depends(verify_auth)):
    """Download a previously extracted clip."""
    # Find the clip file — any format suffix
    matches = list(AUDIO_CACHE.glob(f"{job_id}_clip_{clip_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Clip not found")
    clip_path = matches[0]
    stem = clip_path.stem
    return FileResponse(clip_path, filename=stem + clip_path.suffix)


# ── Speaker Diarization ────────────────────────────────────────────────────

@app.get("/api/diarize/status")
async def diarize_status(_: bool = Depends(verify_auth)):
    """Return whether pyannote.audio is installed and a token is configured."""
    import diarization as diarz
    available, reason = diarz.check_available()
    hf_token = _settings.get("hf_token", "")
    return {
        "available": available,
        "reason": reason,
        "token_configured": bool(hf_token),
    }


@app.post("/api/diarize/{job_id}")
async def diarize_job(
    job_id: str,
    background_tasks: BackgroundTasks,
    _: bool = Depends(verify_auth),
):
    """
    Run speaker diarization on the audio from a completed transcription job.
    Returns the diarization result (list of speaker segments) synchronously.
    The job's transcript segments are merged with speaker labels and stored.
    """
    with _lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.get("status") != "done":
        raise HTTPException(status_code=400, detail="Transcription must be complete before diarizing")

    audio_path = Path(job.get("audio_path", ""))
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    hf_token = _settings.get("hf_token", "")

    import diarization as diarz

    available, reason = diarz.check_available()
    if not available:
        raise HTTPException(status_code=503, detail=reason)
    if not hf_token:
        raise HTTPException(
            status_code=400,
            detail="HuggingFace token not configured — set it in Settings → Security."
        )

    try:
        raw_diarization = await asyncio.get_event_loop().run_in_executor(
            None, diarz.diarize, audio_path, hf_token
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Diarization failed: {exc}")

    # Merge speaker labels into existing transcript segments
    segments = job.get("segments", [])
    merged = diarz.merge_with_transcript(raw_diarization, segments)

    with _lock:
        _jobs[job_id]["segments"] = merged
        _jobs[job_id]["diarization"] = raw_diarization

    # Persist merged segments to sidecar
    sidecar = AUDIO_CACHE / f"{job_id}.json"
    if sidecar.exists():
        try:
            meta = json.loads(sidecar.read_text())
            meta["segments"] = merged
            meta["diarization"] = raw_diarization
            sidecar.write_text(json.dumps(meta))
        except Exception:
            pass

    return {"segments": merged, "diarization": raw_diarization}


@app.get("/api/files")
async def list_files(_: bool = Depends(verify_auth)):
    """Return metadata for all audio files currently in the cache."""
    files = []
    for sidecar in AUDIO_CACHE.glob("*.json"):
        try:
            meta = json.loads(sidecar.read_text())
            if (AUDIO_CACHE / meta["audio_file"]).exists():
                files.append(meta)
        except Exception:
            pass
    files.sort(key=lambda x: x.get("uploaded_at", ""), reverse=True)
    return files


class RetranscribeRequest(BaseModel):
    enhance_normalize: bool = False
    enhance_denoise:   bool = False
    enhance_isolate:   bool = False
    enhance_separate:  bool = False
    enhance_upsample:  bool = False


@app.post("/api/retranscribe/{job_id}")
async def retranscribe(
    job_id: str,
    background_tasks: BackgroundTasks,
    req: RetranscribeRequest = RetranscribeRequest(),
    _: bool = Depends(verify_auth),
):
    if _engine_status != "ready":
        raise HTTPException(status_code=503, detail="Engine is still loading — please wait.")

    sidecar = AUDIO_CACHE / f"{job_id}.json"
    if not sidecar.exists():
        raise HTTPException(status_code=404, detail="File not found")

    meta       = json.loads(sidecar.read_text())
    audio_path = AUDIO_CACHE / meta["audio_file"]
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    opts = EnhancementOptions(
        normalize=req.enhance_normalize,
        denoise  =req.enhance_denoise,
        isolate  =req.enhance_isolate,
        separate =req.enhance_separate,
        upsample =req.enhance_upsample,
    )

    new_job_id = str(uuid.uuid4())
    with _lock:
        _jobs[new_job_id] = {
            "status":        "pending",
            "status_detail": "",
            "result":        None,
            "error":         None,
            "filename":      meta.get("filename"),
            "audio_path":    str(audio_path),
        }

    background_tasks.add_task(_run_transcription, new_job_id, audio_path, opts)
    return {"job_id": new_job_id}


# ── Audio Enhancement ──────────────────────────────────────────────────────

@app.post("/api/enhance")
async def enhance_audio(
    background_tasks: BackgroundTasks,
    file:              UploadFile = File(...),
    enhance_normalize: bool       = Form(False),
    enhance_denoise:   bool       = Form(False),
    enhance_isolate:   bool       = Form(False),
    enhance_separate:  bool       = Form(False),
    enhance_upsample:  bool       = Form(False),
    _: bool = Depends(verify_auth),
):
    """Upload an audio file and run the enhancement pipeline (no transcription)."""
    suffix = Path(file.filename or "audio").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {suffix}. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    contents = await file.read()
    size_mb  = len(contents) / (1024 * 1024)
    max_mb   = int(_settings.get("max_upload_size_mb", "500"))

    if max_mb > 0 and size_mb > max_mb:
        raise HTTPException(
            status_code=413,
            detail=f"File too large: {size_mb:.1f} MB. Maximum: {max_mb} MB",
        )

    job_id     = str(uuid.uuid4())
    audio_path = AUDIO_CACHE / f"{job_id}{suffix}"

    with open(audio_path, "wb") as f:
        f.write(contents)

    sidecar = AUDIO_CACHE / f"{job_id}.json"
    sidecar.write_text(json.dumps({
        "job_id":      job_id,
        "filename":    file.filename,
        "audio_file":  audio_path.name,
        "size":        audio_path.stat().st_size,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "type":        "enhance",
    }))

    opts = EnhancementOptions(
        normalize=enhance_normalize,
        denoise  =enhance_denoise,
        isolate  =enhance_isolate,
        separate =enhance_separate,
        upsample =enhance_upsample,
    )

    with _lock:
        _jobs[job_id] = {
            "status":        "pending",
            "status_detail": "",
            "result":        None,
            "error":         None,
            "filename":      file.filename,
            "audio_path":    str(audio_path),
            "enhanced_path": None,
        }

    background_tasks.add_task(_run_enhancement, job_id, audio_path, opts)
    return {"job_id": job_id}


@app.get("/api/enhance/{job_id}/download")
async def download_enhanced(job_id: str, _: bool = Depends(verify_auth)):
    """Download the enhanced audio file produced by a completed enhance job."""
    with _lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "done":
        raise HTTPException(status_code=400, detail="Enhancement not complete")

    enhanced_path = Path(job.get("enhanced_path") or "")
    if not enhanced_path.exists():
        raise HTTPException(status_code=404, detail="Enhanced file not found")

    stem   = _sanitize_filename(Path(job.get("filename") or "audio").stem)
    suffix = enhanced_path.suffix
    return FileResponse(
        enhanced_path,
        media_type="application/octet-stream",
        filename=f"{stem}_enhanced{suffix}",
    )


@app.get("/api/enhance/{job_id}/original")
async def download_original_for_enhance(job_id: str, _: bool = Depends(verify_auth)):
    """Serve the original (pre-enhancement) audio for A/B comparison."""
    with _lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    audio_path = Path(job.get("audio_path") or "")
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    filename = _sanitize_filename(job.get("filename") or audio_path.name)
    return FileResponse(audio_path, media_type="audio/mpeg", filename=filename)


class ReenhanceRequest(BaseModel):
    enhance_normalize: bool = False
    enhance_denoise:   bool = False
    enhance_isolate:   bool = False
    enhance_separate:  bool = False
    enhance_upsample:  bool = False


@app.post("/api/reenhance/{job_id}")
async def reenhance(
    job_id: str,
    background_tasks: BackgroundTasks,
    req: ReenhanceRequest = ReenhanceRequest(),
    _: bool = Depends(verify_auth),
):
    """Re-run enhancement on an existing file with different settings."""
    sidecar = AUDIO_CACHE / f"{job_id}.json"
    if not sidecar.exists():
        raise HTTPException(status_code=404, detail="File not found")

    meta       = json.loads(sidecar.read_text())
    audio_path = AUDIO_CACHE / meta["audio_file"]
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    opts = EnhancementOptions(
        normalize=req.enhance_normalize,
        denoise  =req.enhance_denoise,
        isolate  =req.enhance_isolate,
        separate =req.enhance_separate,
        upsample =req.enhance_upsample,
    )

    new_job_id  = str(uuid.uuid4())
    new_sidecar = AUDIO_CACHE / f"{new_job_id}.json"
    new_sidecar.write_text(json.dumps({
        "job_id":        new_job_id,
        "filename":      meta.get("filename"),
        "audio_file":    meta["audio_file"],   # reuse same original
        "size":          meta.get("size"),
        "uploaded_at":   datetime.now(timezone.utc).isoformat(),
        "type":          "enhance",
        "original_job":  job_id,
    }))

    with _lock:
        _jobs[new_job_id] = {
            "status":        "pending",
            "status_detail": "",
            "result":        None,
            "error":         None,
            "filename":      meta.get("filename"),
            "audio_path":    str(audio_path),
            "enhanced_path": None,
        }

    background_tasks.add_task(_run_enhancement, new_job_id, audio_path, opts)
    return {"job_id": new_job_id}


# ── Interactive Audio Pipeline ─────────────────────────────────────────────

_PIPELINE_VALID_STEPS = {"normalize", "denoise", "isolate", "separate", "upsample"}

_pipeline_sessions: dict[str, dict] = {}


def _run_pipeline_step(session_id: str, step: str) -> None:
    """Background task: apply a single enhancement step to the pipeline current audio."""
    with _lock:
        session = _pipeline_sessions.get(session_id)
    if not session:
        return

    try:
        current_file = Path(session["current_file"])
        step_index   = len(session["steps"])
        out_file     = AUDIO_CACHE / f"{session_id}_step{step_index}{current_file.suffix or '.wav'}"

        AudioPipeline().run_single_step(current_file, step, out_file)

        step_record = {
            "step":        step,
            "output_file": out_file.name,
            "timestamp":   datetime.now(timezone.utc).isoformat(),
        }

        with _lock:
            _pipeline_sessions[session_id]["steps"].append(step_record)
            _pipeline_sessions[session_id]["current_file"]  = str(out_file)
            _pipeline_sessions[session_id]["status"]        = "idle"
            _pipeline_sessions[session_id]["status_detail"] = ""

    except Exception as exc:
        traceback.print_exc()
        with _lock:
            _pipeline_sessions[session_id]["status"] = "error"
            _pipeline_sessions[session_id]["error"]  = str(exc) or repr(exc)


@app.post("/api/pipeline")
async def create_pipeline(
    file: UploadFile = File(...),
    _: bool = Depends(verify_auth),
):
    """Create a new interactive pipeline session by uploading an audio file."""
    suffix = Path(file.filename or "audio").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {suffix}. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    contents = await file.read()
    size_mb  = len(contents) / (1024 * 1024)
    max_mb   = int(_settings.get("max_upload_size_mb", "500"))
    if max_mb > 0 and size_mb > max_mb:
        raise HTTPException(
            status_code=413,
            detail=f"File too large: {size_mb:.1f} MB. Maximum: {max_mb} MB",
        )

    session_id = str(uuid.uuid4())
    audio_path = AUDIO_CACHE / f"{session_id}_original{suffix}"
    with open(audio_path, "wb") as f:
        f.write(contents)

    session = {
        "session_id":    session_id,
        "filename":      file.filename,
        "original_file": audio_path.name,
        "current_file":  str(audio_path),
        "steps":         [],
        "transcription": None,
        "status":        "idle",
        "status_detail": "",
        "error":         None,
    }
    with _lock:
        _pipeline_sessions[session_id] = session

    return {"session_id": session_id, "filename": file.filename}


@app.get("/api/pipeline/{session_id}")
async def get_pipeline_session(session_id: str, _: bool = Depends(verify_auth)):
    """Return the current state of a pipeline session."""
    with _lock:
        session = _pipeline_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Pipeline session not found")
    return session


class PipelineStepRequest(BaseModel):
    step: str  # "normalize" | "denoise" | "isolate" | "upsample"


@app.post("/api/pipeline/{session_id}/step")
async def apply_pipeline_step(
    session_id: str,
    req: PipelineStepRequest,
    background_tasks: BackgroundTasks,
    _: bool = Depends(verify_auth),
):
    """Apply a single named enhancement step to the pipeline's current audio."""
    if req.step not in _PIPELINE_VALID_STEPS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid step: {req.step!r}. Must be one of: {', '.join(sorted(_PIPELINE_VALID_STEPS))}",
        )

    with _lock:
        session = _pipeline_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Pipeline session not found")
    if session["status"] == "processing":
        raise HTTPException(status_code=409, detail="A step is already in progress")

    with _lock:
        _pipeline_sessions[session_id]["status"]        = "processing"
        _pipeline_sessions[session_id]["status_detail"] = f"Applying {req.step}…"
        _pipeline_sessions[session_id]["error"]         = None

    background_tasks.add_task(_run_pipeline_step, session_id, req.step)
    return {"status": "processing", "step": req.step}


@app.get("/api/pipeline/{session_id}/audio")
async def get_pipeline_audio(
    session_id: str,
    step: str = Query(default="current"),
    _: bool = Depends(verify_auth),
):
    """
    Serve audio for a pipeline session.
    ?step=current (default) — latest processed audio
    ?step=original          — the original uploaded file
    ?step=0, 1, 2, ...     — output of step N
    """
    with _lock:
        session = _pipeline_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Pipeline session not found")

    if step == "original":
        audio_path = AUDIO_CACHE / session["original_file"]
    elif step == "current":
        audio_path = Path(session["current_file"])
    else:
        try:
            idx   = int(step)
            steps = session["steps"]
            if idx < 0 or idx >= len(steps):
                raise HTTPException(status_code=404, detail=f"Step {idx} not found")
            audio_path = AUDIO_CACHE / steps[idx]["output_file"]
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid step parameter: {step!r}")

    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    return FileResponse(audio_path, media_type="audio/mpeg")


@app.delete("/api/pipeline/{session_id}/step")
async def undo_pipeline_step(session_id: str, _: bool = Depends(verify_auth)):
    """Remove the last enhancement step and revert to the previous audio state."""
    with _lock:
        session = _pipeline_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Pipeline session not found")
    if session["status"] == "processing":
        raise HTTPException(status_code=409, detail="Cannot undo while a step is in progress")
    if not session["steps"]:
        raise HTTPException(status_code=400, detail="No steps to undo")

    with _lock:
        steps   = _pipeline_sessions[session_id]["steps"]
        removed = steps.pop()
        (AUDIO_CACHE / removed["output_file"]).unlink(missing_ok=True)
        if steps:
            _pipeline_sessions[session_id]["current_file"] = str(AUDIO_CACHE / steps[-1]["output_file"])
        else:
            _pipeline_sessions[session_id]["current_file"] = str(AUDIO_CACHE / session["original_file"])
        _pipeline_sessions[session_id]["error"] = None
        steps_remaining = len(steps)

    return {"status": "ok", "steps_remaining": steps_remaining}


@app.post("/api/pipeline/{session_id}/transcribe")
async def transcribe_pipeline_audio(
    session_id: str,
    background_tasks: BackgroundTasks,
    _: bool = Depends(verify_auth),
):
    """Transcribe the pipeline's current audio using the configured Whisper engine."""
    if _engine_status != "ready":
        raise HTTPException(status_code=503, detail="Engine is still loading — please wait.")

    with _lock:
        session = _pipeline_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Pipeline session not found")
    if session["status"] == "processing":
        raise HTTPException(status_code=409, detail="A step is still in progress")

    current_file = Path(session["current_file"])
    if not current_file.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    job_id     = str(uuid.uuid4())
    audio_path = AUDIO_CACHE / f"{job_id}{current_file.suffix}"
    shutil.copy2(current_file, audio_path)

    sidecar = AUDIO_CACHE / f"{job_id}.json"
    sidecar.write_text(json.dumps({
        "job_id":           job_id,
        "filename":         session.get("filename"),
        "audio_file":       audio_path.name,
        "size":             audio_path.stat().st_size,
        "uploaded_at":      datetime.now(timezone.utc).isoformat(),
        "pipeline_session": session_id,
    }))

    with _lock:
        _jobs[job_id] = {
            "status":        "pending",
            "status_detail": "",
            "result":        None,
            "segments":      [],
            "language":      None,
            "error":         None,
            "filename":      session.get("filename"),
            "audio_path":    str(audio_path),
        }

    background_tasks.add_task(_run_transcription, job_id, audio_path, EnhancementOptions())

    with _lock:
        _pipeline_sessions[session_id]["transcription"] = job_id

    return {"job_id": job_id}


@app.delete("/api/pipeline/{session_id}")
async def delete_pipeline_session(session_id: str, _: bool = Depends(verify_auth)):
    """Delete a pipeline session and clean up all its audio files."""
    with _lock:
        session = _pipeline_sessions.pop(session_id, None)
    if session is None:
        raise HTTPException(status_code=404, detail="Pipeline session not found")

    # Delete original and all step output files
    for name in [session["original_file"]] + [s["output_file"] for s in session.get("steps", [])]:
        (AUDIO_CACHE / name).unlink(missing_ok=True)

    return {"status": "ok"}


@app.get("/api/pipeline/{session_id}/download")
async def download_pipeline_audio(session_id: str, _: bool = Depends(verify_auth)):
    """Download the current (latest) processed audio from a pipeline session."""
    with _lock:
        session = _pipeline_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Pipeline session not found")

    audio_path = Path(session["current_file"])
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    stem   = _sanitize_filename(Path(session.get("filename") or "audio").stem)
    suffix = audio_path.suffix
    steps  = session.get("steps", [])
    label  = f"_pipeline_{len(steps)}steps" if steps else "_original"
    return FileResponse(
        audio_path,
        media_type="application/octet-stream",
        filename=f"{stem}{label}{suffix}",
    )


# ── YouTube Download Tool ──────────────────────────────────────────────────

_yt_download_jobs: dict[str, dict] = {}


class YouTubeDownloadRequest(BaseModel):
    url:           str
    mode:          str = "audio"   # "video" | "audio"
    video_quality: str = "best"    # "best" | "2160" | "1080" | "720" | "480" | "360"
    video_format:  str = "mp4"     # "mp4" | "webm" | "mkv"
    audio_format:  str = "mp3"     # "mp3" | "m4a" | "flac" | "wav" | "ogg" | "opus"
    audio_quality: str = "192"     # "128" | "192" | "256" | "320" | "best"


def _run_yt_download(job_id: str, req: YouTubeDownloadRequest) -> None:
    """Background task: download a YouTube video or audio file."""
    from extractors.youtube import download_video, download_audio, _VALID_VIDEO_FORMATS, _VALID_AUDIO_FORMATS, _VALID_VIDEO_QUALITIES

    def _status(detail: str) -> None:
        with _lock:
            _yt_download_jobs[job_id]["status_detail"] = detail

    tmpdir = Path(tempfile.mkdtemp())
    try:
        if req.mode == "video":
            fmt = req.video_format if req.video_format in _VALID_VIDEO_FORMATS else "mp4"
            quality = req.video_quality if req.video_quality in _VALID_VIDEO_QUALITIES else "best"
            _status(f"Downloading {quality}p {fmt.upper()} video…")
            output_path = download_video(req.url, tmpdir, quality=quality, fmt=fmt, cookies=_settings.get("youtube_cookies") or None)
        else:
            fmt = req.audio_format if req.audio_format in _VALID_AUDIO_FORMATS else "mp3"
            _status(f"Downloading {fmt.upper()} audio…")
            output_path = download_audio(req.url, tmpdir, fmt=fmt, quality=req.audio_quality, cookies=_settings.get("youtube_cookies") or None)

        # Move to stable cache location
        dest = AUDIO_CACHE / f"{job_id}_{output_path.name}"
        shutil.move(str(output_path), dest)

        with _lock:
            _yt_download_jobs[job_id]["status"]       = "done"
            _yt_download_jobs[job_id]["status_detail"] = ""
            _yt_download_jobs[job_id]["output_file"]   = str(dest)
            _yt_download_jobs[job_id]["filename"]      = output_path.name

    except Exception as exc:
        with _lock:
            _yt_download_jobs[job_id]["status"] = "error"
            _yt_download_jobs[job_id]["error"]  = str(exc)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


@app.get("/api/youtube/info")
async def youtube_info(url: str = Query(...), _: bool = Depends(verify_auth)):
    """Fetch YouTube video metadata without downloading."""
    from extractors.youtube import get_video_info
    try:
        info = await asyncio.to_thread(get_video_info, url, _settings.get("youtube_cookies") or None)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return info


@app.post("/api/youtube/download")
async def youtube_download(
    req: YouTubeDownloadRequest,
    background_tasks: BackgroundTasks,
    _: bool = Depends(verify_auth),
):
    """Start a YouTube download job."""
    job_id = str(uuid.uuid4())
    with _lock:
        _yt_download_jobs[job_id] = {
            "status":        "pending",
            "status_detail": "",
            "output_file":   None,
            "filename":      None,
            "error":         None,
        }
    background_tasks.add_task(_run_yt_download, job_id, req)
    return {"job_id": job_id}


@app.get("/api/youtube/{job_id}")
async def youtube_job_status(job_id: str, _: bool = Depends(verify_auth)):
    """Poll the status of a YouTube download job."""
    with _lock:
        job = _yt_download_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Download job not found")
    return job


@app.get("/api/youtube/{job_id}/file")
async def youtube_download_file(job_id: str, _: bool = Depends(verify_auth)):
    """Download the completed file from a YouTube download job."""
    with _lock:
        job = _yt_download_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Download job not found")
    if job["status"] != "done":
        raise HTTPException(status_code=400, detail="Download not complete")

    output_path = Path(job["output_file"])
    if not output_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    filename = _sanitize_filename(job.get("filename") or output_path.name)
    return FileResponse(output_path, media_type="application/octet-stream", filename=filename)


# ── SPA catch-all — must be the last route registered ─────────────────────
@app.get("/{full_path:path}")
async def spa_fallback(full_path: str, _: bool = Depends(verify_auth)):
    # Show loading/error page while the engine is initializing.
    if _engine_status != "ready":
        if _engine_status == "error":
            return HTMLResponse(_loading_page(_engine_message, is_error=True), status_code=500)
        return HTMLResponse(_loading_page(_engine_message))

    # Serve real static files (favicon, assets/, etc.) — protect against traversal.
    if full_path:
        candidate = (_STATIC_DIR / full_path).resolve()
        try:
            if str(candidate).startswith(str(_STATIC_DIR.resolve())) and candidate.is_file():
                return FileResponse(candidate)
        except (OSError, ValueError):
            pass

    # All other paths → React SPA entry point.
    index = _STATIC_DIR / "index.html"
    if index.exists():
        return FileResponse(index)

    return HTMLResponse(
        "Frontend not built. Run: <code>cd frontend && npm install && npm run build</code>",
        status_code=503,
    )
