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

    Shape: { "deepfilternet": {"package": bool, "weights": bool}, ... }
    """
    df_pkg      = _pkg("df")
    demucs_pkg  = _pkg("demucs")
    # LavaSR package is the 'LavaSR' namespace (capital)
    lavasr_pkg  = _pkg("LavaSR")

    return {
        "deepfilternet": {
            "package": df_pkg,
            "weights": _hf_model_cached("DeepFilterNet/DeepFilterNet3") if df_pkg else False,
        },
        "demucs": {
            "package": demucs_pkg,
            # Demucs 4.x uses HF Hub; htdemucs lives under facebook/demucs
            "weights": _hf_model_cached("facebook/demucs") if demucs_pkg else False,
        },
        "lavasr": {
            "package": lavasr_pkg,
            # LavaSR downloads from YatharthS/LavaSR on HF Hub
            "weights": _hf_model_cached("YatharthS/LavaSR") if lavasr_pkg else False,
        },
    }


def download_model(name: str) -> None:
    """
    Trigger weight download for the named model. Blocks until complete.
    Relies on model packages downloading to HF_HOME on first use.
    """
    if name == "deepfilternet":
        if not _pkg("df"):
            raise RuntimeError("deepfilternet package not installed.")
        from df.enhance import init_df
        init_df()  # downloads DeepFilterNet3 weights on first call

    elif name == "demucs":
        if not _pkg("demucs"):
            raise RuntimeError("demucs package not installed.")
        from demucs.pretrained import get_model
        get_model("htdemucs")  # downloads htdemucs weights if not cached

    elif name == "lavasr":
        if not _pkg("LavaSR"):
            raise RuntimeError(
                "LavaSR package not installed. "
                "Install with: uv add 'lavasr @ git+https://github.com/ysharma3501/LavaSR.git'"
            )
        from LavaSR.model import LavaEnhance
        LavaEnhance()  # triggers snapshot_download("YatharthS/LavaSR")

    else:
        raise ValueError(f"Unknown model: {name!r}")
