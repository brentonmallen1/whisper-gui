import os

# Models that use the newer SALM class (FastConformer + LLM backbone).
# All other canary models use the classic EncDecMultiTaskModel.
_SALM_MODELS = {"nvidia/canary-qwen-2.5b"}


class CanaryEngine:
    """NVIDIA NeMo Canary — requires a CUDA GPU.

    Supports two model families:
      - nvidia/canary-1b          : EncDecMultiTaskModel (classic Canary)
      - nvidia/canary-qwen-2.5b   : SALM (FastConformer + Qwen3 LLM backbone,
                                    ~6 GB, SoTA on OpenASR leaderboard)
    """

    def __init__(self):
        import torch

        if not torch.cuda.is_available():
            raise RuntimeError(
                "Canary engine requires an NVIDIA GPU. "
                "Set ENABLE_GPU=true and TRANSCRIPTION_ENGINE=canary."
            )

        try:
            import nemo  # noqa: F401
        except ImportError:
            raise ImportError(
                "NeMo is not installed. Run `uv sync` to install dependencies."
            )

        model_name = os.getenv("CANARY_MODEL", "nvidia/canary-qwen-2.5b")
        self.model_name = model_name
        self._is_salm = model_name in _SALM_MODELS

        print(f"[canary] Loading model '{model_name}' ...")

        if self._is_salm:
            self._load_salm(model_name)
        else:
            self._load_classic(model_name)

        print("[canary] Ready.")

    def _load_salm(self, model_name: str) -> None:
        import torch
        from nemo.collections.speechlm2.models import SALM

        self._model = (
            SALM.from_pretrained(model_name).bfloat16().eval().to(torch.device("cuda"))
        )

    def _load_classic(self, model_name: str) -> None:
        import nemo.collections.asr as nemo_asr

        self.language = os.getenv("LANGUAGE", "en") or "en"
        self._model = nemo_asr.models.EncDecMultiTaskModel.from_pretrained(model_name)
        self._model.eval()

    def transcribe(self, audio_path: str) -> str:
        if self._is_salm:
            return self._transcribe_salm(audio_path)
        return self._transcribe_classic(audio_path)

    def _transcribe_salm(self, audio_path: str) -> str:
        prompt = f"Transcribe the following: {self._model.audio_locator_tag}"
        answer_ids = self._model.generate(
            prompts=[[{"role": "user", "content": prompt, "audio": [audio_path]}]],
            max_new_tokens=512,
        )
        return self._model.tokenizer.ids_to_text(answer_ids[0].cpu()).strip()

    def _transcribe_classic(self, audio_path: str) -> str:
        decode_cfg = self._model.cfg.decoding
        decode_cfg.beam.beam_size = 1
        self._model.change_decoding_strategy(decode_cfg)

        output = self._model.transcribe(
            [audio_path],
            batch_size=1,
            source_lang=self.language,
            target_lang=self.language,
            task="asr",
            pnc="yes",
        )
        result = output[0]
        if isinstance(result, list):
            result = result[0]
        return str(result).strip()
