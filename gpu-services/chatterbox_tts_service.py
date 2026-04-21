#!/usr/bin/env python3
"""
Chatterbox TTS Service for Jarvis Voice
FastAPI wrapper around Chatterbox TTS.

Supports multiple voice references configured via env vars:
  CHATTERBOX_VOICE_JARVIS  — Paul Bettany-style JARVIS voice (default)
  CHATTERBOX_VOICE_OWNER   — Owner voice clone
  CHATTERBOX_DEFAULT_VOICE — which voice to use when none specified (default: jarvis)

Request body (POST /tts):
  text          str   — required
  voice         str   — "jarvis" | "owner" (optional, falls back to default)
  exaggeration  float — emotion intensity 0–1 (default per voice)
  cfg_weight    float — classifier-free guidance 0–1 (default 0.5)
  temperature   float — sampling temperature (default 0.7)

Returns: audio/wav at 24kHz
Port: 3340
"""

import os
import io
import re
import time
import base64
import json
import asyncio
import logging
from pathlib import Path

import torch
import torchaudio
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
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
    "owner": Path(os.getenv(
        "CHATTERBOX_VOICE_OWNER",
        str(Path.home() / "voice-clones/owner_reference.wav"),
    )),
    "snoop": Path(os.getenv(
        "CHATTERBOX_VOICE_SNOOP",
        "/home/generic/dev/voice-clones/snoop/snoop_reference_15s.wav",
    )),
    "c3po": Path(os.getenv(
        "CHATTERBOX_VOICE_C3PO",
        "/home/generic/dev/voice-clones/c3po/c3po_reference_15s.wav",
    )),
}

DEFAULT_VOICE = os.getenv("CHATTERBOX_DEFAULT_VOICE", "jarvis").lower()
PORT = int(os.getenv("CHATTERBOX_PORT", "3340"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# Per-voice tuning defaults — can be overridden per-request
VOICE_DEFAULTS = {
    "jarvis": {
        "exaggeration": float(os.getenv("CHATTERBOX_JARVIS_EXAGGERATION", "0.35")),
        "cfg_weight":   float(os.getenv("CHATTERBOX_JARVIS_CFG_WEIGHT",   "1.5")),
        "temperature":  float(os.getenv("CHATTERBOX_JARVIS_TEMPERATURE",  "0.5")),
    },
    "owner": {
        "exaggeration": float(os.getenv("CHATTERBOX_OWNER_EXAGGERATION",  "0.4")),
        "cfg_weight":   float(os.getenv("CHATTERBOX_OWNER_CFG_WEIGHT",    "0.5")),
        "temperature":  float(os.getenv("CHATTERBOX_OWNER_TEMPERATURE",   "0.7")),
    },
    "snoop": {
        "exaggeration": float(os.getenv("CHATTERBOX_SNOOP_EXAGGERATION",  "0.5")),
        "cfg_weight":   float(os.getenv("CHATTERBOX_SNOOP_CFG_WEIGHT",    "0.6")),
        "temperature":  float(os.getenv("CHATTERBOX_SNOOP_TEMPERATURE",   "0.8")),
    },
    "c3po": {
        "exaggeration": float(os.getenv("CHATTERBOX_C3PO_EXAGGERATION",  "0.55")),
        "cfg_weight":   float(os.getenv("CHATTERBOX_C3PO_CFG_WEIGHT",    "1.2")),
        "temperature":  float(os.getenv("CHATTERBOX_C3PO_TEMPERATURE",   "0.6")),
    },
}

# ── Model singleton ───────────────────────────────────────────────────────────
_model = None
_model_lock = asyncio.Lock()

# ── Cached conditionals ───────────────────────────────────────────────────────
# Only ONE voice's conditionals are held in GPU memory at a time.
# Switching voices evicts the prior conds, clears GPU, then pre-warms the new voice.
# Keyed by (voice_name, exaggeration).
_cached_conds: dict = {}
_conds_lock = asyncio.Lock()

# ── Active voice tracking ─────────────────────────────────────────────────────
_active_voice: str = DEFAULT_VOICE
_active_voice_lock = asyncio.Lock()


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


async def get_cached_conds(model, voice: str, ref_path: Path, exaggeration: float):
    """Return cached conditionals for (voice, exaggeration), computing if needed."""
    cache_key = (voice, round(exaggeration, 3))
    async with _conds_lock:
        if cache_key not in _cached_conds:
            logger.info(f"[conds] Computing conditionals for {voice} exag={exaggeration} (first time or changed)")
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: model.prepare_conditionals(str(ref_path), exaggeration),
            )
            # Store a copy of the computed conds
            _cached_conds[cache_key] = {
                "conds": model.conds,
            }
            logger.info(f"[conds] Cached conditionals for {voice} exag={exaggeration} ✓")
        else:
            logger.debug(f"[conds] Using cached conditionals for {voice} exag={exaggeration}")
            # Restore cached conds into model
            model.conds = _cached_conds[cache_key]["conds"]
    return _cached_conds[cache_key]["conds"]


async def do_voice_switch(new_voice: str, ref_path: Path, exaggeration: float) -> dict:
    """
    Unload the prior voice from GPU and load the new one.

    Steps:
    1. Acquire the active-voice lock (serializes concurrent switches).
    2. Clear all cached conditionals (drops references to prior voice tensors).
    3. Set model.conds = None to release GPU tensors for GC.
    4. torch.cuda.synchronize() + torch.cuda.empty_cache() — return VRAM to pool.
    5. Pre-compute conditionals for the new voice.
    6. Update _active_voice.
    """
    global _active_voice

    async with _active_voice_lock:
        if _active_voice == new_voice:
            logger.info(f"[voice-switch] Already on '{new_voice}' — no-op")
            return {"status": "no-op", "voice": new_voice}

        old_voice = _active_voice
        model = await get_model()

        # 1. Drop cached conds (releases Python references to GPU tensors)
        async with _conds_lock:
            cleared_keys = list(_cached_conds.keys())
            _cached_conds.clear()
            # Release the model's active cond reference
            if hasattr(model, "conds") and model.conds is not None:
                model.conds = None

        logger.info(f"[voice-switch] {old_voice} → {new_voice}: cleared {len(cleared_keys)} cached cond(s): {cleared_keys}")

        # 2. GPU cleanup — synchronize then return freed VRAM to the pool
        if DEVICE == "cuda":
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            alloc_gb  = torch.cuda.memory_allocated()  / 1024 ** 3
            reserv_gb = torch.cuda.memory_reserved()   / 1024 ** 3
            logger.info(f"[voice-switch] GPU after clear: {alloc_gb:.2f}GB alloc, {reserv_gb:.2f}GB reserved")

        # 3. Pre-warm new voice conditionals
        logger.info(f"[voice-switch] Pre-computing conditionals for '{new_voice}'...")
        await get_cached_conds(model, new_voice, ref_path, exaggeration)

        _active_voice = new_voice
        logger.info(f"[voice-switch] '{new_voice}' ready ✓")
        return {"status": "switched", "from": old_voice, "to": new_voice}


def split_into_sentences(text: str, min_merge: int = 15, max_chars: int = 250) -> list[str]:
    """
    Split text into sentence chunks for streaming TTS.
    - Splits on sentence boundaries (.!? followed by space or end)
    - Only merges VERY short fragments (<min_merge chars) with the next sentence
    - Keeps most sentences separate for faster first-audio streaming
    - Caps chunks at max_chars
    """
    # Split on sentence boundaries, keeping the punctuation
    parts = re.split(r'(?<=[.!?])\s+', text.strip())
    parts = [p.strip() for p in parts if p.strip()]

    if not parts:
        return [text.strip()] if text.strip() else []

    # Only merge very short fragments (e.g. "Ok." or "Yes sir.")
    # Most sentences should stay separate for streaming
    chunks = []
    current = ""

    for part in parts:
        if not current:
            current = part
        elif len(current) < min_merge:
            # Current fragment is too short to be a standalone chunk — merge
            current = current + " " + part
        elif len(current) + len(part) + 1 <= max_chars and len(part) < min_merge:
            # Next fragment is too short — absorb it
            current = current + " " + part
        else:
            # Both are substantial — keep separate
            chunks.append(current)
            current = part

    if current:
        chunks.append(current)

    return [c for c in chunks if c]


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Chatterbox TTS Service",
    description="Multi-voice TTS — JARVIS + Owner voice clone (Chatterbox by Resemble AI)",
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
    model = await get_model()

    # Pre-cache conditionals for the DEFAULT voice only.
    # Other voices are loaded on demand (or explicitly via POST /voice/switch).
    # Loading all voices at startup wastes VRAM and defeats single-voice GPU management.
    default_path = VOICE_REFS.get(DEFAULT_VOICE)
    if default_path and default_path.exists():
        defaults = VOICE_DEFAULTS.get(DEFAULT_VOICE, VOICE_DEFAULTS["jarvis"])
        try:
            await get_cached_conds(model, DEFAULT_VOICE, default_path, defaults["exaggeration"])
            logger.info(f"  [conds] Pre-cached default voice: {DEFAULT_VOICE} ✓")
        except Exception as e:
            logger.warning(f"  [conds] Failed to pre-cache {DEFAULT_VOICE}: {e}")
    else:
        logger.warning(f"  [conds] Default voice reference missing: {default_path}")


@app.post("/tts")
async def text_to_speech(request: Request):
    """
    Generate speech using a cloned voice.

    JSON body:
      text          str   — text to speak (required)
      voice         str   — "jarvis" | "owner" (default: CHATTERBOX_DEFAULT_VOICE)
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

        # Use cached conditionals — skips prepare_conditionals (~0.5-1s) on subsequent calls
        await get_cached_conds(model, voice, ref_path, exaggeration)

        loop = asyncio.get_event_loop()
        wav_tensor = await loop.run_in_executor(
            None,
            lambda: model.generate(
                text,
                exaggeration=exaggeration,
                cfg_weight=cfg_weight,
                temperature=temperature,
            ),
        )

        # Append 250ms of trailing silence to prevent last-word clipping in Discord's audio player
        silence_samples = int(model.sr * 0.25)
        silence = torch.zeros(wav_tensor.shape[0], silence_samples)
        padded = torch.cat([wav_tensor.cpu(), silence], dim=1)

        buf = io.BytesIO()
        torchaudio.save(buf, padded, model.sr, format="wav")
        audio_bytes = buf.getvalue()

        elapsed = int((time.time() - t0) * 1000)
        logger.info(f"[{voice}] done in {elapsed}ms → {len(audio_bytes):,} bytes (+250ms silence pad)")

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


@app.post("/tts/stream")
async def text_to_speech_stream(request: Request):
    """
    Streaming TTS endpoint.

    Accepts the same JSON body as /tts.
    Responds with NDJSON (application/x-ndjson).
    Each line is a JSON object:
      {"index": 0, "audio_b64": "<base64 WAV>", "sentence": "...", "latency_ms": 1200}

    Sentences are generated sequentially on the GPU and streamed as they complete,
    so the client can start playing the first sentence while the rest generate.
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
        voice = DEFAULT_VOICE

    ref_path = VOICE_REFS[voice]
    if not ref_path.exists():
        raise HTTPException(
            status_code=503,
            detail=f"Voice reference missing for '{voice}': {ref_path}"
        )

    defaults = VOICE_DEFAULTS.get(voice, VOICE_DEFAULTS["jarvis"])
    exaggeration = float(data.get("exaggeration", defaults["exaggeration"]))
    cfg_weight   = float(data.get("cfg_weight",   defaults["cfg_weight"]))
    temperature  = float(data.get("temperature",  defaults["temperature"]))

    # Split into sentence chunks
    sentences = split_into_sentences(text)
    if not sentences:
        raise HTTPException(status_code=400, detail="No speakable text after splitting")

    logger.info(
        f"[stream/{voice}] {len(sentences)} sentences, {len(text)} chars total: "
        f"{text[:60]}{'...' if len(text) > 60 else ''}"
    )

    # Pre-cache conditionals before starting the stream
    model = await get_model()
    await get_cached_conds(model, voice, ref_path, exaggeration)

    async def generate_stream():
        loop = asyncio.get_event_loop()
        for idx, sentence in enumerate(sentences):
            t0 = time.time()
            try:
                wav_tensor = await loop.run_in_executor(
                    None,
                    lambda s=sentence: model.generate(
                        s,
                        exaggeration=exaggeration,
                        cfg_weight=cfg_weight,
                        temperature=temperature,
                    ),
                )

                # Add trailing silence to prevent last-word clipping
                silence_samples = int(model.sr * 0.25)
                silence = torch.zeros(wav_tensor.shape[0], silence_samples)
                padded = torch.cat([wav_tensor.cpu(), silence], dim=1)

                buf = io.BytesIO()
                torchaudio.save(buf, padded, model.sr, format="wav")
                audio_bytes = buf.getvalue()

                latency_ms = int((time.time() - t0) * 1000)
                audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

                line = json.dumps({
                    "index": idx,
                    "audio_b64": audio_b64,
                    "sentence": sentence,
                    "latency_ms": latency_ms,
                })
                logger.info(f"[stream/{voice}] sentence {idx}: {latency_ms}ms → {len(audio_bytes):,} bytes")
                yield line + "\n"

            except Exception as e:
                logger.exception(f"[stream/{voice}] error on sentence {idx}: {e}")
                error_line = json.dumps({"index": idx, "error": str(e), "sentence": sentence})
                yield error_line + "\n"

    return StreamingResponse(
        generate_stream(),
        media_type="application/x-ndjson",
        headers={
            "X-Chatterbox-Voice": voice,
            "X-Chatterbox-Sentences": str(len(sentences)),
            "Cache-Control": "no-cache",
        },
    )


@app.post("/v1/audio/speech")
async def openai_compat(request: Request):
    """
    OpenAI-compatible endpoint.
    POST { "input": "...", "model": "tts-1|tts-1-hd", "voice": "jarvis|owner|..." }
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


@app.post("/voice/switch")
async def voice_switch_endpoint(request: Request):
    """
    Switch the active voice. Unloads the prior voice from GPU, clears VRAM,
    then pre-warms the new voice's conditionals.

    JSON body:
      voice        str   — target voice name (required)
      exaggeration float — override exaggeration for pre-warm (optional)
    """
    data = await request.json()
    new_voice = str(data.get("voice", "")).lower()

    if not new_voice:
        raise HTTPException(status_code=400, detail="'voice' field required")
    if new_voice not in VOICE_REFS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown voice '{new_voice}'. Available: {list(VOICE_REFS.keys())}"
        )

    ref_path = VOICE_REFS[new_voice]
    if not ref_path.exists():
        raise HTTPException(
            status_code=503,
            detail=f"Voice reference missing for '{new_voice}': {ref_path}"
        )

    defaults = VOICE_DEFAULTS.get(new_voice, VOICE_DEFAULTS["jarvis"])
    exaggeration = float(data.get("exaggeration", defaults["exaggeration"]))

    result = await do_voice_switch(new_voice, ref_path, exaggeration)
    return result


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


@app.post("/voices/upload")
async def upload_voice(request: Request):
    """
    Upload an audio file as a new voice reference.
    Multipart form: audio (file), name (str), make_default (bool, optional).
    Saves to ~/dev/voice-clones/{name}/{name}_reference_15s.wav and hot-reloads VOICE_REFS.
    """
    import subprocess, tempfile, shutil
    from fastapi import UploadFile, Form
    form = await request.form()
    name = str(form.get("name", "")).strip().lower()
    make_default_val = str(form.get("make_default", "false")).lower()
    make_default = make_default_val in ("true", "1", "yes")
    audio = form.get("audio")

    if not name or not audio:
        raise HTTPException(status_code=400, detail="name and audio required")
    if not re.match(r'^[a-z0-9_-]+$', name):
        raise HTTPException(status_code=400, detail="name must be lowercase alphanumeric/underscore/dash only")

    audio_bytes = await audio.read()
    orig_filename = getattr(audio, "filename", "audio.wav") or "audio.wav"
    suffix = Path(orig_filename).suffix or ".wav"

    clone_dir = Path.home() / "dev" / "voice-clones" / name
    clone_dir.mkdir(parents=True, exist_ok=True)
    ref_path = clone_dir / f"{name}_reference_15s.wav"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        result = subprocess.run([
            "ffmpeg", "-y", "-i", tmp_path,
            "-t", "15", "-ar", "22050", "-ac", "1", "-acodec", "pcm_s16le",
            str(ref_path),
        ], capture_output=True, timeout=120)
        if result.returncode != 0:
            raise HTTPException(status_code=500,
                detail=f"ffmpeg failed: {result.stderr.decode()[:300]}")
    finally:
        os.unlink(tmp_path)

    VOICE_REFS[name] = ref_path
    if name not in VOICE_DEFAULTS:
        VOICE_DEFAULTS[name] = {"exaggeration": 0.35, "cfg_weight": 1.5, "temperature": 0.5}

    global DEFAULT_VOICE
    if make_default:
        DEFAULT_VOICE = name

    logger.info(f"[upload] saved voice '{name}' → {ref_path} (default={make_default})")
    return {"ok": True, "name": name, "path": str(ref_path), "active": make_default}


@app.post("/voice/defaults")
async def update_voice_defaults(request: Request):
    """
    Update in-memory tuning defaults for a voice and persist to state file.
    JSON body: { voice, exaggeration?, cfg_weight?, temperature? }
    """
    data = await request.json()
    voice = str(data.get("voice", DEFAULT_VOICE)).lower()
    if voice not in VOICE_DEFAULTS:
        raise HTTPException(status_code=400, detail=f"Unknown voice: {voice}")
    updates = {}
    for key in ("exaggeration", "cfg_weight", "temperature"):
        if key in data:
            updates[key] = float(data[key])
    if updates:
        VOICE_DEFAULTS[voice].update(updates)
        state_path = Path(os.getenv(
            "CHATTERBOX_STATE_FILE",
            str(Path.home() / ".local/state/chatterbox/defaults.json"),
        ))
        state_path.parent.mkdir(parents=True, exist_ok=True)
        with open(state_path, "w") as f:
            json.dump(VOICE_DEFAULTS, f, indent=2)
        logger.info(f"[defaults] {voice} updated: {updates}")
    return {"ok": True, "voice": voice, "defaults": VOICE_DEFAULTS[voice]}


@app.get("/health")
async def health():
    voices_ok = {name: path.exists() for name, path in VOICE_REFS.items()}
    gpu_info = {}
    if DEVICE == "cuda":
        gpu_info = {
            "allocated_gb": round(torch.cuda.memory_allocated() / 1024 ** 3, 2),
            "reserved_gb":  round(torch.cuda.memory_reserved()  / 1024 ** 3, 2),
        }
    all_ok = _model is not None and VOICE_REFS.get(_active_voice, Path("")).exists()
    return {
        "status": "healthy" if all_ok else "degraded",
        "device": DEVICE,
        "model_loaded": _model is not None,
        "active_voice": _active_voice,
        "default_voice": DEFAULT_VOICE,
        "cached_conds": list(_cached_conds.keys()),
        "voices": voices_ok,
        "gpu": gpu_info,
        "service": "chatterbox-tts",
        "version": "2.1.0",
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
