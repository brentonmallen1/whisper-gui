import os


class WhisperEngine:
    """OpenAI Whisper — supports CPU and CUDA GPU."""

    def __init__(self):
        import torch
        import whisper

        model_size = os.getenv("WHISPER_MODEL_SIZE", "large-v3")
        download_root = os.getenv("WHISPER_DOWNLOAD_ROOT", "/models/whisper")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        self.language = os.getenv("LANGUAGE", "en") or None

        print(f"[whisper] Loading model '{model_size}' on {device} ...")
        self.model_name = f"whisper/{model_size}"
        self._model = whisper.load_model(model_size, device=device, download_root=download_root)
        print("[whisper] Ready.")

    def transcribe(self, audio_path: str) -> str:
        opts: dict = {}
        if self.language:
            opts["language"] = self.language
        result = self._model.transcribe(audio_path, **opts)
        return result["text"].strip()
