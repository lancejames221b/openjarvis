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
# Per-user voiceprint directory: ~/.jarvis/voiceprints/{user_id}.npy
VOICEPRINTS_DIR = os.path.expanduser(os.environ.get('VOICEPRINTS_DIR', '~/.jarvis/voiceprints'))
# Legacy single-user paths (kept for migration)
VOICEPRINT_PATH = os.path.expanduser(os.environ.get('VOICEPRINT_PATH', '~/.jarvis/owner_voiceprint.npy'))
VOICEPRINT_MULTI_PATH = os.path.expanduser(os.environ.get('VOICEPRINT_MULTI_PATH', '~/.jarvis/owner_voiceprints.npy'))

os.makedirs(VOICEPRINTS_DIR, exist_ok=True)

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

# Per-user voiceprints: { user_id: np.ndarray (N x 192) }
user_voiceprints = {}
# Per-user s-norm cohort stats: { user_id: [(mean, std), ...] }
user_cohort_stats = {}

# Legacy single-user state (fallback if no per-user files found)
owner_voiceprint = None
owner_voiceprints = None
cohort_stats = None

# Per-enrollment-session accumulators: { user_id: [embedding, ...] }
enrollment_embeddings_by_user = {}
# Default enrollment user (when no user_id provided)
enrollment_embeddings = []

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

    # Load per-user voiceprints from VOICEPRINTS_DIR/{user_id}.npy
    loaded = 0
    if os.path.isdir(VOICEPRINTS_DIR):
        for fname in os.listdir(VOICEPRINTS_DIR):
            if not fname.endswith('.npy'):
                continue
            user_id = fname[:-4]
            path = os.path.join(VOICEPRINTS_DIR, fname)
            try:
                vp = np.load(path)
                user_voiceprints[user_id] = vp
                user_cohort_stats[user_id] = compute_cohort_stats(vp)
                logger.info(f"Voiceprint loaded: user={user_id} refs={len(vp)} from {path}")
                loaded += 1
            except Exception as e:
                logger.warning(f"Failed to load voiceprint {path}: {e}")

    # Migrate legacy owner_voiceprints.npy → voiceprints/owner.npy
    if loaded == 0 and os.path.exists(VOICEPRINT_MULTI_PATH):
        vp = np.load(VOICEPRINT_MULTI_PATH)
        dest = os.path.join(VOICEPRINTS_DIR, 'owner.npy')
        np.save(dest, vp)
        user_voiceprints['owner'] = vp
        user_cohort_stats['owner'] = compute_cohort_stats(vp)
        logger.info(f"Migrated legacy voiceprint → {dest} ({len(vp)} refs)")
        loaded += 1
    elif loaded == 0 and os.path.exists(VOICEPRINT_PATH):
        vp = np.load(VOICEPRINT_PATH)
        dest = os.path.join(VOICEPRINTS_DIR, 'owner.npy')
        np.save(dest, vp)
        user_voiceprints['owner'] = vp
        user_cohort_stats['owner'] = None
        logger.info(f"Migrated legacy single voiceprint → {dest}")
        loaded += 1

    if loaded == 0:
        logger.warning("No voiceprints found -- run enrollment first")
    else:
        logger.info(f"Loaded voiceprints for {loaded} user(s): {list(user_voiceprints.keys())}")


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
    total_refs = sum(len(vp) for vp in user_voiceprints.values())
    pending = sum(len(clips) for clips in enrollment_embeddings_by_user.values()) + len(enrollment_embeddings)
    return jsonify({
        "status": "healthy" if ecapa_model and vad_model else "loading",
        "device": DEVICE,
        "threshold": SPEAKER_THRESHOLD,
        "enrolled_users": list(user_voiceprints.keys()),
        "total_reference_embeddings": total_refs,
        "enrollment_clips_pending": pending,
    }), 200 if ecapa_model and vad_model else 503


@app.route('/verify', methods=['POST'])
def verify():
    """Verify which enrolled user the audio belongs to.
    Accepts multipart form with 'audio' file and optional 'user_id' field.
    Returns { user_id, is_owner, confidence, confidence_tier, raw_score, norm_score, has_speech }
    - user_id: the matched enrolled user, or null if rejected
    - is_owner: true when user_id matches ALLOWED_USERS[0] (the primary owner)
    """
    if not ecapa_model or not vad_model:
        return jsonify({"error": "Models not loaded"}), 503

    if not user_voiceprints:
        return jsonify({"error": "No voiceprint enrolled. Run enrollment first."}), 400

    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files['audio']
    # Optional: verify against a specific user only
    target_user_id = request.form.get('user_id')
    temp_path = None

    try:
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            temp_path = tmp.name
            audio_file.save(temp_path)

        # Stage 1: Silero VAD
        has_speech, timestamps = detect_speech(temp_path)
        if not has_speech:
            return jsonify({
                "user_id": None,
                "is_owner": False,
                "confidence": 0.0,
                "confidence_tier": "low",
                "has_speech": False,
                "reason": "no_speech_detected",
            })

        # Stage 2: ECAPA-TDNN embedding
        embedding = extract_embedding(temp_path)

        # Determine which users to check
        candidates = {target_user_id: user_voiceprints[target_user_id]} \
            if target_user_id and target_user_id in user_voiceprints \
            else user_voiceprints

        best_user_id = None
        best_raw = -1.0
        best_norm = -1.0
        best_tier = "low"

        for uid, vp in candidates.items():
            stats = user_cohort_stats.get(uid)
            if len(vp) >= 2:
                norm_score, raw_score, _ = compute_normalized_score(embedding, vp, stats)
            else:
                raw_score = cosine_similarity(embedding, vp[0]) if len(vp) else 0.0
                norm_score = raw_score

            tier = classify_confidence(raw_score, norm_score if stats else None, SPEAKER_THRESHOLD)
            if raw_score > best_raw:
                best_raw = raw_score
                best_norm = norm_score
                best_user_id = uid
                best_tier = tier

        matched = best_raw >= SPEAKER_THRESHOLD
        matched_user = best_user_id if matched else None
        # is_owner: true if the matched user is enrolled as 'owner' (legacy) or is ALLOWED_USERS[0]
        _primary = os.environ.get('OWNER_USER_ID', 'owner')
        is_owner = matched and (matched_user == _primary or matched_user == 'owner')

        logger.info(f"Verify: user={matched_user} raw={best_raw:.3f} norm={best_norm:.3f} tier={best_tier} -> {'match' if matched else 'reject'}")

        return jsonify({
            "user_id": matched_user,
            "is_owner": is_owner,
            "confidence": round(best_raw, 4),
            "norm_score": round(best_norm, 4),
            "confidence_tier": best_tier,
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
    """Add an enrollment clip for a specific user.
    POST with 'audio' file and optional 'user_id' form field (defaults to 'owner').
    Call POST /enroll/finalize with the same user_id to save."""
    if not ecapa_model or not vad_model:
        return jsonify({"error": "Models not loaded"}), 503

    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files['audio']
    user_id = request.form.get('user_id', 'owner')
    temp_path = None

    if user_id not in enrollment_embeddings_by_user:
        enrollment_embeddings_by_user[user_id] = []
    clips = enrollment_embeddings_by_user[user_id]

    try:
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            temp_path = tmp.name
            audio_file.save(temp_path)

        has_speech, timestamps = detect_speech(temp_path)
        if not has_speech:
            return jsonify({
                "accepted": False,
                "reason": "no_speech_detected",
                "clips_collected": len(clips),
            })

        speech_samples = sum(ts['end'] - ts['start'] for ts in timestamps)
        speech_duration_ms = (speech_samples / 16000) * 1000

        if speech_duration_ms < 400:
            return jsonify({
                "accepted": False,
                "reason": "speech_too_short",
                "speech_duration_ms": round(speech_duration_ms),
                "clips_collected": len(clips),
            })

        embedding = extract_embedding(temp_path)

        # Consistency check: reject outliers after 3+ clips
        consistency_score = None
        if len(clips) >= 3:
            sims = [cosine_similarity(embedding, existing) for existing in clips]
            consistency_score = float(np.mean(sims))
            if consistency_score < 0.35:
                logger.warning(f"Enroll [{user_id}] clip rejected (outlier): consistency={consistency_score:.3f}")
                return jsonify({
                    "accepted": False,
                    "reason": "outlier_embedding",
                    "consistency_score": round(consistency_score, 3),
                    "clips_collected": len(clips),
                })

        clips.append(embedding)
        logger.info(f"Enroll [{user_id}] clip #{len(clips)} accepted"
                    + (f" (consistency={consistency_score:.3f})" if consistency_score else ""))
        result = {"accepted": True, "clips_collected": len(clips), "user_id": user_id}
        if consistency_score is not None:
            result["consistency_score"] = round(consistency_score, 3)
        return jsonify(result)

    except Exception as e:
        logger.error(f"Enrollment error [{user_id}]: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@app.route('/enroll/finalize', methods=['POST'])
def enroll_finalize():
    """Save enrollment clips for a user. Merges with existing voiceprint if present (learn mode).
    POST with optional 'user_id' form field (defaults to 'owner')."""
    global user_voiceprints, user_cohort_stats

    user_id = request.form.get('user_id', 'owner')
    clips = enrollment_embeddings_by_user.get(user_id, [])

    if len(clips) < 1:
        return jsonify({"error": f"No enrollment clips for user '{user_id}'"}), 400

    existing = user_voiceprints.get(user_id)
    if existing is None and len(clips) < 3:
        return jsonify({"error": f"Need at least 3 clips for new enrollment, have {len(clips)}"}), 400

    normed = []
    for emb in clips:
        n = np.linalg.norm(emb)
        normed.append(emb / n if n > 0 else emb)
    new_embeds = np.stack(normed)

    if existing is not None:
        multi = np.concatenate([existing, new_embeds], axis=0)
        logger.info(f"Enroll [{user_id}] merged {len(normed)} new + {len(existing)} existing = {len(multi)} total")
    else:
        multi = new_embeds

    dest = os.path.join(VOICEPRINTS_DIR, f'{user_id}.npy')
    np.save(dest, multi)
    user_voiceprints[user_id] = multi
    user_cohort_stats[user_id] = compute_cohort_stats(multi)
    clip_count = len(clips)
    enrollment_embeddings_by_user[user_id] = []

    logger.info(f"Voiceprint saved: user={user_id} path={dest} total_refs={len(multi)}")
    return jsonify({
        "saved": True,
        "user_id": user_id,
        "path": dest,
        "clips_saved": clip_count,
        "total_references": len(multi),
        "embedding_dim": int(multi.shape[1]),
    })


@app.route('/enroll/reset', methods=['POST'])
def enroll_reset():
    """Reset enrollment accumulator for a user without saving.
    POST with optional 'user_id' form field (defaults to 'owner', or '*' to reset all)."""
    user_id = request.form.get('user_id', 'owner')
    if user_id == '*':
        total = sum(len(c) for c in enrollment_embeddings_by_user.values()) + len(enrollment_embeddings)
        enrollment_embeddings_by_user.clear()
        enrollment_embeddings.clear()
        return jsonify({"reset": True, "clips_discarded": total})
    clips = enrollment_embeddings_by_user.pop(user_id, [])
    return jsonify({"reset": True, "user_id": user_id, "clips_discarded": len(clips)})


@app.route('/voiceprint/<user_id>', methods=['DELETE'])
def delete_voiceprint(user_id):
    """Remove a user's voiceprint from memory and disk."""
    global user_voiceprints, user_cohort_stats
    was_enrolled = user_id in user_voiceprints
    user_voiceprints.pop(user_id, None)
    user_cohort_stats.pop(user_id, None)
    enrollment_embeddings_by_user.pop(user_id, None)
    fp = os.path.join(VOICEPRINTS_DIR, f'{user_id}.npy')
    if os.path.exists(fp):
        os.remove(fp)
    logger.info(f"[delete] voiceprint removed for {user_id} (was_enrolled={was_enrolled})")
    return jsonify({"ok": True, "user_id": user_id, "was_enrolled": was_enrolled})


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
                # Make sure owner label is in clusters for participant tracking
                _owner_label = os.environ.get('DIARIZATION_OWNER_LABEL', 'Owner')
                if not any(c['label'] == _owner_label for c in diarize_state['clusters']):
                    diarize_state['clusters'].append({
                        'label': _owner_label,
                        'centroid': embedding.copy(),
                        'count': 1,
                        'rms_sum': rms_db,
                        'rms_count': 1,
                    })
                else:
                    for c in diarize_state['clusters']:
                        if c['label'] == _owner_label:
                            c['centroid'] = (c['centroid'] * c['count'] + embedding) / (c['count'] + 1)
                            c['count'] += 1
                            c['rms_sum'] = c.get('rms_sum', 0) + rms_db
                            c['rms_count'] = c.get('rms_count', 0) + 1
                            break
                logger.info(f"Diarize: {_owner_label} (raw={raw_score:.3f} norm={norm_score:.3f} dB={rms_db})")
                return jsonify({"speaker": _owner_label, "confidence": round(raw_score, 4), "is_owner": True, "rms_db": rms_db})
        elif owner_voiceprint is not None:
            raw_score = cosine_similarity(embedding, owner_voiceprint)
            if raw_score >= SPEAKER_THRESHOLD:
                _owner_label = os.environ.get('DIARIZATION_OWNER_LABEL', 'Owner')
                logger.info(f"Diarize: {_owner_label} (raw={raw_score:.3f} dB={rms_db})")
                return jsonify({"speaker": _owner_label, "confidence": round(raw_score, 4), "is_owner": True, "rms_db": rms_db})

        # Cluster matching for non-owner voices
        best_sim = -1.0
        best_cluster = None
        _owner_label = os.environ.get('DIARIZATION_OWNER_LABEL', 'Owner')
        for cluster in diarize_state['clusters']:
            if cluster['label'] == _owner_label:
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
