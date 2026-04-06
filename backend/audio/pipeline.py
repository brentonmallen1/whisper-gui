"""
Audio enhancement pipeline.

Stages (in order):
  normalize  — ffmpeg loudnorm, always fast
  denoise    — DeepFilterNet noise reduction
  isolate    — Demucs vocal isolation
  upsample   — LavaSR super-resolution (outputs 48kHz)

Each stage is independent and optional. When DeepFilterNet runs before
LavaSR, the upsample stage sets denoise=False to avoid double denoising.

Two interfaces are provided:
  run()       — async, for use from the SSE extractor pipeline
  run_sync()  — synchronous, for use from background transcription threads
"""

import asyncio
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


@dataclass
class EnhancementOptions:
    normalize: bool = False
    denoise:   bool = False   # DeepFilterNet
    isolate:   bool = False   # Demucs
    upsample:  bool = False   # LavaSR

    @property
    def any_active(self) -> bool:
        return self.normalize or self.denoise or self.isolate or self.upsample

    @classmethod
    def from_dict(cls, d: dict) -> "EnhancementOptions":
        """Build from a dict of string booleans (e.g. from form fields or settings)."""
        def _b(v) -> bool:
            if isinstance(v, bool): return v
            return str(v).lower() in ("1", "true", "yes", "on")
        return cls(
            normalize=_b(d.get("enhance_normalize", False)),
            denoise  =_b(d.get("enhance_denoise",   False)),
            isolate  =_b(d.get("enhance_isolate",   False)),
            upsample =_b(d.get("enhance_upsample",  False)),
        )


# Sync status callback: (phase, detail) → None
SyncStatusCallback = Callable[[str, str], None]


class AudioPipeline:
    """Chains audio enhancement stages, managing temp files between them."""

    def __init__(self) -> None:
        pass  # all settings come from environment (HF_HOME, TORCH_HOME, etc.)

    # ── Async interface (for SSE extractors) ─────────────────────────────────

    async def run(self, input_path: Path, options: EnhancementOptions, on_status) -> Path:
        """
        Run the pipeline asynchronously.
        Returns a new temp file (caller must delete it).
        Returns input_path unchanged when no options are active.
        """
        if not options.any_active:
            return input_path

        def _sync_status(phase: str, detail: str) -> None:
            # Wrap async on_status as fire-and-forget for the sync runner
            pass  # status updates come from the async layer below

        # We'll run each stage in a thread and call on_status between them
        tmp_files: list[Path] = []
        current = input_path

        def mk_tmp(suffix: str = ".wav") -> Path:
            p = Path(tempfile.mktemp(suffix=suffix))
            tmp_files.append(p)
            return p

        try:
            if options.normalize:
                await on_status("extracting", "Normalizing audio…")
                out = mk_tmp()
                await asyncio.to_thread(self._normalize, current, out)
                current = out

            if options.denoise:
                await on_status("extracting", "Reducing noise (DeepFilterNet)…")
                out = mk_tmp()
                await asyncio.to_thread(self._denoise, current, out)
                current = out

            if options.isolate:
                await on_status("extracting", "Isolating vocals (Demucs)…")
                out = mk_tmp()
                await asyncio.to_thread(self._isolate, current, out)
                current = out

            if options.upsample:
                await on_status("extracting", "Upsampling audio (LavaSR)…")
                out = mk_tmp()
                await asyncio.to_thread(self._upsample, current, out, options.denoise)
                current = out

            # Clean up intermediates; keep the final output for the caller
            for p in tmp_files:
                if p != current:
                    p.unlink(missing_ok=True)

            return current

        except Exception:
            for p in tmp_files:
                p.unlink(missing_ok=True)
            raise

    # ── Sync interface (for background transcription threads) ─────────────────

    def run_sync(
        self,
        input_path: Path,
        options: EnhancementOptions,
        on_status: SyncStatusCallback | None = None,
    ) -> Path:
        """
        Run the pipeline synchronously (for use inside threads).
        Returns a new temp file (caller must delete it).
        Returns input_path unchanged when no options are active.
        """
        if not options.any_active:
            return input_path

        def status(phase: str, detail: str) -> None:
            if on_status:
                on_status(phase, detail)

        tmp_files: list[Path] = []
        current = input_path

        def mk_tmp(suffix: str = ".wav") -> Path:
            p = Path(tempfile.mktemp(suffix=suffix))
            tmp_files.append(p)
            return p

        try:
            if options.normalize:
                status("enhancing", "Normalizing audio…")
                out = mk_tmp()
                self._normalize(current, out)
                current = out

            if options.denoise:
                status("enhancing", "Reducing noise (DeepFilterNet)…")
                out = mk_tmp()
                self._denoise(current, out)
                current = out

            if options.isolate:
                status("enhancing", "Isolating vocals (Demucs)…")
                out = mk_tmp()
                self._isolate(current, out)
                current = out

            if options.upsample:
                status("enhancing", "Upsampling audio (LavaSR)…")
                out = mk_tmp()
                self._upsample(current, out, options.denoise)
                current = out

            for p in tmp_files:
                if p != current:
                    p.unlink(missing_ok=True)

            return current

        except Exception:
            for p in tmp_files:
                p.unlink(missing_ok=True)
            raise

    # ── Stage implementations ─────────────────────────────────────────────────

    def _normalize(self, inp: Path, out: Path) -> None:
        """EBU R128 loudness normalization via ffmpeg loudnorm."""
        subprocess.run(
            [
                "ffmpeg", "-i", str(inp),
                "-filter:a", "loudnorm=I=-16:TP=-1.5:LRA=11",
                "-y", str(out),
            ],
            check=True,
            capture_output=True,
        )

    def _denoise(self, inp: Path, out: Path) -> None:
        """Noise reduction via DeepFilterNet."""
        import torch
        from df.enhance import enhance, init_df, load_audio, save_audio

        model, df_state, _ = init_df()
        if torch.cuda.is_available():
            model = model.cuda()

        audio, _ = load_audio(str(inp), sr=df_state.sr())
        enhanced = enhance(model, df_state, audio)
        save_audio(str(out), enhanced, df_state.sr())

    def _isolate(self, inp: Path, out: Path) -> None:
        """Vocal isolation via Demucs (htdemucs model)."""
        import torch
        import torchaudio
        from demucs.pretrained import get_model
        from demucs.apply import apply_model

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = get_model("htdemucs")
        model.to(device)
        model.eval()

        wav, sr = torchaudio.load(str(inp))

        # Demucs requires stereo input
        if wav.shape[0] == 1:
            wav = wav.repeat(2, 1)
        elif wav.shape[0] > 2:
            wav = wav[:2]

        if sr != model.samplerate:
            wav = torchaudio.functional.resample(wav, sr, model.samplerate)

        wav = wav.unsqueeze(0).to(device)
        with torch.no_grad():
            sources = apply_model(model, wav)[0]

        vocals_idx = model.sources.index("vocals")
        vocals = sources[vocals_idx].cpu()
        # Back to mono
        torchaudio.save(str(out), vocals.mean(0, keepdim=True), model.samplerate)

    def _upsample(self, inp: Path, out: Path, denoise_already_done: bool) -> None:
        """
        Audio super-resolution via LavaSR (outputs 48kHz).
        LavaSR expects 16kHz mono input; we resample before passing in.
        Pass denoise_already_done=True when DeepFilterNet has already run
        to skip the built-in denoiser and avoid double denoising.
        """
        import torch
        import torchaudio

        try:
            from LavaSR.model import LavaEnhance
        except ImportError:
            raise RuntimeError(
                "LavaSR is not installed. "
                "Install with: uv add 'lavasr @ git+https://github.com/ysharma3501/LavaSR.git'"
            )

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = LavaEnhance(device=device)

        wav, sr = torchaudio.load(str(inp))
        # LavaEnhance expects 16kHz mono 1-D tensor
        if wav.shape[0] > 1:
            wav = wav.mean(0, keepdim=True)
        if sr != 16_000:
            wav = torchaudio.functional.resample(wav, sr, 16_000)
        wav = wav.squeeze(0).to(device)

        enhanced = model.enhance(wav, enhance=True, denoise=not denoise_already_done)
        # enhance() returns a 1-D tensor at 48kHz
        torchaudio.save(str(out), enhanced.unsqueeze(0).cpu(), 48_000)
