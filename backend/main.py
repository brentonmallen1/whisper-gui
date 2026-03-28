import asyncio
import base64
import json
import os
import secrets
import shutil
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
# ──────────────────────────────────────────────────────────────────────────

from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles

from transcriber import load_engine

_STATIC_DIR = Path(__file__).parent / "static"

AUDIO_CACHE = Path(os.getenv("AUDIO_CACHE_DIR", _CACHE_BASE / "audio"))
AUDIO_CACHE.mkdir(parents=True, exist_ok=True)

# 0 = disabled; positive integer = hours before cached audio files are purged.
AUDIO_CACHE_TTL_HOURS = int(os.getenv("AUDIO_CACHE_TTL_HOURS", "72"))

# Maximum upload size in MB. 0 = unlimited.
MAX_UPLOAD_SIZE_MB = int(os.getenv("MAX_UPLOAD_SIZE_MB", "500"))

# Allowed audio file extensions (lowercase, with dot).
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".webm", ".opus", ".aac", ".wma"}

# ── Authentication ─────────────────────────────────────────────────────────
# Set AUTH_ENABLED=true to require HTTP Basic Auth for all endpoints.
AUTH_ENABLED = os.getenv("AUTH_ENABLED", "false").lower() in ("true", "1", "yes")
AUTH_USERNAME = os.getenv("AUTH_USERNAME", "admin")
AUTH_PASSWORD = os.getenv("AUTH_PASSWORD", "")

security = HTTPBasic(auto_error=False)


def verify_auth(credentials: HTTPBasicCredentials | None = Depends(security)) -> bool:
    """Verify HTTP Basic Auth credentials if auth is enabled."""
    if not AUTH_ENABLED:
        return True

    if not AUTH_PASSWORD:
        # Auth enabled but no password set — reject all requests with helpful error
        raise HTTPException(
            status_code=500,
            detail="AUTH_ENABLED=true but AUTH_PASSWORD is not set. "
                   "Set AUTH_PASSWORD in your environment or disable auth.",
        )

    if credentials is None:
        raise HTTPException(
            status_code=401,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Basic realm=\"Whisper GUI\""},
        )

    # Use constant-time comparison to prevent timing attacks
    username_ok = secrets.compare_digest(credentials.username.encode(), AUTH_USERNAME.encode())
    password_ok = secrets.compare_digest(credentials.password.encode(), AUTH_PASSWORD.encode())

    if not (username_ok and password_ok):
        raise HTTPException(
            status_code=401,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Basic realm=\"Whisper GUI\""},
        )

    return True

# In-memory job store. Fine for single-user self-hosted use.
_jobs: dict[str, dict] = {}
_lock = threading.Lock()

# Engine state — loaded in a background thread so the server starts immediately.
_engine = None
_engine_status = "loading"   # loading | ready | error
_engine_message = "Starting up..."


def _load_engine_background() -> None:
    global _engine, _engine_status, _engine_message

    engine_name = os.getenv("TRANSCRIPTION_ENGINE", "faster-whisper")
    model_name = os.getenv("WHISPER_MODEL_SIZE", "large-v3-turbo")
    _engine_message = f"Loading {engine_name} · {model_name}…"

    try:
        _engine = load_engine()
        _engine_status = "ready"
        _engine_message = "Ready"
    except Exception as exc:
        _engine_status = "error"
        _engine_message = str(exc)


def _purge_old_audio() -> None:
    """Delete audio files (and their sidecars) older than AUDIO_CACHE_TTL_HOURS."""
    cutoff = time.time() - (AUDIO_CACHE_TTL_HOURS * 3600)
    for f in list(AUDIO_CACHE.iterdir()):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
        except OSError:
            pass


async def _purge_loop() -> None:
    _purge_old_audio()          # run once at startup to clean up expired files
    while True:
        await asyncio.sleep(3600)
        _purge_old_audio()


@asynccontextmanager
async def lifespan(_: FastAPI):
    thread = threading.Thread(target=_load_engine_background, daemon=True)
    thread.start()
    if AUDIO_CACHE_TTL_HOURS > 0:
        asyncio.create_task(_purge_loop())
    yield


app = FastAPI(title="Whisper GUI", lifespan=lifespan)


# ── Auth middleware for static files ─────────────────────────────────────────
# FastAPI's StaticFiles mount doesn't use Depends(), so we need middleware.
@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    # Skip auth check if auth is disabled
    if not AUTH_ENABLED:
        return await call_next(request)

    # Check if password is configured
    if not AUTH_PASSWORD:
        return Response(
            content="AUTH_ENABLED=true but AUTH_PASSWORD is not set.",
            status_code=500,
        )

    # Check Authorization header
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Basic "):
        try:
            decoded = base64.b64decode(auth_header[6:]).decode("utf-8")
            username, password = decoded.split(":", 1)
            username_ok = secrets.compare_digest(username.encode(), AUTH_USERNAME.encode())
            password_ok = secrets.compare_digest(password.encode(), AUTH_PASSWORD.encode())
            if username_ok and password_ok:
                return await call_next(request)
        except Exception:
            pass

    # Return 401 with WWW-Authenticate header to trigger browser login prompt
    return Response(
        content="Authentication required",
        status_code=401,
        headers={"WWW-Authenticate": "Basic realm=\"Whisper GUI\""},
    )


# ── Root — serve loading page or main app depending on engine state ───────────

def _loading_page(message: str, is_error: bool = False) -> str:
    color = "#ef4444" if is_error else "#6366f1"
    spinner = "" if is_error else """
      <div style="
        width:40px;height:40px;border-radius:50%;
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
          } catch (_) { el.textContent = 'Waiting for server…'; }
          setTimeout(poll, 1500);
        };
        poll();
      </script>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Whisper GUI</title>
  <style>
    *{{box-sizing:border-box;margin:0;padding:0}}
    body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          background:#e6e8ec;display:flex;align-items:center;
          justify-content:center;min-height:100vh;}}
    .card{{background:#eef0f3;border:1px solid #c8cdd5;border-radius:12px;
           padding:48px 40px;text-align:center;max-width:420px;width:90%;}}
    svg{{color:#6366f1;margin-bottom:16px}}
    h1{{font-size:1.3rem;font-weight:700;color:#1e2330;margin-bottom:24px}}
    p{{font-size:.88rem;line-height:1.6;color:{color}}}
  </style>
</head>
<body>
  <div class="card">
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
    <h1>Whisper GUI</h1>
    {spinner}
    <p id="msg">{message}</p>
  </div>
  {reload_script}
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
async def root(_: bool = Depends(verify_auth)):
    if _engine_status == "ready":
        return FileResponse(_STATIC_DIR / "index.html")
    if _engine_status == "error":
        return HTMLResponse(_loading_page(_engine_message, is_error=True), status_code=500)
    return HTMLResponse(_loading_page(_engine_message))


# ── Readiness ─────────────────────────────────────────────────────────────────

@app.get("/api/ready")
async def get_ready(_: bool = Depends(verify_auth)):
    return {"status": _engine_status, "message": _engine_message}


# ── Transcription ─────────────────────────────────────────────────────────────

def _run_transcription(job_id: str, audio_path: Path) -> None:
    with _lock:
        _jobs[job_id]["status"] = "processing"
    try:
        result = _engine.transcribe(str(audio_path))
        with _lock:
            _jobs[job_id]["status"] = "done"
            _jobs[job_id]["result"] = result
    except Exception as exc:
        with _lock:
            _jobs[job_id]["status"] = "error"
            _jobs[job_id]["error"] = str(exc)


def _sanitize_filename(filename: str) -> str:
    """Sanitize filename for Content-Disposition header."""
    # Remove any path components and problematic characters
    name = Path(filename).name
    # Remove characters that could break headers or cause issues
    return "".join(c for c in name if c.isalnum() or c in "._- ").strip() or "audio"


@app.post("/api/transcribe")
async def transcribe(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    _: bool = Depends(verify_auth),
):
    if _engine_status != "ready":
        raise HTTPException(status_code=503, detail="Engine is still loading — please wait.")

    # Validate file extension
    suffix = Path(file.filename or "audio").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {suffix}. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    # Validate file size (read into memory to check, then write)
    contents = await file.read()
    size_mb = len(contents) / (1024 * 1024)

    if MAX_UPLOAD_SIZE_MB > 0 and size_mb > MAX_UPLOAD_SIZE_MB:
        raise HTTPException(
            status_code=413,
            detail=f"File too large: {size_mb:.1f} MB. Maximum: {MAX_UPLOAD_SIZE_MB} MB",
        )

    job_id = str(uuid.uuid4())
    audio_path = AUDIO_CACHE / f"{job_id}{suffix}"

    with open(audio_path, "wb") as f:
        f.write(contents)

    # Persist metadata so the file browser survives server restarts.
    sidecar = AUDIO_CACHE / f"{job_id}.json"
    sidecar.write_text(json.dumps({
        "job_id": job_id,
        "filename": file.filename,
        "audio_file": audio_path.name,
        "size": audio_path.stat().st_size,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }))

    with _lock:
        _jobs[job_id] = {
            "status": "pending",
            "result": None,
            "error": None,
            "filename": file.filename,
            "audio_path": str(audio_path),
        }

    background_tasks.add_task(_run_transcription, job_id, audio_path)
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


@app.post("/api/retranscribe/{job_id}")
async def retranscribe(
    job_id: str,
    background_tasks: BackgroundTasks,
    _: bool = Depends(verify_auth),
):
    if _engine_status != "ready":
        raise HTTPException(status_code=503, detail="Engine is still loading — please wait.")

    sidecar = AUDIO_CACHE / f"{job_id}.json"
    if not sidecar.exists():
        raise HTTPException(status_code=404, detail="File not found")

    meta = json.loads(sidecar.read_text())
    audio_path = AUDIO_CACHE / meta["audio_file"]
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    new_job_id = str(uuid.uuid4())
    with _lock:
        _jobs[new_job_id] = {
            "status": "pending",
            "result": None,
            "error": None,
            "filename": meta.get("filename"),
            "audio_path": str(audio_path),
        }

    background_tasks.add_task(_run_transcription, new_job_id, audio_path)
    return {"job_id": new_job_id}


@app.get("/api/info")
async def get_info(_: bool = Depends(verify_auth)):
    import torch

    gpu_available = torch.cuda.is_available()
    return {
        "status": _engine_status,
        "engine": os.getenv("TRANSCRIPTION_ENGINE", "faster-whisper"),
        "model": _engine.model_name if _engine else None,
        "gpu_available": gpu_available,
        "gpu_name": torch.cuda.get_device_name(0) if gpu_available else None,
    }


# Static assets (CSS, JS, etc.) — mounted after all explicit routes.
app.mount("/", StaticFiles(directory=str(_STATIC_DIR)), name="static")
