"""
Audio extractor — optionally enhances then transcribes audio files via Whisper.
Accepts any audio format supported by the engine (mp3, wav, m4a, flac, …).
"""

import asyncio
from pathlib import Path

from .base import StatusCallback


class AudioExtractor:
    def __init__(self, engine, pipeline=None, options=None) -> None:
        self.engine   = engine
        self.pipeline = pipeline   # AudioPipeline | None
        self.options  = options    # EnhancementOptions | None

    async def extract(self, file_path: Path, on_status: StatusCallback) -> str:
        enhanced = file_path

        if self.pipeline and self.options and self.options.any_active:
            enhanced = await self.pipeline.run(file_path, self.options, on_status)

        try:
            await on_status("transcribing", "Running Whisper transcription — this may take a while…")
            return await asyncio.to_thread(self._run, enhanced)
        finally:
            if enhanced != file_path:
                enhanced.unlink(missing_ok=True)

    def _run(self, file_path: Path) -> str:
        return self.engine.transcribe(str(file_path))
