"""
YouTube extractor.

Fast path (default): fetch auto-generated captions via yt-dlp.
Fallback: download audio → Whisper transcription.

The fallback is also used when prefer_captions=False or when captions
aren't available for the video.

Also provides standalone download helpers used by the YouTube download tool:
  get_video_info()   — fetch metadata without downloading
  download_video()   — download video+audio, optionally remuxed
  download_audio()   — extract/convert audio to a target format
"""

import asyncio
import re
import shutil
import tempfile
from pathlib import Path

from .base import StatusCallback


# ── Standalone download helpers ────────────────────────────────────────────

_VALID_VIDEO_FORMATS  = {"mp4", "webm", "mkv"}
_VALID_AUDIO_FORMATS  = {"mp3", "m4a", "flac", "wav", "ogg", "opus"}
_VALID_VIDEO_QUALITIES = {"best", "2160", "1080", "720", "480", "360"}


def get_video_info(url: str) -> dict:
    """
    Fetch video metadata without downloading.
    Returns: { title, duration_seconds, thumbnail, uploader }
    Raises ValueError for invalid / private / unavailable videos.
    """
    import yt_dlp

    ydl_opts = {
        "quiet":       True,
        "no_warnings": True,
        "skip_download": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
        except Exception as exc:
            raise ValueError(str(exc)) from exc

    return {
        "title":            info.get("title", ""),
        "duration_seconds": info.get("duration"),
        "thumbnail":        info.get("thumbnail"),
        "uploader":         info.get("uploader", ""),
    }


def download_video(
    url: str,
    output_dir: Path,
    quality: str = "best",
    fmt: str = "mp4",
) -> Path:
    """
    Download video+audio and remux to the requested container/codec.

    quality: "best" | "2160" | "1080" | "720" | "480" | "360"
    fmt:     "mp4" | "webm" | "mkv"

    Returns the path to the downloaded file.
    """
    import yt_dlp

    if quality == "best":
        format_spec = "bestvideo+bestaudio/best"
    else:
        # Prefer the target height; fall back to the next lower height available
        format_spec = (
            f"bestvideo[height<={quality}]+bestaudio/best[height<={quality}]/best"
        )

    # Codec mapping for merge_output_format
    # For mkv we just copy streams; for webm we prefer VP9; for mp4 H.264
    merge_fmt = fmt

    ydl_opts = {
        "format":             format_spec,
        "merge_output_format": merge_fmt,
        "outtmpl":            str(output_dir / "%(title)s.%(ext)s"),
        "quiet":              True,
        "no_warnings":        True,
        "writethumbnail":     False,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        filename = ydl.prepare_filename(info)
        # yt-dlp may change the extension after merging
        path = Path(filename)
        if not path.exists():
            # Fallback: search for any file that starts with the stem
            candidates = list(output_dir.glob(f"{path.stem}.*"))
            if candidates:
                path = candidates[0]

    return path


def download_audio(
    url: str,
    output_dir: Path,
    fmt: str = "mp3",
    quality: str = "192",
) -> Path:
    """
    Download and extract audio in the requested format.

    fmt:     "mp3" | "m4a" | "flac" | "wav" | "ogg" | "opus"
    quality: bitrate string for lossy formats ("128","192","256","320")
             or "best" (ignored for lossless)

    Returns the path to the downloaded file.
    """
    import yt_dlp

    # Map our format names to yt-dlp preferredcodec values
    codec_map = {
        "mp3":  "mp3",
        "m4a":  "m4a",
        "flac": "flac",
        "wav":  "wav",
        "ogg":  "vorbis",
        "opus": "opus",
    }
    codec = codec_map.get(fmt, "mp3")
    lossless = fmt in ("flac", "wav")

    postprocessor: dict = {"key": "FFmpegExtractAudio", "preferredcodec": codec}
    if not lossless and quality.isdigit():
        postprocessor["preferredquality"] = quality

    ydl_opts = {
        "format":          "bestaudio/best",
        "outtmpl":         str(output_dir / "%(title)s.%(ext)s"),
        "postprocessors":  [postprocessor],
        "quiet":           True,
        "no_warnings":     True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        # After post-processing the extension changes to the target format
        stem = Path(ydl.prepare_filename(info)).stem
        output_file = output_dir / f"{stem}.{fmt}"
        if not output_file.exists():
            # yt-dlp uses "vorbis" extension as "ogg", handle alias
            alt = output_dir / f"{stem}.ogg" if fmt == "ogg" else None
            if alt and alt.exists():
                output_file = alt
            else:
                candidates = list(output_dir.glob(f"{stem}.*"))
                if candidates:
                    output_file = candidates[0]

    return output_file


class YouTubeExtractor:
    def __init__(self, engine, prefer_captions: bool = True) -> None:
        self.engine = engine
        self.prefer_captions = prefer_captions

    # ── Public ────────────────────────────────────────────────────────────────

    async def extract(self, url: str, on_status: StatusCallback) -> str:
        if self.prefer_captions:
            await on_status("extracting", "Fetching YouTube captions…")
            try:
                captions = await asyncio.to_thread(self._fetch_captions, url)
                if captions:
                    return captions
            except Exception:
                pass
            await on_status("extracting", "Captions unavailable — downloading audio…")
        else:
            await on_status("extracting", "Downloading YouTube audio…")

        audio_path, tmpdir = await asyncio.to_thread(self._download_audio, url)
        await on_status("transcribing", "Running Whisper transcription — this may take a while…")
        try:
            return await asyncio.to_thread(self._transcribe, audio_path)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    # ── Private ───────────────────────────────────────────────────────────────

    def _fetch_captions(self, url: str) -> str | None:
        import yt_dlp

        with tempfile.TemporaryDirectory() as tmpdir:
            ydl_opts = {
                "writeautomaticsub": True,
                "writesubtitles": True,
                "subtitleslangs": ["en", "en-US", "en-GB"],
                "subtitlesformat": "vtt",
                "skip_download": True,
                "outtmpl": f"{tmpdir}/%(id)s.%(ext)s",
                "quiet": True,
                "no_warnings": True,
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])

            vtt_files = list(Path(tmpdir).glob("*.vtt"))
            if not vtt_files:
                return None

            return self._parse_vtt(vtt_files[0].read_text(encoding="utf-8", errors="replace"))

    def _parse_vtt(self, vtt_text: str) -> str:
        """
        Extract clean text from a WebVTT file.

        YouTube auto-generated VTT has inline timing tags (<00:00:01.320>)
        and repeated cues. We deduplicate by cue text to get a clean transcript.
        """
        blocks = re.split(r"\n{2,}", vtt_text.strip())
        seen: set[str] = set()
        texts: list[str] = []

        for block in blocks:
            lines = block.strip().splitlines()
            if not lines:
                continue
            if lines[0].startswith("WEBVTT") or lines[0].startswith("NOTE"):
                continue

            text_parts: list[str] = []
            for line in lines:
                if "-->" in line or re.match(r"^\d+$", line.strip()):
                    continue
                # Strip inline timing tags and HTML
                line = re.sub(r"<\d{2}:\d{2}:\d{2}\.\d{3}>", "", line)
                line = re.sub(r"<[^>]+>", "", line)
                line = line.strip()
                if line:
                    text_parts.append(line)

            text = " ".join(text_parts)
            if text and text not in seen:
                seen.add(text)
                texts.append(text)

        return " ".join(texts)

    def _download_audio(self, url: str) -> tuple[Path, Path]:
        """Download best audio track. Returns (audio_path, tmpdir) — caller cleans up tmpdir."""
        import yt_dlp

        tmpdir = Path(tempfile.mkdtemp())
        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": str(tmpdir / "%(id)s.%(ext)s"),
            "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": "mp3"}
            ],
            "quiet": True,
            "no_warnings": True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            video_id = info["id"]

        return tmpdir / f"{video_id}.mp3", tmpdir

    def _transcribe(self, audio_path: Path) -> str:
        return self.engine.transcribe(str(audio_path))
