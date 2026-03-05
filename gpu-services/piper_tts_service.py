#!/usr/bin/env python3
"""
Piper TTS Service for Jarvis Voice
FastAPI wrapper around Piper TTS using pre-trained Jarvis models
Uses existing jarvis-high.onnx and jarvis-medium.onnx models
"""

import os
import asyncio
import tempfile
import subprocess
from pathlib import Path
from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import Response
import uvicorn
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="Piper TTS Service",
    description="Jarvis voice TTS using Piper with pre-trained models",
    version="1.0.0"
)

# Model paths — defaults work for both Docker (/app/models/jarvis) and manual install
# Override via env: PIPER_MODELS_DIR, PIPER_BIN
_repo_root = Path(__file__).resolve().parent.parent
MODELS_DIR = Path(os.getenv("PIPER_MODELS_DIR", str(_repo_root / "models" / "jarvis")))
PIPER_BIN = os.getenv("PIPER_BIN", "piper")  # assumes piper on PATH (pip install piper-tts)

# Available models
MODELS = {
    "high": MODELS_DIR / "jarvis-high.onnx",
    "medium": MODELS_DIR / "jarvis-medium.onnx"
}

@app.on_event("startup")
async def check_models():
    """Verify models exist on startup"""
    for quality, model_path in MODELS.items():
        if not model_path.exists():
            logger.error(f"Model not found: {model_path}")
            raise FileNotFoundError(f"Piper model missing: {model_path}")
        logger.info(f"Found Jarvis {quality} model: {model_path}")

    # Check if piper binary is available
    try:
        result = subprocess.run([PIPER_BIN, "--version"], capture_output=True, text=True)
        logger.info(f"Piper TTS ready: {result.stdout.strip()}")
    except FileNotFoundError:
        logger.error("Piper binary not found. Install with: pip install piper-tts")
        raise

@app.post("/tts")
async def text_to_speech(request: Request):
    """
    Convert text to speech using Piper Jarvis voice
    Accepts both JSON and form-encoded data.

    Parameters:
    - text: Text to convert to speech
    - quality/model: Model quality (high or medium, default: medium)
    - speed: Speech speed multiplier (default: 1.0)

    Returns:
    - WAV audio file
    """
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        data = await request.json()
        text = data.get("text", "")
        quality = data.get("quality") or data.get("model", "medium")
        speed = float(data.get("speed", 1.0))
    else:
        form = await request.form()
        text = form.get("text", "")
        quality = form.get("quality") or form.get("model", "medium")
        speed = float(form.get("speed", 1.0))

    if not text:
        raise HTTPException(status_code=400, detail="No text provided")

    # Validate quality
    if quality not in MODELS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid quality '{quality}'. Must be one of: {list(MODELS.keys())}"
        )

    model_path = MODELS[quality]

    try:
        logger.info(f"Generating TTS [{quality}]: {text[:50]}... ({len(text)} chars)")

        # Create temp output file
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_file:
            output_path = tmp_file.name

        # Run piper TTS
        # piper --model MODEL --output_file OUTPUT < input.txt
        cmd = [
            PIPER_BIN,
            "--model", str(model_path),
            "--output_file", output_path
        ]

        # Natural sentence pauses
        cmd.extend(["--sentence-silence", "0.3"])

        # Add length scale (inverse of speed)
        if speed != 1.0:
            length_scale = 1.0 / speed
            cmd.extend(["--length_scale", str(length_scale)])

        # Run piper with text as stdin
        result = subprocess.run(
            cmd,
            input=text,
            text=True,
            capture_output=True,
            check=True
        )

        # Read generated audio
        with open(output_path, "rb") as f:
            audio_data = f.read()

        # Clean up temp file
        os.unlink(output_path)

        logger.info(f"TTS generation complete: {len(audio_data)} bytes")

        # Return as WAV audio
        return Response(
            content=audio_data,
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=jarvis_speech.wav"
            }
        )

    except subprocess.CalledProcessError as e:
        logger.error(f"Piper TTS error: {e.stderr}")
        if 'output_path' in locals():
            try:
                os.unlink(output_path)
            except:
                pass
        raise HTTPException(status_code=500, detail=f"Piper TTS failed: {e.stderr}")

    except Exception as e:
        logger.error(f"TTS generation error: {e}")
        if 'output_path' in locals():
            try:
                os.unlink(output_path)
            except:
                pass
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/v1/audio/speech")
async def openai_compat_tts(request: Request):
    """
    OpenAI-compatible TTS endpoint for OpenClaw integration.
    POST /v1/audio/speech { "input": "...", "model": "tts-1|tts-1-hd", "voice": "..." }
    Returns WAV audio (same as /tts).
    """
    data = await request.json()
    text = data.get("input", "")
    model_hint = data.get("model", "tts-1")
    quality = "high" if model_hint == "tts-1-hd" else "medium"
    speed = float(data.get("speed", 1.0))

    if not text:
        raise HTTPException(status_code=400, detail="input required")

    if quality not in MODELS:
        quality = "medium"

    model_path = MODELS[quality]
    try:
        logger.info(f"Generating TTS (openai-compat) [{quality}]: {text[:50]}... ({len(text)} chars)")
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_file:
            tmp_path = tmp_file.name

        cmd = [
            str(PIPER_BIN), "--model", str(model_path),
            "--output_file", tmp_path, "--length_scale", str(1.0 / speed)
        ]
        process = await asyncio.create_subprocess_exec(
            *cmd, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
        )
        await process.communicate(input=text.encode())

        if process.returncode != 0:
            raise Exception(f"Piper failed with code {process.returncode}")

        audio_data = Path(tmp_path).read_bytes()
        os.unlink(tmp_path)

        return Response(content=audio_data, media_type="audio/wav",
                        headers={"X-Piper-Model": quality})
    except Exception as e:
        logger.error(f"TTS (openai-compat) error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health():
    """Health check endpoint"""
    models_ok = all(p.exists() for p in MODELS.values())
    return {
        "status": "healthy" if models_ok else "degraded",
        "models_available": {k: v.exists() for k, v in MODELS.items()},
        "voice": "Jarvis (Paul Bettany)",
        "service": "piper-tts"
    }

@app.get("/")
async def root():
    """Root endpoint with service info"""
    return {
        "service": "Piper TTS Service",
        "version": "1.0.0",
        "voice": "Jarvis (Paul Bettany)",
        "models": list(MODELS.keys()),
        "endpoints": {
            "/tts": "POST - Convert text to speech",
            "/health": "GET - Health check"
        }
    }

if __name__ == "__main__":
    # Run with uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=3336,
        log_level="info"
    )
