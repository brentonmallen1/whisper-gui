import asyncio
import base64
import json
import os
import secrets
import tempfile
import threading
import time
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

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel
from fastapi.security import HTTPBasic, HTTPBasicCredentials

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
    return _settings.get("app_name", "Distill")


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

    yield


app = FastAPI(title="Distill", lifespan=lifespan)


# ── Auth middleware (covers static asset requests) ─────────────────────────
@app.middleware("http")
async def auth_middleware(request: Request, call_next):
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
    name = _app_name() if _settings else "Distill"
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
            extractor = YouTubeExtractor(engine=_engine, prefer_captions=req.prefer_captions)
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
        result = _engine.transcribe(str(enhanced))
        with _lock:
            _jobs[job_id]["status"] = "done"
            _jobs[job_id]["result"] = result
    except Exception as exc:
        with _lock:
            _jobs[job_id]["status"] = "error"
            _jobs[job_id]["error"]  = str(exc)
    finally:
        if enhanced != audio_path:
            enhanced.unlink(missing_ok=True)


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
