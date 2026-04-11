"""
Audio enhancement pipeline.

Stages (in order):
  normalize  — ffmpeg loudnorm, always fast
  denoise    — ClearVoice speech enhancement (MossFormer2_SE_48K)
  isolate    — Demucs vocal isolation (separates vocals from instruments)
  separate   — ClearVoice speech separation (MossFormer2_SS_16K)
  upsample   — ClearVoice super-resolution to 48kHz (MossFormer2_SR_48K)

Each stage is independent and optional.

Two interfaces are provided:
  run()       — async, for use from the SSE extractor pipeline
  run_sync()  — synchronous, for use from background transcription threads
"""

import asyncio
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


@dataclass
class EnhancementOptions:
    normalize: bool = False
    denoise:   bool = False   # ClearVoice speech enhancement
    isolate:   bool = False   # Demucs vocal isolation
    separate:  bool = False   # ClearVoice speaker separation
    upsample:  bool = False   # ClearVoice super-resolution

    @property
    def any_active(self) -> bool:
        return self.normalize or self.denoise or self.isolate or self.separate or self.upsample

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
            separate =_b(d.get("enhance_separate",  False)),
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
                await on_status("extracting", "Enhancing speech (ClearVoice)…")
                out = mk_tmp()
                await asyncio.to_thread(self._denoise, current, out)
                current = out

            if options.isolate:
                await on_status("extracting", "Isolating vocals (Demucs)…")
                out = mk_tmp()
                await asyncio.to_thread(self._isolate, current, out)
                current = out

            if options.separate:
                await on_status("extracting", "Separating speakers (ClearVoice)…")
                out = mk_tmp()
                await asyncio.to_thread(self._separate, current, out)
                current = out

            if options.upsample:
                await on_status("extracting", "Upsampling to 48kHz (ClearVoice)…")
                out = mk_tmp()
                await asyncio.to_thread(self._upsample, current, out)
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
                status("enhancing", "Enhancing speech (ClearVoice)…")
                out = mk_tmp()
                self._denoise(current, out)
                current = out

            if options.isolate:
                status("enhancing", "Isolating vocals (Demucs)…")
                out = mk_tmp()
                self._isolate(current, out)
                current = out

            if options.separate:
                status("enhancing", "Separating speakers (ClearVoice)…")
                out = mk_tmp()
                self._separate(current, out)
                current = out

            if options.upsample:
                status("enhancing", "Upsampling to 48kHz (ClearVoice)…")
                out = mk_tmp()
                self._upsample(current, out)
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
        """Speech enhancement via ClearVoice (MossFormer2_SE_48K)."""
        try:
            from clearvoice import ClearVoice
        except ImportError:
            raise RuntimeError("clearvoice package not installed. Install with: uv add clearvoice")

        cv = ClearVoice(task='speech_enhancement', model_names=['MossFormer2_SE_48K'])
        output_wav = cv(input_path=str(inp), online_write=False)
        cv.write(output_wav, output_path=str(out))

    def _isolate(self, inp: Path, out: Path) -> None:
        """Vocal isolation via Demucs (htdemucs model)."""
        import soundfile as sf
        import torch
        import torchaudio
        from demucs.pretrained import get_model
        from demucs.apply import apply_model

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = get_model("htdemucs")
        model.to(device)
        model.eval()

        data, sr = sf.read(str(inp), always_2d=True)  # (samples, channels)
        wav = torch.from_numpy(data.T).float()         # (channels, samples)

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
        vocals = sources[vocals_idx].cpu().mean(0)  # mono (samples,)
        sf.write(str(out), vocals.numpy(), model.samplerate)

    def _separate(self, inp: Path, out: Path) -> None:
        """Separate overlapping speakers via ClearVoice (MossFormer2_SS_16K).
        Outputs the first (dominant) separated speaker."""
        try:
            from clearvoice import ClearVoice
        except ImportError:
            raise RuntimeError("clearvoice package not installed. Install with: uv add clearvoice")

        cv = ClearVoice(task='speech_separation', model_names=['MossFormer2_SS_16K'])

        with tempfile.TemporaryDirectory() as tmpdir:
            cv(input_path=str(inp), online_write=True, output_path=tmpdir)
            # ClearVoice writes {stem}_MossFormer2_SS_16K_spk1.wav, spk2.wav, ...
            spk1 = Path(tmpdir) / f"{inp.stem}_MossFormer2_SS_16K_spk1.wav"
            if spk1.exists():
                shutil.copy(spk1, out)
            else:
                # Fallback: find any spk1 file in case stem differs
                candidates = list(Path(tmpdir).glob("*_spk1.wav"))
                if candidates:
                    shutil.copy(candidates[0], out)
                else:
                    shutil.copy(inp, out)

    def _upsample(self, inp: Path, out: Path) -> None:
        """Audio super-resolution to 48kHz via ClearVoice (MossFormer2_SR_48K)."""
        try:
            from clearvoice import ClearVoice
        except ImportError:
            raise RuntimeError("clearvoice package not installed. Install with: uv add clearvoice")

        cv = ClearVoice(task='speech_super_resolution', model_names=['MossFormer2_SR_48K'])
        output_wav = cv(input_path=str(inp), online_write=False)
        cv.write(output_wav, output_path=str(out))

    def run_single_step(self, input_path: Path, step: str, output_path: Path) -> None:
        """Run a single named enhancement step."""
        match step:
            case "normalize": self._normalize(input_path, output_path)
            case "denoise":   self._denoise(input_path, output_path)
            case "isolate":   self._isolate(input_path, output_path)
            case "separate":  self._separate(input_path, output_path)
            case "upsample":  self._upsample(input_path, output_path)
            case _:           raise ValueError(f"Unknown step: {step!r}")
