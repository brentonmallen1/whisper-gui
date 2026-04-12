#!/usr/bin/env python3
"""
download_models.py — Pre-download and verify model weights at container startup.

Called by entrypoint.sh before uvicorn starts. Uses huggingface_hub's
snapshot_download which checks ETags so only changed/missing files are fetched.
HF_HOME controls where HuggingFace models are cached (set to /models/hf in Docker).
"""
import os
import sys
from pathlib import Path

# Mirror the same defaults as main.py so `just download` works locally
# without any extra env config. Docker overrides these via docker-compose.yml.
_CACHE_BASE = Path(__file__).parent / "cache"

if "HF_HOME" not in os.environ:
    os.environ["HF_HOME"] = str(_CACHE_BASE / "models" / "hf")

ENGINE = os.getenv("TRANSCRIPTION_ENGINE", "faster-whisper")
WHISPER_DOWNLOAD_ROOT = os.getenv("WHISPER_DOWNLOAD_ROOT", str(_CACHE_BASE / "models" / "whisper"))

# Maps shorter model names to HuggingFace repo IDs.
# Used as a fallback only — download_faster_whisper() prefers faster-whisper's
# own internal _MODELS table so this stays in sync with the installed library.
_SALM_MODELS = {"nvidia/canary-qwen-2.5b"}

_FASTER_WHISPER_REPOS_FALLBACK: dict[str, str] = {
    "tiny":           "Systran/faster-whisper-tiny",
    "base":           "Systran/faster-whisper-base",
    "small":          "Systran/faster-whisper-small",
    "medium":         "Systran/faster-whisper-medium",
    "large":          "Systran/faster-whisper-large-v1",
    "large-v2":       "Systran/faster-whisper-large-v2",
    "large-v3":       "Systran/faster-whisper-large-v3",
}


def _hf_snapshot(repo_id: str) -> None:
    """Download or update a HuggingFace repo into HF_HOME cache."""
    from huggingface_hub import snapshot_download
    print(f"  Checking {repo_id} for updates ...")
    snapshot_download(repo_id=repo_id)
    print(f"  {repo_id} is up to date.")


def download_whisper() -> None:
    """openai-whisper downloads .pt files to WHISPER_DOWNLOAD_ROOT."""
    import whisper as _whisper
    model_size = os.getenv("WHISPER_MODEL_SIZE", "large-v3")
    print(f"[whisper] Checking model '{model_size}' ...")
    _whisper.load_model(model_size, download_root=WHISPER_DOWNLOAD_ROOT)
    print(f"[whisper] '{model_size}' ready.")


def download_faster_whisper() -> None:
    """faster-whisper models are CTranslate2 format, hosted on HuggingFace."""
    model_size = os.getenv("WHISPER_MODEL_SIZE", "large-v3")
    print(f"[faster-whisper] Checking model '{model_size}' ...")

    # Prefer faster-whisper's own internal model→repo mapping so we stay in sync
    # with whatever version is installed — no separate table to maintain.
    repo_id: str | None = None
    try:
        from faster_whisper.transcribe import _MODELS  # dict[str, str]
        repo_id = _MODELS.get(model_size)
    except (ImportError, AttributeError):
        pass

    # Fall back to our own table for common sizes
    if repo_id is None:
        repo_id = _FASTER_WHISPER_REPOS_FALLBACK.get(model_size)

    # If model_size looks like a full HF repo ID, use it directly
    if repo_id is None and "/" in model_size:
        repo_id = model_size

    if repo_id is None:
        print(f"[faster-whisper] No known HF repo for '{model_size}' — model will download on first use.")
        return

    _hf_snapshot(repo_id)
    print(f"[faster-whisper] '{model_size}' ready.")


def download_canary() -> None:
    """Canary models — hosted on HuggingFace under nvidia/."""
    model_name = os.getenv("CANARY_MODEL", "nvidia/canary-qwen-2.5b")
    print(f"[canary] Checking model '{model_name}' ...")
    _hf_snapshot(model_name)
    print(f"[canary] '{model_name}' ready.")


def download_qwen_audio() -> None:
    """Qwen2-Audio models — hosted on HuggingFace under Qwen/."""
    model_name = os.getenv("QWEN_MODEL", "Qwen/Qwen2-Audio-7B-Instruct")
    print(f"[qwen-audio] Checking model '{model_name}' ...")
    _hf_snapshot(model_name)
    print(f"[qwen-audio] '{model_name}' ready.")


def main() -> None:
    print(f"[startup] Engine: {ENGINE}")
    print(f"[startup] HF cache: {os.getenv('HF_HOME', '~/.cache/huggingface')}")

    dispatch = {
        "whisper":        download_whisper,
        "faster-whisper": download_faster_whisper,
        "canary":         download_canary,
        "qwen-audio":     download_qwen_audio,
    }

    fn = dispatch.get(ENGINE)
    if fn is None:
        print(f"[startup] Unknown engine '{ENGINE}'.", file=sys.stderr)
        sys.exit(1)

    try:
        fn()
        print("[startup] Model ready.")
    except Exception as exc:
        print(f"[startup] Warning: pre-download failed: {exc}", file=sys.stderr)
        print("[startup] Server will start anyway — model downloads on first use.", file=sys.stderr)


if __name__ == "__main__":
    main()
