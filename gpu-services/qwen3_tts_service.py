#!/usr/bin/env python3
"""
Qwen3-TTS Service for Jarvis Voice
FastAPI wrapper around Qwen3-TTS Base model with voice cloning.

Uses a pre-extracted voice clone prompt from a reference audio so every
generation sounds identical. The prompt is built once at startup and reused.

Env vars:
  QWEN3_TTS_MODEL      — HF model (default: Qwen/Qwen3-TTS-12Hz-1.7B-Base)
  QWEN3_TTS_PORT       — Listen port (default: 3341)
  QWEN3_TTS_REF_AUDIO  — Path to reference audio for voice cloning
  QWEN3_TTS_REF_TEXT   — Transcript of reference audio (improves quality)
  QWEN3_TTS_LANG       — Default language (default: english)
  QWEN3_TTS_PROMPT_CACHE — Path to cache the voice prompt pickle

Request body (POST /tts):
  text      str — required
  language  str — language (optional, default: english)

Returns: audio/wav at 24kHz
Port: 3341
"""

import os
import io
import time
import asyncio
import logging
import pickle
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
import uvicorn

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
MODEL_NAME = os.getenv(
    "QWEN3_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
)
PORT = int(os.getenv("QWEN3_TTS_PORT", "3341"))
DEFAULT_LANG = os.getenv("QWEN3_TTS_LANG", "english")

# Reference audio for voice cloning
REF_AUDIO = os.getenv(
    "QWEN3_TTS_REF_AUDIO",
    "/home/generic/dev/qwen3_tts_jarvis.wav",
)
REF_TEXT = os.getenv(
    "QWEN3_TTS_REF_TEXT",
    "Good afternoon, sir. I've completed the analysis of the security logs. "
    "Three anomalous entries detected in the past hour, all originating from "
    "the same subnet. Shall I dig deeper?",
)
PROMPT_CACHE = os.getenv(
    "QWEN3_TTS_PROMPT_CACHE",
    "/home/generic/dev/voice-clones/qwen3_jarvis_prompt_06b.pkl",
)

# ── Model + voice prompt singletons ──────────────────────────────────────────
_model = None
_voice_prompt = None
_model_lock = asyncio.Lock()


async def get_model_and_prompt():
    global _model, _voice_prompt
    async with _model_lock:
        if _model is None:
            from qwen_tts import Qwen3TTSModel

            import torch

            logger.info(f"Loading Qwen3-TTS model: {MODEL_NAME}")
            loop = asyncio.get_event_loop()

            # Try flash_attention_2, fall back to sdpa, then eager
            attn_impl = "flash_attention_2"
            try:
                import flash_attn  # noqa: F401
                logger.info("flash-attn available → using flash_attention_2")
            except ImportError:
                attn_impl = "sdpa"
                logger.info("flash-attn not installed → using SDPA (PyTorch native)")

            _model = await loop.run_in_executor(
                None,
                lambda: Qwen3TTSModel.from_pretrained(
                    MODEL_NAME,
                    device_map="cuda",
                    dtype=torch.bfloat16,
                    attn_implementation=attn_impl,
                ),
            )
            logger.info(f"Qwen3-TTS model loaded ✓ (dtype=bf16, attn={attn_impl})")

            # Load or build voice clone prompt
            cache_path = Path(PROMPT_CACHE)
            if cache_path.exists():
                logger.info(f"Loading cached voice prompt from {cache_path}")
                with open(cache_path, "rb") as f:
                    _voice_prompt = pickle.load(f)
                logger.info("Voice prompt loaded from cache ✓")
            else:
                logger.info(f"Building voice prompt from {REF_AUDIO}")
                _voice_prompt = await loop.run_in_executor(
                    None,
                    lambda: _model.create_voice_clone_prompt(
                        ref_audio=REF_AUDIO,
                        ref_text=REF_TEXT,
                    ),
                )
                # Cache for next startup
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                with open(cache_path, "wb") as f:
                    pickle.dump(_voice_prompt, f)
                logger.info(f"Voice prompt built and cached to {cache_path} ✓")

    return _model, _voice_prompt


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Qwen3-TTS Voice Clone Service",
    description="TTS via Qwen3-TTS Base with locked-in cloned voice",
    version="2.0.0",
)


@app.on_event("startup")
async def startup():
    logger.info(f"Model: {MODEL_NAME}")
    logger.info(f"Reference audio: {REF_AUDIO}")
    logger.info(f"Prompt cache: {PROMPT_CACHE}")
    logger.info(f"Default language: {DEFAULT_LANG}")
    await get_model_and_prompt()


def _generate(model, voice_prompt, text, language):
    """Run voice clone inference (blocking — called via executor)."""
    audios, sr = model.generate_voice_clone(
        text=text,
        voice_clone_prompt=voice_prompt,
        language=language,
        non_streaming_mode=True,
    )
    return audios[0], sr


@app.post("/tts")
async def text_to_speech(request: Request):
    """
    Generate speech with the locked-in cloned voice.

    JSON body:
      text      str — text to speak (required)
      language  str — language (optional, default: english)
    """
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        data = await request.json()
    else:
        form = await request.form()
        data = dict(form)

    text = str(data.get("text", "")).strip()
    if not text:
        raise HTTPException(status_code=400, detail="No text provided")

    language = str(data.get("language", DEFAULT_LANG)).strip()

    logger.info(
        f"[qwen3] {len(text)} chars, lang={language}: "
        f"{text[:60]}{'...' if len(text) > 60 else ''}"
    )

    try:
        t0 = time.time()
        model, voice_prompt = await get_model_and_prompt()

        loop = asyncio.get_event_loop()
        audio, sr = await loop.run_in_executor(
            None, lambda: _generate(model, voice_prompt, text, language)
        )

        # Append 250ms trailing silence (prevents Discord clipping)
        silence = np.zeros(int(sr * 0.25), dtype=audio.dtype)
        padded = np.concatenate([audio, silence])

        buf = io.BytesIO()
        sf.write(buf, padded, sr, format="wav")
        audio_bytes = buf.getvalue()

        elapsed = int((time.time() - t0) * 1000)
        duration = len(audio) / sr
        logger.info(
            f"[qwen3] done in {elapsed}ms → {duration:.1f}s audio, "
            f"{len(audio_bytes):,} bytes"
        )

        return Response(
            content=audio_bytes,
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=qwen3_speech.wav",
                "X-Qwen3-Latency-Ms": str(elapsed),
                "X-Qwen3-Duration-S": f"{duration:.1f}",
            },
        )

    except Exception as e:
        logger.exception(f"[qwen3] generation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/v1/audio/speech")
async def openai_compat(request: Request):
    """OpenAI-compatible endpoint."""
    data = await request.json()
    text = data.get("input", "")
    if not text:
        raise HTTPException(status_code=400, detail="input required")

    class _FakeRequest:
        headers = {"content-type": "application/json"}
        async def json(self):
            return {"text": text}
        async def form(self):
            return {}

    return await text_to_speech(_FakeRequest())


@app.get("/health")
async def health():
    return {
        "status": "healthy" if _model is not None and _voice_prompt is not None else "loading",
        "model": MODEL_NAME,
        "model_loaded": _model is not None,
        "voice_prompt_loaded": _voice_prompt is not None,
        "reference_audio": REF_AUDIO,
        "default_language": DEFAULT_LANG,
        "service": "qwen3-tts",
        "version": "2.0.0",
    }


@app.get("/")
async def root():
    return {
        "service": "Qwen3-TTS Voice Clone Service",
        "version": "2.0.0",
        "model": MODEL_NAME,
        "voice": "cloned from reference (locked)",
        "endpoints": {
            "/tts": "POST — {text, language?} → wav",
            "/v1/audio/speech": "POST — OpenAI-compatible {input} → wav",
            "/health": "GET — health check",
        },
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
