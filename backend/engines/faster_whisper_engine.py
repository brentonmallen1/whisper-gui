import os


class FasterWhisperEngine:
    """Faster-Whisper via CTranslate2 — supports CPU and CUDA GPU."""

    def __init__(self):
        import torch
        from faster_whisper import WhisperModel

        model_size = os.getenv("WHISPER_MODEL_SIZE", "large-v3")
        compute_type = os.getenv("COMPUTE_TYPE", "int8")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        self.language = os.getenv("LANGUAGE", "en") or None

        print(f"[faster-whisper] Loading model '{model_size}' on {device} ({compute_type}) ...")
        self.model_name = f"faster-whisper/{model_size}"
        # HF_HOME env var controls where the CTranslate2 model is cached.
        self._model = WhisperModel(model_size, device=device, compute_type=compute_type)
        print("[faster-whisper] Ready.")

    def transcribe(self, audio_path: str) -> str:
        opts: dict = {"beam_size": 5}
        if self.language:
            opts["language"] = self.language
        segments, _ = self._model.transcribe(audio_path, **opts)
        return " ".join(seg.text.strip() for seg in segments).strip()
