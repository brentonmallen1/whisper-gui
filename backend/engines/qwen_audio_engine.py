import os


class QwenAudioEngine:
    """Qwen2-Audio — requires CUDA GPU."""

    def __init__(self):
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError(
                "Qwen Audio engine requires an NVIDIA GPU. "
                "Set ENABLE_GPU=true and TRANSCRIPTION_ENGINE=qwen-audio."
            )

        from transformers import AutoProcessor, Qwen2AudioForConditionalGeneration

        model_name = os.getenv("QWEN_MODEL", "Qwen/Qwen2-Audio-7B-Instruct")

        # HF_HOME controls the cache directory for all HuggingFace models.
        print(f"[qwen-audio] Loading model '{model_name}' ...")
        self.model_name = model_name
        self._processor = AutoProcessor.from_pretrained(model_name)
        self._model = Qwen2AudioForConditionalGeneration.from_pretrained(
            model_name,
            torch_dtype=torch.float16,
            device_map="auto",
        )
        print("[qwen-audio] Ready.")

    def transcribe(self, audio_path: str) -> str:
        import librosa
        import torch

        sr = self._processor.feature_extractor.sampling_rate
        audio, _ = librosa.load(audio_path, sr=sr, mono=True)

        conversation = [
            {
                "role": "user",
                "content": [
                    {"type": "audio", "audio_url": audio_path},
                    {"type": "text", "text": "Transcribe this audio exactly, word for word."},
                ],
            }
        ]

        text = self._processor.apply_chat_template(
            conversation, add_generation_prompt=True, tokenize=False
        )
        inputs = self._processor(
            text=text,
            audios=[audio],
            return_tensors="pt",
            padding=True,
            sampling_rate=sr,
        )
        inputs = {
            k: v.to("cuda") if isinstance(v, torch.Tensor) else v
            for k, v in inputs.items()
        }

        with torch.no_grad():
            output_ids = self._model.generate(**inputs, max_new_tokens=1024)

        # Strip the prompt tokens from the output.
        generated = output_ids[:, inputs["input_ids"].size(1):]
        return self._processor.batch_decode(
            generated, skip_special_tokens=True, clean_up_tokenization_spaces=False
        )[0].strip()
