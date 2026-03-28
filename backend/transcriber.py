import os


def load_engine():
    """Instantiate and return the configured transcription engine."""
    name = os.getenv("TRANSCRIPTION_ENGINE", "faster-whisper").lower()

    if name == "whisper":
        from engines.whisper_engine import WhisperEngine
        return WhisperEngine()
    elif name == "faster-whisper":
        from engines.faster_whisper_engine import FasterWhisperEngine
        return FasterWhisperEngine()
    elif name == "canary":
        from engines.canary_engine import CanaryEngine
        return CanaryEngine()
    elif name == "qwen-audio":
        from engines.qwen_audio_engine import QwenAudioEngine
        return QwenAudioEngine()
    else:
        raise ValueError(
            f"Unknown TRANSCRIPTION_ENGINE '{name}'. "
            "Valid options: whisper, faster-whisper, canary, qwen-audio"
        )
