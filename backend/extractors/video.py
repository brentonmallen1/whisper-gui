"""
Video extractor — strips audio with ffmpeg, optionally enhances, then transcribes.
Accepts common video formats: mp4, mkv, avi, mov, wmv, flv, m4v, webm.
"""

import asyncio
import subprocess
import tempfile
from pathlib import Path

from .base import StatusCallback


class VideoExtractor:
    def __init__(self, engine, pipeline=None, options=None) -> None:
        self.engine   = engine
        self.pipeline = pipeline   # AudioPipeline | None
        self.options  = options    # EnhancementOptions | None

    async def extract(self, file_path: Path, on_status: StatusCallback) -> str:
        await on_status("extracting", "Extracting audio from video…")
        audio_path = await asyncio.to_thread(self._strip_audio, file_path)

        enhanced = audio_path
        try:
            if self.pipeline and self.options and self.options.any_active:
                enhanced = await self.pipeline.run(audio_path, self.options, on_status)

            await on_status("transcribing", "Running Whisper transcription — this may take a while…")
            return await asyncio.to_thread(self._transcribe, enhanced)
        finally:
            audio_path.unlink(missing_ok=True)
            if enhanced != audio_path:
                enhanced.unlink(missing_ok=True)

    def _strip_audio(self, file_path: Path) -> Path:
        tmp = Path(tempfile.mktemp(suffix=".mp3"))
        subprocess.run(
            [
                "ffmpeg", "-i", str(file_path),
                "-vn",           # no video
                "-acodec", "mp3",
                "-y",
                str(tmp),
            ],
            check=True,
            capture_output=True,
        )
        return tmp

    def _transcribe(self, audio_path: Path) -> str:
        return self.engine.transcribe(str(audio_path))
