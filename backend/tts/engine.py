"""
Kokoro TTS engine wrapper.

Provides:
  TTSEngine       - Singleton for text-to-speech synthesis
  get_tts_status  - Check package/weights availability
  download_tts_model - Download model weights on demand
"""

import importlib.util
import io
import os
from pathlib import Path

from .voices import DEFAULT_VOICE


def _pkg(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def _hf_model_cached(repo_id: str) -> bool:
    hf_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    repo_dir = hf_home / "hub" / ("models--" + repo_id.replace("/", "--"))
    return repo_dir.exists() and any(True for _ in repo_dir.glob("snapshots/*"))


_KOKORO_REPO = "hexgrad/Kokoro-82M"


def get_tts_status() -> dict[str, bool]:
    """Return TTS availability: whether the package is installed and weights are cached."""
    kokoro_ok = _pkg("kokoro")
    return {
        "package": kokoro_ok,
        "weights": _hf_model_cached(_KOKORO_REPO) if kokoro_ok else False,
    }


def download_tts_model() -> None:
    """Download Kokoro model weights and all voice files. Raises RuntimeError if package not installed."""
    if not _pkg("kokoro"):
        raise RuntimeError(
            "kokoro package not installed. Install with: uv add kokoro soundfile"
        )
    from huggingface_hub import hf_hub_download
    from kokoro import KPipeline  # noqa: F401

    # Download model weights
    KPipeline(lang_code="a")  # 'a' = American English; triggers HF Hub download

    # Pre-download all voice .pt files so they're ready without a per-voice fetch
    from .voices import VOICES
    for voice_id in VOICES:
        hf_hub_download(repo_id=_KOKORO_REPO, filename=f"voices/{voice_id}.pt")


class TTSEngine:
    """Singleton Kokoro TTS engine with lazy model loading."""

    _instance: "TTSEngine | None" = None
    _pipeline = None

    def __new__(cls) -> "TTSEngine":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def _ensure_loaded(self) -> None:
        if self._pipeline is None:
            if not _pkg("kokoro"):
                raise RuntimeError("kokoro package not installed")
            from kokoro import KPipeline
            self._pipeline = KPipeline(lang_code="a")

    def synthesize(self, text: str, voice: str = DEFAULT_VOICE) -> bytes:
        """
        Synthesize text to WAV audio.
        Returns raw WAV bytes suitable for streaming or blob playback.
        """
        self._ensure_loaded()
        import numpy as np
        import soundfile as sf

        chunks = []
        sample_rate = 24000  # Kokoro default
        for _, _, audio in self._pipeline(text, voice=voice, speed=1.0):
            if audio is not None:
                chunks.append(audio)

        audio_data = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)

        buffer = io.BytesIO()
        sf.write(buffer, audio_data, sample_rate, format="WAV")
        buffer.seek(0)
        return buffer.read()
