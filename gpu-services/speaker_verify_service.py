import os
import sys
import logging
import argparse
import tempfile
import threading
import numpy as np

# Shim for torchaudio 2.10+ which removed list_audio_backends().
# SpeechBrain 1.0.x still calls it on import, causing AttributeError.
import torchaudio
if not hasattr(torchaudio, 'list_audio_backends'):
    torchaudio.list_audio_backends = lambda: ['default']
if not hasattr(torchaudio, 'get_audio_backend'):
    torchaudio.get_audio_backend = lambda: 'default'
if not hasattr(torchaudio, 'set_audio_backend'):
    torchaudio.set_audio_backend = lambda _: None

from flask import Flask, request, jsonify

# Logging setup
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# CLI flags
parser = argparse.ArgumentParser(description='Jarvis Speaker Verification Service')
parser.add_argument('--device', default='cuda', choices=['cuda', 'cpu'],
                    help='Compute device (default: cuda)')
parser.add_argument('--port', type=int, default=8767,
                    help='HTTP port (default: 8767)')
parser.add_argument('--threshold', type=float, default=None,
                    help='Speaker similarity threshold (default: env SPEAKER_THRESHOLD or 0.65)')
args, _ = parser.parse_known_args()

DEVICE = args.device
PORT = args.port
SPEAKER_THRESHOLD = args.threshold or float(os.environ.get('SPEAKER_THRESHOLD', '0.65'))
VOICEPRINT_PATH = os.path.expanduser(os.environ.get('VOICEPRINT_PATH', '~/.jarvis/owner_voiceprint.npy'))
VOICEPRINT_MULTI_PATH = os.path.expanduser(os.environ.get('VOICEPRINT_MULTI_PATH', '~/.jarvis/owner_voiceprints.npy'))

# Ensure voiceprint directory exists
os.makedirs(os.path.dirname(VOICEPRINT_PATH), exist_ok=True)

# Check CUDA availability
try:
    import torch
    if DEVICE == 'cuda' and not torch.cuda.is_available():
        logger.warning("CUDA not available, falling back to CPU")
        DEVICE = 'cpu'
    elif DEVICE == 'cuda':
        logger.info(f"CUDA available: {torch.cuda.get_device_name(0)}")
except (ImportError, OSError) as e:
    logger.error(f"torch import failed ({e}), falling back to CPU")
    DEVICE = 'cpu'

logger.info(f"Starting Speaker Verify service: device={DEVICE} port={PORT} threshold={SPEAKER_THRESHOLD}")

app = Flask(__name__)

# Models loaded at startup
vad_lock = threading.Lock()  # Silero VAD has stateful RNN -- not thread-safe
vad_model = None
ecapa_model = None
owner_voiceprint = None        # Legacy single averaged embedding (fallback)
owner_voiceprints = None       # Multi-reference: all individual enrollment embeddings (N x 192)
enrollment_embeddings = []     # Accumulator for enrollment clips

# Score normalization cohort stats (computed from enrollment embeddings)
# Each entry: (mean_similarity_to_others, std_similarity_to_others)
cohort_stats = None

# GPU memory management: periodically flush PyTorch's CUDA allocator cache
_inference_call_count = 0
_CACHE_CLEAR_INTERVAL = 50  # clear every 50 inference calls


def _maybe_clear_cuda_cache():
    """Release PyTorch's reserved-but-unallocated GPU memory back to the driver.
    Called periodically to prevent the allocator cache from growing unbounded."""
    global _inference_call_count
    _inference_call_count += 1
    if _inference_call_count % _CACHE_CLEAR_INTERVAL == 0:
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                logger.debug(f"CUDA cache cleared (call #{_inference_call_count})")
        except Exception:
            pass


def compute_cohort_stats(voiceprints):
    """Pre-compute self-cohort statistics for s-norm score normalization.
    For each reference embedding, compute mean and std of its cosine similarity
    to all other reference embeddings. Used to normalize raw verification scores
    into "how unusual is this match" z-scores, dramatically improving discrimination."""
    if voiceprints is None or len(voiceprints) < 2:
        return None

    stats = []
    for i, ref in enumerate(voiceprints):
        scores = [cosine_similarity(ref, other) for j, other in enumerate(voiceprints) if i != j]
        stats.append((float(np.mean(scores)), float(np.std(scores))))
    logger.info(f"Cohort stats computed for {len(voiceprints)} references (mean_sim={np.mean([s[0] for s in stats]):.3f})")
    return stats


def load_models():
    global vad_model, ecapa_model, owner_voiceprint, owner_voiceprints, cohort_stats

    # Load Silero VAD
    logger.info("Loading Silero VAD...")
    import torch
    vad_model_bundle, vad_utils = torch.hub.load(
        repo_or_dir='snakers4/silero-vad',
        model='silero_vad',
        trust_repo=True
    )
    vad_model_bundle.eval()  # inference-only mode, disables dropout/gradients
    vad_model = {
        'model': vad_model_bundle,
        'utils': vad_utils,
    }
    logger.info("Silero VAD loaded")

    # Load ECAPA-TDNN from SpeechBrain
    logger.info("Loading ECAPA-TDNN speaker encoder...")
    from speechbrain.inference.speaker import EncoderClassifier
    run_opts = {"device": DEVICE} if DEVICE == 'cuda' else {}
    ecapa_model = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir=os.path.expanduser("~/.cache/speechbrain/spkrec-ecapa-voxceleb"),
        run_opts=run_opts,
    )
    ecapa_model.eval()  # inference-only mode -- critical to prevent gradient accumulation
    logger.info(f"ECAPA-TDNN loaded on {DEVICE}")

    # Load multi-reference voiceprints (preferred) or legacy single voiceprint
    if os.path.exists(VOICEPRINT_MULTI_PATH):
        owner_voiceprints = np.load(VOICEPRINT_MULTI_PATH)
        logger.info(f"Multi-reference voiceprints loaded ({owner_voiceprints.shape}) from {VOICEPRINT_MULTI_PATH}")
        cohort_stats = compute_cohort_stats(owner_voiceprints)
    elif os.path.exists(VOICEPRINT_PATH):
        owner_voiceprint = np.load(VOICEPRINT_PATH)
        logger.info(f"Legacy single voiceprint loaded ({owner_voiceprint.shape}) from {VOICEPRINT_PATH}")
    else:
        logger.warning(f"No voiceprint found -- run enrollment first")


def detect_speech(audio_path):
    """Run Silero VAD on audio file. Returns True if speech detected."""
    import torch
    import torchaudio

    wav, sr = torchaudio.load(audio_path)
    # Resample to 16kHz mono if needed
    if sr != 16000:
        resampler = torchaudio.transforms.Resample(orig_freq=sr, new_freq=16000)
        wav = resampler(wav)
        del resampler
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)
    wav = wav.squeeze()

    model = vad_model['model']
    get_speech_timestamps = vad_model['utils'][0]
    with vad_lock:
        with torch.no_grad():
            speech_timestamps = get_speech_timestamps(wav, model, sampling_rate=16000)

    del wav
    return len(speech_timestamps) > 0, speech_timestamps


def extract_embedding(audio_path):
    """Extract 192-dim ECAPA-TDNN speaker embedding from audio."""
    import torch
    import torchaudio
    wav, sr = torchaudio.load(audio_path)
    # Resample to 16kHz mono
    if sr != 16000:
        resampler = torchaudio.transforms.Resample(orig_freq=sr, new_freq=16000)
        wav = resampler(wav)
        del resampler
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)

    # torch.no_grad() is critical -- without it PyTorch keeps every intermediate
    # tensor alive for backprop on every call, leaking GPU memory at ~13GB/session
    with torch.no_grad():
        embedding = ecapa_model.encode_batch(wav)
    result = embedding.squeeze().cpu().detach().numpy()
    del embedding, wav
    _maybe_clear_cuda_cache()
    return result


def cosine_similarity(a, b):
    """Compute cosine similarity between two vectors."""
    dot = np.dot(a, b)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(dot / (norm_a * norm_b))


def compute_normalized_score(embedding, voiceprints, stats):
    """S-norm score normalization: transform raw cosine similarity into a z-score
    relative to the self-cohort distribution. This makes the score independent of
    the absolute embedding quality (affected by codec, noise, etc.) and instead
    measures how much this test sample stands out vs. the cohort.

    Returns (normalized_score, raw_max_score, best_ref_idx)."""
    raw_scores = [cosine_similarity(embedding, ref) for ref in voiceprints]
    best_idx = int(np.argmax(raw_scores))
    raw_max = raw_scores[best_idx]

    if stats is None or len(stats) != len(voiceprints):
        return raw_max, raw_max, best_idx

    # Z-normalize each score against its reference's cohort distribution
    normalized = []
    for i, raw in enumerate(raw_scores):
        mean, std = stats[i]
        if std > 1e-6:
            normalized.append((raw - mean) / std)
        else:
            normalized.append(raw - mean)

    norm_best_idx = int(np.argmax(normalized))
    return float(normalized[norm_best_idx]), raw_max, norm_best_idx


def classify_confidence(raw_score, norm_score, threshold):
    """Return confidence tier based on both raw and normalized scores.
    - high: clearly the owner, well above threshold
    - medium: likely the owner but borderline
    - low: below threshold, probably not the owner"""
    if norm_score is not None and norm_score != raw_score:
        # With normalization: z-score > 1.5 = high, > 0.5 = medium
        if norm_score > 1.5 and raw_score >= threshold:
            return "high"
        elif norm_score > 0.5 and raw_score >= threshold * 0.9:
            return "medium"
        else:
            return "low"
    else:
        # Without normalization: use raw score margins
        if raw_score >= threshold + 0.15:
            return "high"
        elif raw_score >= threshold:
            return "medium"
        else:
            return "low"


@app.route('/health', methods=['GET'])
def health():
    has_voiceprint = owner_voiceprints is not None or owner_voiceprint is not None
    ref_count = len(owner_voiceprints) if owner_voiceprints is not None else (1 if owner_voiceprint is not None else 0)
    return jsonify({
        "status": "healthy" if ecapa_model and vad_model else "loading",
        "device": DEVICE,
        "threshold": SPEAKER_THRESHOLD,
        "voiceprint_loaded": has_voiceprint,
        "reference_embeddings": ref_count,
        "cohort_stats_loaded": cohort_stats is not None,
        "enrollment_clips": len(enrollment_embeddings),
    }), 200 if ecapa_model and vad_model else 503


@app.route('/verify', methods=['POST'])
def verify():
    """Verify if audio belongs to the enrolled owner.
    Accepts multipart form with 'audio' file field.
    Returns { is_owner, confidence, confidence_tier, raw_score, norm_score, has_speech }
    """
    if not ecapa_model or not vad_model:
        return jsonify({"error": "Models not loaded"}), 503

    if owner_voiceprints is None and owner_voiceprint is None:
        return jsonify({"error": "No voiceprint enrolled. Run enrollment first."}), 400

    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files['audio']
    temp_path = None

    try:
        # Save to temp file
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            temp_path = tmp.name
            audio_file.save(temp_path)

        # Stage 1: Silero VAD -- reject non-speech
        has_speech, timestamps = detect_speech(temp_path)
        if not has_speech:
            return jsonify({
                "is_owner": False,
                "confidence": 0.0,
                "confidence_tier": "low",
                "has_speech": False,
                "reason": "no_speech_detected",
            })

        # Stage 2: ECAPA-TDNN speaker verification with score normalization
        embedding = extract_embedding(temp_path)

        if owner_voiceprints is not None:
            norm_score, raw_score, best_idx = compute_normalized_score(
                embedding, owner_voiceprints, cohort_stats
            )
            # Decision uses raw score against threshold (normalized score informs tier)
            is_owner = raw_score >= SPEAKER_THRESHOLD
            tier = classify_confidence(raw_score, norm_score if cohort_stats else None, SPEAKER_THRESHOLD)
            # Medium tier with session context = allow through
            if tier == "medium" and not is_owner:
                is_owner = True  # Medium confidence = benefit of the doubt for codec-degraded audio
            logger.info(f"Verify: raw={raw_score:.3f} norm={norm_score:.3f} tier={tier} ref={best_idx} -> {'owner' if is_owner else 'reject'}")
        else:
            raw_score = cosine_similarity(embedding, owner_voiceprint)
            norm_score = raw_score
            is_owner = raw_score >= SPEAKER_THRESHOLD
            tier = classify_confidence(raw_score, None, SPEAKER_THRESHOLD)

        return jsonify({
            "is_owner": is_owner,
            "confidence": round(raw_score, 4),
            "norm_score": round(norm_score, 4),
            "confidence_tier": tier,
            "has_speech": True,
            "threshold": SPEAKER_THRESHOLD,
        })

    except Exception as e:
        logger.error(f"Verification error: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@app.route('/enroll', methods=['POST'])
def enroll():
    """Add an enrollment clip. Accumulates embeddings.
    POST multiple clips, then call POST /enroll/finalize to save the voiceprint.
    Returns embedding consistency info after 3+ clips."""
    if not ecapa_model or not vad_model:
        return jsonify({"error": "Models not loaded"}), 503

    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files['audio']
    temp_path = None

    try:
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            temp_path = tmp.name
            audio_file.save(temp_path)

        # Check for speech first
        has_speech, timestamps = detect_speech(temp_path)
        if not has_speech:
            return jsonify({
                "accepted": False,
                "reason": "no_speech_detected",
                "clips_collected": len(enrollment_embeddings),
            })

        # Compute speech duration from VAD timestamps (16kHz sample rate)
        speech_samples = sum(ts['end'] - ts['start'] for ts in timestamps)
        speech_duration_ms = (speech_samples / 16000) * 1000

        # Reject clips with very little speech content (< 400ms of actual speech)
        if speech_duration_ms < 400:
            return jsonify({
                "accepted": False,
                "reason": "speech_too_short",
                "speech_duration_ms": round(speech_duration_ms),
                "clips_collected": len(enrollment_embeddings),
            })

        # Extract embedding
        embedding = extract_embedding(temp_path)

        # Embedding consistency check: after 3 clips, reject outliers
        consistency_score = None
        if len(enrollment_embeddings) >= 3:
            sims = [cosine_similarity(embedding, existing) for existing in enrollment_embeddings]
            consistency_score = float(np.mean(sims))
            if consistency_score < 0.35:
                logger.warning(f"Enrollment clip rejected (outlier): consistency={consistency_score:.3f}")
                return jsonify({
                    "accepted": False,
                    "reason": "outlier_embedding",
                    "consistency_score": round(consistency_score, 3),
                    "clips_collected": len(enrollment_embeddings),
                })

        enrollment_embeddings.append(embedding)

        logger.info(f"Enrollment clip #{len(enrollment_embeddings)} accepted"
                     + (f" (consistency={consistency_score:.3f})" if consistency_score else ""))
        result = {
            "accepted": True,
            "clips_collected": len(enrollment_embeddings),
        }
        if consistency_score is not None:
            result["consistency_score"] = round(consistency_score, 3)
        return jsonify(result)

    except Exception as e:
        logger.error(f"Enrollment error: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@app.route('/enroll/finalize', methods=['POST'])
def enroll_finalize():
    """Save enrollment embeddings -- merges with existing voiceprints if present."""
    global owner_voiceprint, owner_voiceprints, enrollment_embeddings, cohort_stats

    if len(enrollment_embeddings) < 1:
        return jsonify({
            "error": f"No enrollment clips to save",
        }), 400

    # For fresh enrollment, require at least 3 clips
    if owner_voiceprints is None and len(enrollment_embeddings) < 3:
        return jsonify({
            "error": f"Need at least 3 enrollment clips, have {len(enrollment_embeddings)}",
        }), 400

    # L2-normalize each new embedding
    normed = []
    for emb in enrollment_embeddings:
        norm = np.linalg.norm(emb)
        normed.append(emb / norm if norm > 0 else emb)
    new_embeds = np.stack(normed)

    # Merge with existing voiceprints if present (learn mode)
    if owner_voiceprints is not None:
        multi = np.concatenate([owner_voiceprints, new_embeds], axis=0)
        logger.info(f"Learn mode: added {len(normed)} clips to existing {len(owner_voiceprints)} (total: {len(multi)})")
    else:
        multi = new_embeds

    np.save(VOICEPRINT_MULTI_PATH, multi)
    owner_voiceprints = multi
    owner_voiceprint = None  # Prefer multi-reference
    clip_count = len(enrollment_embeddings)
    enrollment_embeddings = []  # Reset accumulator

    # Recompute cohort stats for score normalization
    cohort_stats = compute_cohort_stats(multi)

    logger.info(f"Multi-reference voiceprint saved to {VOICEPRINT_MULTI_PATH} ({len(multi)} total embeddings)")
    return jsonify({
        "saved": True,
        "path": VOICEPRINT_MULTI_PATH,
        "clips_saved": clip_count,
        "total_references": len(multi),
        "embedding_dim": multi.shape[1],
        "mode": "multi_reference",
    })


@app.route('/enroll/reset', methods=['POST'])
def enroll_reset():
    """Reset enrollment accumulator without saving."""
    global enrollment_embeddings
    count = len(enrollment_embeddings)
    enrollment_embeddings = []
    return jsonify({"reset": True, "clips_discarded": count})


# ── Online Speaker Diarization (embedding clustering) ────────────────
# Maintains speaker clusters during a recording session. Each utterance
# gets assigned to the closest cluster or spawns a new one. Owner voice
# is identified first via the existing voiceprint, everything else clusters.

diarize_state = {
    'active': False,
    'clusters': [],       # [{ label, centroid (np.array), count, rms_sum, rms_count }]
    'speaker_count': 0,
    'merge_threshold': 0.55,  # lower for speakerphone audio (room acoustics degrade similarity)
    'loudest_label': None,
    'loudest_rms': 0.0,
}


def compute_rms_db(audio_path):
    """Compute RMS amplitude in dB from a WAV file."""
    import torchaudio
    wav, sr = torchaudio.load(audio_path)
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)
    rms = float(wav.pow(2).mean().sqrt())
    if rms < 1e-10:
        return -100.0
    import math
    return round(20 * math.log10(rms), 1)


@app.route('/diarize/start', methods=['POST'])
def diarize_start():
    """Reset clusters for a new recording session."""
    diarize_state['active'] = True
    diarize_state['clusters'] = []
    diarize_state['speaker_count'] = 0
    logger.info("Diarize: session started")
    return jsonify({"status": "started"})


@app.route('/diarize/stop', methods=['POST'])
def diarize_stop():
    """End session, return participant summary with dB profiles."""
    speakers = []
    for c in diarize_state['clusters']:
        avg_db = round(c.get('rms_sum', 0) / max(c.get('rms_count', 1), 1), 1)
        speakers.append({
            'label': c['label'],
            'utterances': c['count'],
            'avg_rms_db': avg_db,
        })
    # Sort by avg dB descending -- loudest first (closest to mic = owner)
    speakers.sort(key=lambda s: s['avg_rms_db'], reverse=True)
    participants = [s['label'] for s in speakers]
    loudest = speakers[0]['label'] if speakers else None
    count = len(speakers)
    diarize_state['active'] = False
    diarize_state['clusters'] = []
    diarize_state['speaker_count'] = 0
    logger.info(f"Diarize: stopped ({count} speakers, loudest={loudest}, profiles={speakers})")
    return jsonify({
        "participants": participants,
        "cluster_count": count,
        "loudest": loudest,
        "speaker_profiles": speakers,
    })


@app.route('/diarize', methods=['POST'])
def diarize():
    """Identify speaker for a single utterance via embedding clustering.
    Returns { speaker, confidence, is_owner }."""
    if not ecapa_model or not vad_model:
        return jsonify({"error": "Models not loaded"}), 503

    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files['audio']
    temp_path = None

    try:
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            temp_path = tmp.name
            audio_file.save(temp_path)

        # VAD check
        has_speech, _ = detect_speech(temp_path)
        if not has_speech:
            return jsonify({"speaker": "Unknown", "confidence": 0.0, "is_owner": False, "reason": "no_speech"})

        embedding = extract_embedding(temp_path)
        rms_db = compute_rms_db(temp_path)

        # Owner check first (reuse voiceprint verification logic)
        is_owner = False
        owner_confidence = 0.0
        if owner_voiceprints is not None:
            norm_score, raw_score, _ = compute_normalized_score(embedding, owner_voiceprints, cohort_stats)
            is_owner = raw_score >= SPEAKER_THRESHOLD or norm_score > -0.5
            owner_confidence = raw_score
            if is_owner:
                # Make sure "Lance" is in clusters for participant tracking
                if not any(c['label'] == 'Lance' for c in diarize_state['clusters']):
                    diarize_state['clusters'].append({
                        'label': 'Lance',
                        'centroid': embedding.copy(),
                        'count': 1,
                        'rms_sum': rms_db,
                        'rms_count': 1,
                    })
                else:
                    for c in diarize_state['clusters']:
                        if c['label'] == 'Lance':
                            c['centroid'] = (c['centroid'] * c['count'] + embedding) / (c['count'] + 1)
                            c['count'] += 1
                            c['rms_sum'] = c.get('rms_sum', 0) + rms_db
                            c['rms_count'] = c.get('rms_count', 0) + 1
                            break
                logger.info(f"Diarize: Lance (raw={raw_score:.3f} norm={norm_score:.3f} dB={rms_db})")
                return jsonify({"speaker": "Lance", "confidence": round(raw_score, 4), "is_owner": True, "rms_db": rms_db})
        elif owner_voiceprint is not None:
            raw_score = cosine_similarity(embedding, owner_voiceprint)
            if raw_score >= SPEAKER_THRESHOLD:
                logger.info(f"Diarize: Lance (raw={raw_score:.3f} dB={rms_db})")
                return jsonify({"speaker": "Lance", "confidence": round(raw_score, 4), "is_owner": True, "rms_db": rms_db})

        # Cluster matching for non-owner voices
        best_sim = -1.0
        best_cluster = None
        for cluster in diarize_state['clusters']:
            if cluster['label'] == 'Lance':
                continue
            sim = cosine_similarity(embedding, cluster['centroid'])
            if sim > best_sim:
                best_sim = sim
                best_cluster = cluster

        if best_cluster and best_sim >= diarize_state['merge_threshold']:
            best_cluster['centroid'] = (best_cluster['centroid'] * best_cluster['count'] + embedding) / (best_cluster['count'] + 1)
            best_cluster['count'] += 1
            best_cluster['rms_sum'] = best_cluster.get('rms_sum', 0) + rms_db
            best_cluster['rms_count'] = best_cluster.get('rms_count', 0) + 1
            label = best_cluster['label']
            logger.info(f"Diarize: {label} (sim={best_sim:.3f} dB={rms_db} count={best_cluster['count']})")
        else:
            diarize_state['speaker_count'] += 1
            label = f"Speaker {diarize_state['speaker_count']}"
            diarize_state['clusters'].append({
                'label': label,
                'centroid': embedding.copy(),
                'count': 1,
                'rms_sum': rms_db,
                'rms_count': 1,
            })
            logger.info(f"Diarize: new {label} (best_sim={best_sim:.3f} dB={rms_db})")

        return jsonify({"speaker": label, "confidence": round(best_sim, 4), "is_owner": False, "rms_db": rms_db})

    except Exception as e:
        logger.error(f"Diarize error: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


if __name__ == '__main__':
    load_models()
    app.run(host='0.0.0.0', port=PORT)
