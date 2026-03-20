#!/usr/bin/env python3
"""
Chatterbox TTS Service for Jarvis Voice
FastAPI wrapper around Chatterbox TTS.

Supports multiple voice references configured via env vars:
  CHATTERBOX_VOICE_JARVIS  — Paul Bettany-style JARVIS voice (default)
  CHATTERBOX_VOICE_LANCE   — Lance James voice clone
  CHATTERBOX_DEFAULT_VOICE — which voice to use when none specified (default: jarvis)

Request body (POST /tts):
  text          str   — required
  voice         str   — "jarvis" | "lance" (optional, falls back to default)
  exaggeration  float — emotion intensity 0–1 (default per voice)
  cfg_weight    float — classifier-free guidance 0–1 (default 0.5)
  temperature   float — sampling temperature (default 0.7)

Returns: audio/wav at 24kHz
Port: 3340
"""

import os
import io
import time
import asyncio
import logging
from pathlib import Path

import torch
import torchaudio
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
VOICE_REFS = {
    "jarvis": Path(os.getenv(
        "CHATTERBOX_VOICE_JARVIS",
        "/home/generic/dev/voice-clones/jarvis/jarvis_reference_15s.wav",
    )),
    "lance": Path(os.getenv(
        "CHATTERBOX_VOICE_LANCE",
        "/home/generic/dev/voice-clones/lance_reference_15s.wav",
    )),
}

DEFAULT_VOICE = os.getenv("CHATTERBOX_DEFAULT_VOICE", "jarvis").lower()
PORT = int(os.getenv("CHATTERBOX_PORT", "3340"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# Per-voice tuning defaults — can be overridden per-request
VOICE_DEFAULTS = {
    "jarvis": {
        "exaggeration": float(os.getenv("CHATTERBOX_JARVIS_EXAGGERATION", "0.35")),
        "cfg_weight":   float(os.getenv("CHATTERBOX_JARVIS_CFG_WEIGHT",   "0.6")),
        "temperature":  float(os.getenv("CHATTERBOX_JARVIS_TEMPERATURE",  "0.7")),
    },
    "lance": {
        "exaggeration": float(os.getenv("CHATTERBOX_LANCE_EXAGGERATION",  "0.4")),
        "cfg_weight":   float(os.getenv("CHATTERBOX_LANCE_CFG_WEIGHT",    "0.5")),
        "temperature":  float(os.getenv("CHATTERBOX_LANCE_TEMPERATURE",   "0.7")),
    },
}

# ── Model singleton ───────────────────────────────────────────────────────────
_model = None
_model_lock = asyncio.Lock()


async def get_model():
    global _model
    async with _model_lock:
        if _model is None:
            logger.info(f"Loading Chatterbox TTS on {DEVICE}...")
            from chatterbox.tts import ChatterboxTTS
            loop = asyncio.get_event_loop()
            _model = await loop.run_in_executor(
                None, ChatterboxTTS.from_pretrained, DEVICE
            )
            logger.info("Chatterbox model loaded ✓")
    return _model


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Chatterbox TTS Service",
    description="Multi-voice TTS — JARVIS + Lance clone (Chatterbox by Resemble AI)",
    version="2.0.0",
)


@app.on_event("startup")
async def startup():
    missing = [name for name, path in VOICE_REFS.items() if not path.exists()]
    if missing:
        logger.warning(f"Missing voice references: {missing}")
    for name, path in VOICE_REFS.items():
        status = "✓" if path.exists() else "✗ MISSING"
        logger.info(f"  Voice [{name}] {status}: {path}")
    logger.info(f"Default voice: {DEFAULT_VOICE}")
    await get_model()


@app.post("/tts")
async def text_to_speech(request: Request):
    """
    Generate speech using a cloned voice.

    JSON body:
      text          str   — text to speak (required)
      voice         str   — "jarvis" | "lance" (default: CHATTERBOX_DEFAULT_VOICE)
      exaggeration  float — emotion intensity (default per voice)
      cfg_weight    float — CFG guidance (default per voice)
      temperature   float — sampling temp (default per voice)
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

    # Resolve voice
    voice = str(data.get("voice", DEFAULT_VOICE)).lower()
    if voice not in VOICE_REFS:
        logger.warning(f"Unknown voice '{voice}', falling back to {DEFAULT_VOICE}")
        voice = DEFAULT_VOICE

    ref_path = VOICE_REFS[voice]
    if not ref_path.exists():
        raise HTTPException(
            status_code=503,
            detail=f"Voice reference missing for '{voice}': {ref_path}"
        )

    # Resolve generation params (per-request > voice defaults)
    defaults = VOICE_DEFAULTS.get(voice, VOICE_DEFAULTS["jarvis"])
    exaggeration = float(data.get("exaggeration", defaults["exaggeration"]))
    cfg_weight   = float(data.get("cfg_weight",   defaults["cfg_weight"]))
    temperature  = float(data.get("temperature",  defaults["temperature"]))

    logger.info(
        f"[{voice}] {len(text)} chars, exag={exaggeration}, cfg={cfg_weight}, temp={temperature}: "
        f"{text[:60]}{'...' if len(text) > 60 else ''}"
    )

    try:
        t0 = time.time()
        model = await get_model()

        loop = asyncio.get_event_loop()
        wav_tensor = await loop.run_in_executor(
            None,
            lambda: model.generate(
                text,
                audio_prompt_path=str(ref_path),
                exaggeration=exaggeration,
                cfg_weight=cfg_weight,
                temperature=temperature,
            ),
        )

        buf = io.BytesIO()
        torchaudio.save(buf, wav_tensor.cpu(), model.sr, format="wav")
        audio_bytes = buf.getvalue()

        elapsed = int((time.time() - t0) * 1000)
        logger.info(f"[{voice}] done in {elapsed}ms → {len(audio_bytes):,} bytes")

        return Response(
            content=audio_bytes,
            media_type="audio/wav",
            headers={
                "Content-Disposition": f"attachment; filename={voice}_speech.wav",
                "X-Chatterbox-Voice": voice,
                "X-Chatterbox-Latency-Ms": str(elapsed),
            },
        )

    except Exception as e:
        logger.exception(f"[{voice}] generation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/v1/audio/speech")
async def openai_compat(request: Request):
    """
    OpenAI-compatible endpoint.
    POST { "input": "...", "model": "tts-1|tts-1-hd", "voice": "jarvis|lance|..." }
    Passes voice through to /tts handler.
    """
    data = await request.json()
    text = data.get("input", "")
    voice = data.get("voice", DEFAULT_VOICE)
    if not text:
        raise HTTPException(status_code=400, detail="input required")

    # Reuse main handler via internal call
    class _FakeRequest:
        headers = {"content-type": "application/json"}
        async def json(self): return {"text": text, "voice": voice}
        async def form(self): return {}

    return await text_to_speech(_FakeRequest())


@app.get("/voices")
async def list_voices():
    """List available voices and their reference file status."""
    return {
        "default": DEFAULT_VOICE,
        "voices": {
            name: {
                "reference": str(path),
                "available": path.exists(),
                "defaults": VOICE_DEFAULTS.get(name, {}),
            }
            for name, path in VOICE_REFS.items()
        },
    }


@app.get("/health")
async def health():
    voices_ok = {name: path.exists() for name, path in VOICE_REFS.items()}
    all_ok = _model is not None and all(voices_ok.values())
    return {
        "status": "healthy" if all_ok else "degraded",
        "device": DEVICE,
        "model_loaded": _model is not None,
        "default_voice": DEFAULT_VOICE,
        "voices": voices_ok,
        "service": "chatterbox-tts",
        "version": "2.0.0",
    }


@app.get("/")
async def root():
    return {
        "service": "Chatterbox TTS Service",
        "version": "2.0.0",
        "default_voice": DEFAULT_VOICE,
        "voices": list(VOICE_REFS.keys()),
        "endpoints": {
            "/tts": "POST — {text, voice?, exaggeration?, cfg_weight?, temperature?} → wav",
            "/voices": "GET — list voices + availability",
            "/health": "GET — health check",
        },
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
