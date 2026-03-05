import os
import sys
import math
import logging
import argparse
import tempfile
from flask import Flask, request, jsonify
from faster_whisper import WhisperModel

# Logging setup (before arg parse so early errors are visible)
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Configuration via CLI flags — allows --device cpu override for GPU-less or broken-CUDA environments
parser = argparse.ArgumentParser(description='Jarvis Whisper STT Service')
parser.add_argument('--device', default='cuda', choices=['cuda', 'cpu'],
                    help='Compute device (default: cuda, use cpu if CUDA unavailable)')
parser.add_argument('--model', default='distil-large-v3',
                    help='Whisper model size (default: distil-large-v3)')
parser.add_argument('--port', type=int, default=8766,
                    help='HTTP port (default: 8766)')
args, _ = parser.parse_known_args()

DEVICE = args.device
MODEL_SIZE = args.model
PORT = args.port
COMPUTE_TYPE = 'float16' if DEVICE == 'cuda' else 'int8'

# Domain vocabulary hint — helps Whisper recognize project-specific terms
# instead of guessing common English words. Reduces "high mind" → "haivemind" etc.
INITIAL_PROMPT = (
    "Jarvis, haivemind, Clawdbot, Roku, Plex, qBittorrent, I2P, Discord, "
    "MCP, Deepgram, VirusTotal, GitHub, Radare2, OpenClaw, Gibson, Atlantis, "
    "eWitness, Tailscale"
)

try:
    import torch
    if DEVICE == 'cuda' and not torch.cuda.is_available():
        logger.warning("CUDA not available, falling back to CPU")
        DEVICE = 'cpu'
        COMPUTE_TYPE = 'int8'
    elif DEVICE == 'cuda':
        logger.info(f"CUDA available: {torch.cuda.get_device_name(0)}")
except (ImportError, OSError) as e:
    logger.error(f"torch import failed ({e}), falling back to CPU")
    DEVICE = 'cpu'
    COMPUTE_TYPE = 'int8'

logger.info(f"Starting STT service: model={MODEL_SIZE} device={DEVICE} compute_type={COMPUTE_TYPE} port={PORT}")

app = Flask(__name__)
model = None


def load_model():
    global model, DEVICE, COMPUTE_TYPE
    logger.info(f"Loading Whisper model: {MODEL_SIZE} on {DEVICE} ({COMPUTE_TYPE})...")
    try:
        model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
        logger.info(f"Model loaded successfully: {MODEL_SIZE} on {DEVICE}")
    except Exception as e:
        if DEVICE == 'cuda':
            logger.error(f"Failed to load model on CUDA ({e}), retrying on CPU")
            DEVICE = 'cpu'
            COMPUTE_TYPE = 'int8'
            try:
                model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
                logger.info(f"Model loaded on CPU fallback: {MODEL_SIZE}")
            except Exception as cpu_e:
                logger.error(f"Failed to load model on CPU: {cpu_e}")
                sys.exit(1)
        else:
            logger.error(f"Failed to load model: {e}")
            sys.exit(1)


@app.route('/health', methods=['GET'])
def health():
    if model:
        return jsonify({"status": "healthy", "model": MODEL_SIZE, "device": DEVICE}), 200
    return jsonify({"status": "loading"}), 503


@app.route('/transcribe', methods=['POST'])
def transcribe():
    if not model:
        return jsonify({"error": "Model not loaded"}), 503

    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files['audio']
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.wav')
    temp_path = tmp.name
    tmp.close()

    try:
        audio_file.save(temp_path)

        segments, info = model.transcribe(
            temp_path,
            beam_size=5,
            language="en",
            initial_prompt=INITIAL_PROMPT,
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=500,
                speech_pad_ms=200,
            ),
        )

        # Collect segments with confidence metadata
        seg_list = []
        for segment in segments:
            seg_list.append({
                "text": segment.text.strip(),
                "start": segment.start,
                "end": segment.end,
                "no_speech_prob": segment.no_speech_prob,
                "avg_logprob": segment.avg_logprob,
            })

        text = " ".join([s["text"] for s in seg_list])

        # Aggregate confidence scores across segments
        if seg_list:
            avg_no_speech = sum(s["no_speech_prob"] for s in seg_list) / len(seg_list)
            avg_logprob = sum(s["avg_logprob"] for s in seg_list) / len(seg_list)
        else:
            avg_no_speech = 1.0
            avg_logprob = -10.0

        # Confidence = exp(avg_logprob), clamped to [0, 1]
        confidence = min(1.0, max(0.0, math.exp(avg_logprob)))

        # Cleanup
        os.remove(temp_path)

        return jsonify({
            "text": text,
            "language": info.language,
            "probability": info.language_probability,
            "confidence": round(confidence, 4),
            "no_speech_prob": round(avg_no_speech, 4),
            "avg_logprob": round(avg_logprob, 4),
            "segment_count": len(seg_list),
        })

    except Exception as e:
        logger.error(f"Transcription error: {e}")
        if os.path.exists(temp_path):
            os.remove(temp_path)
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    load_model()
    app.run(host='0.0.0.0', port=PORT)
