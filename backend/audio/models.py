"""
Audio enhancement model management.

Provides:
  get_model_status()  — check package installation and weight availability
  download_model()    — trigger weight download (blocks until complete)
"""

import importlib.util
import os
from pathlib import Path


# ── HF cache helpers ──────────────────────────────────────────────────────────

def _hf_model_cached(repo_id: str) -> bool:
    """
    Fast check: does the HF Hub cache directory for this repo exist?
    Avoids loading models into memory or making network requests.
    """
    hf_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    # HF stores repos in hub/ as "models--{org}--{name}"
    repo_dir = hf_home / "hub" / ("models--" + repo_id.replace("/", "--"))
    return repo_dir.exists() and any(True for _ in repo_dir.glob("snapshots/*"))


def _pkg(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


# ── Public API ────────────────────────────────────────────────────────────────

def get_model_status() -> dict[str, dict[str, bool]]:
    """
    Return package and weight availability for each enhancement model.

    Shape: { "clearvoice": {"package": bool, "weights": bool}, ... }
    """
    demucs_pkg     = _pkg("demucs")
    clearvoice_pkg = _pkg("clearvoice")

    return {
        "demucs": {
            "package": demucs_pkg,
            # Demucs 4.x uses HF Hub; htdemucs lives under facebook/demucs
            "weights": _hf_model_cached("facebook/demucs") if demucs_pkg else False,
        },
        "clearvoice": {
            "package": clearvoice_pkg,
            # ClearVoice downloads models from ModelScope/HF on first use;
            # treat as available if the package itself is installed.
            "weights": clearvoice_pkg,
        },
    }


def download_model(name: str) -> None:
    """
    Trigger weight download for the named model. Blocks until complete.
    Relies on model packages downloading to HF_HOME on first use.
    """
    if name == "demucs":
        if not _pkg("demucs"):
            raise RuntimeError("demucs package not installed.")
        from demucs.pretrained import get_model
        get_model("htdemucs")  # downloads htdemucs weights if not cached

    elif name == "clearvoice":
        if not _pkg("clearvoice"):
            raise RuntimeError("clearvoice package not installed.")
        from clearvoice import ClearVoice
        # Instantiating each model triggers weight download
        ClearVoice(task='speech_enhancement',     model_names=['MossFormer2_SE_48K'])
        ClearVoice(task='speech_separation',      model_names=['MossFormer2_SS_16K'])
        ClearVoice(task='speech_super_resolution', model_names=['MossFormer2_SR_48K'])

    else:
        raise ValueError(f"Unknown model: {name!r}")
