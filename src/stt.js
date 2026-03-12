/**
 * Speech-to-Text Module
 *
 * Supports multiple STT providers:
 * - Deepgram (streaming, real-time, faster, with sentiment analysis)
 * - Local Whisper CLI (batch, high accuracy, FREE - no API calls)
 */

import { createClient } from '@deepgram/sdk';
import { createReadStream } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import 'dotenv/config';

const execFileAsync = promisify(execFile);

const STT_PROVIDER = process.env.STT_PROVIDER || 'whisper'; // 'whisper' (local, free), 'deepgram', 'moonshine', or 'vosk'
const WHISPER_BIN = process.env.WHISPER_PATH || `${process.env.HOME}/.local/bin/whisper`;
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'tiny'; // tiny=fast (~3s), base/small=better accuracy
const _repoRoot = new URL('..', import.meta.url).pathname;
const VOSK_PYTHON = process.env.VOSK_PYTHON || `${process.env.HOME}/dev/jarvis-voice/venv/bin/python3`;
const VOSK_SCRIPT = `${VOSK_PYTHON} ${_repoRoot}src/vosk-stt.py`;
const MLX_WHISPER_URL = process.env.MLX_WHISPER_URL || 'http://localhost:8765/transcribe';

// Speaker Verification Service
const SPEAKER_VERIFY_URL = process.env.SPEAKER_VERIFY_URL || 'http://localhost:8767/verify';
const SPEAKER_VERIFY_ENABLED = process.env.SPEAKER_VERIFY_ENABLED !== 'false'; // default ON
const SPEAKER_VERIFY_STRICT = process.env.SPEAKER_VERIFY_STRICT === 'true'; // strict mode: block all voice if no voiceprint
const SPEAKER_VERIFY_TIMEOUT_MS = 3000; // 3s max for verification (graceful degradation)

// Confidence thresholds for Whisper hallucination filtering
const NO_SPEECH_PROB_THRESHOLD = parseFloat(process.env.NO_SPEECH_PROB_THRESHOLD || '0.6');
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.35'); // exp(avg_logprob)

// Only initialize Deepgram client if API key is present (disabled per 2026-02-19 directive)
const deepgram = process.env.DEEPGRAM_API_KEY ? createClient(process.env.DEEPGRAM_API_KEY) : null;

// ── STT Circuit Breaker ──────────────────────────────────────────────
// After 3 Deepgram failures within 5 minutes, auto-switch to Whisper for 5 minutes
const STT_CIRCUIT_BREAKER = {
  failures: [],                          // timestamps of recent primary STT failures
  threshold: 3,                          // failures to trip
  windowMs: 5 * 60 * 1000,              // 5-minute rolling window
  cooldownMs: 5 * 60 * 1000,            // 5-minute cooldown before retrying primary
  tripped: false,
  trippedAt: null,

  recordFailure() {
    const now = Date.now();
    this.failures.push(now);
    this.failures = this.failures.filter(t => now - t < this.windowMs);
    if (this.failures.length >= this.threshold && !this.tripped) {
      this.tripped = true;
      this.trippedAt = now;
      console.log(`⚡ STT provider: deepgram → whisper (${this.threshold} failures in ${this.windowMs / 1000}s)`);
    }
  },

  recordSuccess() {
    if (this.tripped) {
      console.log('🟢 STT provider: whisper → deepgram (recovered)');
      this.tripped = false;
      this.trippedAt = null;
      this.failures = [];
    }
  },

  shouldUseWhisper() {
    if (!this.tripped) return false;
    if (Date.now() - this.trippedAt > this.cooldownMs) {
      console.log('🟡 STT circuit breaker cooldown elapsed - probing deepgram');
      this.tripped = false;
      this.trippedAt = null;
      return false;
    }
    return true;
  },

  getStatus() {
    if (this.tripped) {
      const remaining = Math.round((this.cooldownMs - (Date.now() - this.trippedAt)) / 1000);
      return `whisper (circuit breaker, ${remaining}s remaining)`;
    }
    return STT_PROVIDER;
  },
};

/**
 * Get current STT health status for monitoring
 */
export function getSTTHealth() {
  return STT_CIRCUIT_BREAKER.getStatus();
}

/**
 * Verify if audio belongs to the enrolled owner via the speaker verification service.
 * Returns { is_owner, confidence, has_speech } or null if service unavailable.
 * Graceful degradation: returns null on any failure (caller should bypass verification).
 */
async function verifySpeaker(wavPath) {
  if (!SPEAKER_VERIFY_ENABLED) return null;

  try {
    const { default: fetch } = await import('node-fetch');
    const { createReadStream } = await import('fs');
    const FormData = (await import('form-data')).default;

    const form = new FormData();
    form.append('audio', createReadStream(wavPath));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SPEAKER_VERIFY_TIMEOUT_MS);

    const response = await fetch(SPEAKER_VERIFY_URL, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      // 400 = no voiceprint enrolled
      if (response.status === 400) {
        if (SPEAKER_VERIFY_STRICT) {
          // Strict mode: block all audio until voiceprint enrolled
          return { is_owner: false, has_speech: true, no_voiceprint: true, confidence: 0 };
        }
        // Soft mode: bypass verification, log once
        console.log('Speaker verify: no voiceprint enrolled, bypassing');
        return null;
      }
      throw new Error(`Speaker verify HTTP ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('Speaker verify timed out, bypassing');
    } else if (err.code === 'ECONNREFUSED') {
      // Service not running -- silent bypass
    } else {
      console.warn(`Speaker verify error: ${err.message}, bypassing`);
    }
    return null; // Graceful degradation
  }
}

/**
 * Identify speaker via online embedding clustering (diarization).
 * Used during record mode to label speakers in meetings.
 * Returns { speaker, confidence, is_owner } or null on failure.
 */
const SPEAKER_DIARIZE_URL = process.env.SPEAKER_DIARIZE_URL || 'http://localhost:8767/diarize';

export async function diarizeSpeaker(wavPath) {
  try {
    const { default: fetch } = await import('node-fetch');
    const { createReadStream } = await import('fs');
    const FormData = (await import('form-data')).default;

    const form = new FormData();
    form.append('audio', createReadStream(wavPath));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SPEAKER_VERIFY_TIMEOUT_MS);

    const response = await fetch(SPEAKER_DIARIZE_URL, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
      signal: controller.signal,
    });

    clearTimeout(timer);
    if (!response.ok) throw new Error(`Diarize HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('Diarize timed out, falling back');
    } else if (err.code !== 'ECONNREFUSED') {
      console.warn(`Diarize error: ${err.message}`);
    }
    return null;
  }
}

/**
 * Start/stop diarization session on the speaker verify service.
 */
export async function diarizeControl(action) {
  try {
    const { default: fetch } = await import('node-fetch');
    const url = `${SPEAKER_DIARIZE_URL}/${action}`;
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`Diarize ${action} failed: ${err.message}`);
    return null;
  }
}

/**
 * Check Whisper confidence scores to filter hallucinations.
 * Returns true if the transcription should be rejected.
 * @param {object} sttData - Whisper STT metadata (confidence, no_speech_prob)
 * @param {object} [speakerInfo] - Speaker verification result (is_owner, confidence_tier)
 */
function isLowConfidenceTranscript(sttData, speakerInfo = null) {
  if (!sttData) return false;

  // If speaker verification confirms owner (medium+ tier), relax the no_speech_prob
  // threshold. TV background noise inflates no_speech_prob even on real owner speech.
  // Speaker verify IS a speech detector — if it says owner, the speech is real.
  const ownerVerified = speakerInfo?.is_owner && speakerInfo.confidence_tier !== 'low';
  const nspThreshold = ownerVerified ? 0.92 : NO_SPEECH_PROB_THRESHOLD;

  // High no_speech_prob means Whisper thinks there's no real speech
  if (sttData.no_speech_prob != null && sttData.no_speech_prob > nspThreshold) {
    console.log(`Confidence filter: no_speech_prob=${sttData.no_speech_prob} > ${nspThreshold}${ownerVerified ? ' (owner-relaxed)' : ''}`);
    return true;
  }

  // Low confidence (exp of avg_logprob) means Whisper is guessing
  if (sttData.confidence != null && sttData.confidence < CONFIDENCE_THRESHOLD) {
    console.log(`Confidence filter: confidence=${sttData.confidence} < ${CONFIDENCE_THRESHOLD}`);
    return true;
  }

  return false;
}

/**
 * Post-process transcript to correct domain-specific vocabulary
 * @param {string} text - Raw transcript text
 * @returns {string} Corrected transcript
 */
function postProcessTranscript(text) {
  let processed = text;

  // Technical terms
  processed = processed.replace(/\bsole file\b/gi, 'SOUL file');
  processed = processed.replace(/\bsole\.md\b/gi, 'SOUL.md');
  processed = processed.replace(/\bsole dot md\b/gi, 'SOUL.md');
  processed = processed.replace(/\bpound general\b/gi, '#general');
  processed = processed.replace(/\bhashtag general\b/gi, '#general');
  processed = processed.replace(/\bpound (\w+)/gi, '#$1');
  // Company-specific terms can be configured via env vars if needed
  processed = processed.replace(/\bhai ?ve ?mind\b/gi, 'haivemind');
  processed = processed.replace(/\bhive\s*mind\b/gi, 'haivemind');
  processed = processed.replace(/\bhigh\s*line\b/gi, 'haivemind');
  processed = processed.replace(/\bhigh\s*mind\b/gi, 'haivemind');
  processed = processed.replace(/\bhai\s*vemind\b/gi, 'haivemind');
  processed = processed.replace(/\bhive\s*line\b/gi, 'haivemind');
  processed = processed.replace(/\bhivemind\b/gi, 'haivemind');
  processed = processed.replace(/\bclawd ?bot\b/gi, 'Clawdbot');
  processed = processed.replace(/\bcloud bot\b/gi, 'Clawdbot');
  processed = processed.replace(/\bm c p\b/gi, 'MCP');
  processed = processed.replace(/\bdeep ?gram\b/gi, 'Deepgram');
  processed = processed.replace(/\brad ?air\b/gi, 'Radare2');
  processed = processed.replace(/\bradar (two|2)\b/gi, 'Radare2');
  processed = processed.replace(/\bvirus ?total\b/gi, 'VirusTotal');
  processed = processed.replace(/\bgit ?hub\b/gi, 'GitHub');

  // Voice command corrections (common Whisper mishearings)
  processed = processed.replace(/\b(you\s+)?can\s+roll\s+(my\s+)?voice/gi, 'enroll my voice');
  processed = processed.replace(/\bin\s+roll\s+(my\s+)?voice/gi, 'enroll my voice');
  processed = processed.replace(/\band\s+roll\s+(my\s+)?voice/gi, 'enroll my voice');

  // Name corrections — Whisper commonly mishears "Jarvis" as these
  processed = processed.replace(/\b(travis|garvis|jarvas|jarvus|jarves|jonas|journals?|jar\s*vis|jervis|jarv[ie]ce|djarvis|charges|dervis)\b/gi, 'Jarvis');
  // "Hey Jonas" / "Hey journals" → "Hey Jarvis"
  processed = processed.replace(/\bhey[,.]?\s+(jonas|journals?|jervis|charges)\b/gi, 'Hey Jarvis');

  // Context-aware corrections (common mishearings)
  processed = processed.replace(/\b(focus|focusing|look) on the tent\b/gi, '$1 on the channel');
  processed = processed.replace(/\bthe tent\b/gi, 'the channel');

  return processed;
}

/**
 * Transcribe using Moonshine (fast, local, CPU-friendly)
 */
async function transcribeWithMoonshine(wavPath) {
  try {
    const pythonCode = `
import json
import sys
from moonshine_voice import load

model = load('moonshine/medium-streaming', language='en')
result = model.transcribe('${wavPath}')
print(json.dumps({'text': result.get('text', '')}))
`;

    const { stdout, stderr } = await execFileAsync('python3', ['-c', pythonCode], {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const parsed = JSON.parse(stdout.trim());
    const transcript = parsed.text || '';

    if (!transcript) {
      throw new Error('Empty transcript from Moonshine');
    }

    console.log(`🌙 Moonshine: "${transcript.substring(0, 80)}..."`);
    return transcript;
  } catch (err) {
    console.error('Moonshine STT Error:', err.message);
    throw err;
  }
}

/**
 * Transcribe audio file using configured provider with automatic fallback
 * Uses circuit breaker: after 3 Deepgram failures in 5 min, auto-switches to Whisper
 * @param {string} wavPath - Path to WAV file
 * @returns {Promise<{ text: string, sentiment: object|null, segments: Array }>} Transcript result with sentiment
 */
// Lightweight transcribe — Whisper only, no speaker verify. Used by enrollment.
export async function transcribeWhisperOnly(wavPath) {
  try {
    const result = await transcribeWithFasterWhisper(wavPath);
    const text = typeof result === 'string' ? result : result.text;
    return postProcessTranscript(text || '');
  } catch {
    return '';
  }
}

export async function transcribeAudio(wavPath) {
  let result;
  
  // Moonshine (fast local STT, ~2-3s per transcription)
  if (STT_PROVIDER === 'moonshine') {
    try {
      const transcript = await transcribeWithMoonshine(wavPath);
      result = { text: postProcessTranscript(transcript), sentiment: null, segments: [] };
    } catch (err) {
      console.warn('⚠️  Moonshine failed, falling back to Whisper CLI:', err.message);
      try {
        const transcript = await transcribeWithWhisper(wavPath);
        result = { text: postProcessTranscript(transcript), sentiment: null, segments: [] };
      } catch (whisperErr) {
        console.error('❌ Both Moonshine and Whisper failed');
        throw new Error(`STT failed: Moonshine: ${err.message}, Whisper: ${whisperErr.message}`);
      }
    }
  }
  // MLX Whisper on Mac (highest accuracy — large-v3 on M4 Max)
  else if (STT_PROVIDER === 'mlx-whisper') {
    try {
      const transcript = await transcribeWithMLXWhisper(wavPath);
      result = { text: postProcessTranscript(transcript), sentiment: null, segments: [] };
    } catch (err) {
      console.warn('⚠️  MLX Whisper failed, falling back to local Faster Whisper:', err.message);
      try {
        const transcript = await transcribeWithFasterWhisper(wavPath);
        result = { text: postProcessTranscript(transcript), sentiment: null, segments: [] };
      } catch (fwErr) {
        console.error('❌ All STT providers failed');
        throw new Error(`STT failed: MLX: ${err.message}, FW: ${fwErr.message}`);
      }
    }
  }
  // Vosk as primary (fastest)
  else if (STT_PROVIDER === 'vosk') {
    try {
      const transcript = await transcribeWithVosk(wavPath);
      result = { text: postProcessTranscript(transcript), sentiment: null, segments: [] };
    } catch (err) {
      console.error('❌ Vosk STT failed:', err.message);
      throw new Error(`STT failed: ${err.message}`);
    }
  }
  // Faster Whisper (Local GPU - RTX 4090) with Speaker Verification Gate
  else if (STT_PROVIDER === 'faster-whisper') {
    // Stage 1+2: Speaker verification (Silero VAD + ECAPA-TDNN voiceprint)
    // Returns speaker info — session-based auth decisions happen in index.js
    const speakerResult = await verifySpeaker(wavPath);
    let needsEnrollment = false;
    let speakerInfo = null;
    if (speakerResult !== null) {
      if (speakerResult.no_voiceprint) {
        // Strict mode + no voiceprint = still transcribe but flag for enrollment-only gating
        needsEnrollment = true;
        // Fall through to Whisper so enrollment command can be detected
      } else if (!speakerResult.has_speech) {
        // Silero VAD says no speech at all -- skip transcription entirely
        return { text: '', sentiment: null, segments: [], rejected: 'no_speech' };
      } else {
        // Pass speaker info up -- index.js handles session-based auth decisions
        speakerInfo = {
          is_owner: speakerResult.is_owner,
          confidence: speakerResult.confidence,
          norm_score: speakerResult.norm_score ?? null,
          confidence_tier: speakerResult.confidence_tier ?? null,
        };
        const tier = speakerInfo.confidence_tier || '';
        if (speakerResult.is_owner) {
          console.log(`Speaker verified (confidence=${speakerResult.confidence} norm=${speakerInfo.norm_score} tier=${tier})`);
        } else {
          console.log(`Speaker rejected (confidence=${speakerResult.confidence} norm=${speakerInfo.norm_score} tier=${tier})`);
        }
      }
    }
    // speakerResult === null means service down/no voiceprint (soft mode) -- bypass verification

    // Stage 3: Faster Whisper transcription with confidence scores
    try {
      const fwResult = await transcribeWithFasterWhisper(wavPath);
      // fwResult is now { text, confidence, no_speech_prob, ... } when service returns metadata
      if (typeof fwResult === 'object' && fwResult.sttMeta) {
        // Check confidence scores to filter hallucinations
        if (isLowConfidenceTranscript(fwResult.sttMeta, speakerInfo)) {
          console.log(`Confidence filter rejected: "${fwResult.text?.substring(0, 40)}..."`);
          return { text: '', sentiment: null, segments: [], rejected: 'low_confidence' };
        }
        result = { text: postProcessTranscript(fwResult.text), sentiment: null, segments: [], needsEnrollment, speakerInfo };
      } else {
        // Legacy string result (fallback path)
        const transcript = typeof fwResult === 'string' ? fwResult : fwResult.text;
        result = { text: postProcessTranscript(transcript), sentiment: null, segments: [], needsEnrollment, speakerInfo };
      }
    } catch (err) {
      console.error('Faster Whisper STT failed:', err.message);
      // Fallback to basic Whisper CLI
      try {
        const transcript = await transcribeWithWhisper(wavPath);
        result = { text: postProcessTranscript(transcript), sentiment: null, segments: [], needsEnrollment, speakerInfo };
      } catch (whisperErr) {
        throw new Error(`STT failed: Faster: ${err.message}, Whisper: ${whisperErr.message}`);
      }
    }
  }
  // Whisper direct
  else if (STT_PROVIDER === 'whisper' || 
    (STT_PROVIDER === 'deepgram' && STT_CIRCUIT_BREAKER.shouldUseWhisper())) {
    try {
      const transcript = await transcribeWithWhisper(wavPath);
      result = { text: postProcessTranscript(transcript), sentiment: null, segments: [] };
    } catch (err) {
      console.error('❌ Whisper STT failed:', err.message);
      throw new Error(`STT failed: ${err.message}`);
    }
  }
  // Deepgram with Whisper fallback
  else {
    try {
      const dgResult = await transcribeWithDeepgram(wavPath);
      STT_CIRCUIT_BREAKER.recordSuccess();
      result = {
        text: postProcessTranscript(dgResult.transcript),
        sentiment: dgResult.sentiment,
        segments: dgResult.segments,
      };
    } catch (err) {
      console.warn('⚠️  Deepgram failed, falling back to Whisper:', err.message);
      STT_CIRCUIT_BREAKER.recordFailure();
      try {
        const transcript = await transcribeWithWhisper(wavPath);
        result = { text: postProcessTranscript(transcript), sentiment: null, segments: [] };
      } catch (whisperErr) {
        console.error('❌ Both STT providers failed:', whisperErr.message);
        throw new Error(`STT failed: Deepgram: ${err.message}, Whisper: ${whisperErr.message}`);
      }
    }
  }
  
  return result;
}

/**
 * Transcribe with Deepgram (faster, streaming-capable)
 * @returns {{ transcript: string, sentiment: object|null, segments: Array }}
 */
async function transcribeWithDeepgram(wavPath) {
  try {
    const audioStream = createReadStream(wavPath);

    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      audioStream,
      {
        model: 'nova-2',
        language: 'en',
        smart_format: true,
        punctuate: true,
        diarize: false,
        sentiment: true,
        keywords: ['Jarvis'],
      }
    );

    if (error) {
      throw error;
    }

    const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript;

    if (!transcript) {
      throw new Error('No transcript returned from Deepgram');
    }

    // Extract sentiment data from Deepgram response
    const sentiments = result.results?.sentiments || null;
    const sentiment = sentiments?.average || null;
    const segments = sentiments?.segments || [];

    return {
      transcript: transcript.trim(),
      sentiment,  // { sentiment: 'positive'|'negative'|'neutral', sentiment_score: float } or null
      segments,
    };
  } catch (err) {
    console.error('Deepgram STT Error:', err.message);
    throw err;
  }
}

/**
 * Transcribe with local Whisper CLI (fallback - FREE, no API calls)
 * Uses the whisper binary at WHISPER_BIN with configurable model size.
 */
async function transcribeWithWhisper(wavPath) {
  try {
    const outputDir = '/tmp';
    const baseName = wavPath.replace(/\.[^/.]+$/, '').split('/').pop();

    await execFileAsync(WHISPER_BIN, [
      wavPath,
      '--model', WHISPER_MODEL,
      '--language', 'en',
      '--output_format', 'txt',
      '--output_dir', outputDir,
    ], { timeout: 30000 }); // 30s timeout

    // Whisper writes output to /tmp/<basename>.txt
    const txtPath = `${outputDir}/${baseName}.txt`;
    if (!existsSync(txtPath)) {
      throw new Error(`Whisper output not found: ${txtPath}`);
    }

    const transcript = readFileSync(txtPath, 'utf-8').trim();
    try { unlinkSync(txtPath); } catch {} // Clean up

    if (!transcript) {
      throw new Error('Empty transcript from local Whisper');
    }

    return transcript;
  } catch (err) {
    console.error('Local Whisper STT Error:', err.message);
    throw err;
  }
}

/**
 * Transcribe with Vosk (fast local STT - ~100-300ms)
 * Uses vosk-stt.py wrapper script with Python Vosk bindings
 */
/**
 * Transcribe with MLX Whisper on Mac (highest accuracy — large-v3 model)
 * Sends audio to Mac STT server via HTTP
 */
async function transcribeWithMLXWhisper(wavPath) {
  try {
    const { default: fetch } = await import('node-fetch');
    const { createReadStream, statSync } = await import('fs');
    const FormData = (await import('form-data')).default;
    
    const form = new FormData();
    form.append('audio', createReadStream(wavPath));
    
    const response = await fetch(MLX_WHISPER_URL, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
      timeout: 30000,
    });
    
    if (!response.ok) {
      throw new Error(`MLX Whisper HTTP ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    const transcript = data.text?.trim() || data.transcript?.trim();
    if (!transcript) {
      throw new Error('Empty transcript from MLX Whisper');
    }
    
    console.log(`🎯 MLX Whisper: "${transcript.substring(0, 80)}..." (${(data.duration || 0).toFixed(1)}s audio)`);
    return transcript;
  } catch (err) {
    console.error('MLX Whisper error:', err.message);
    throw err;
  }
}

const LOCAL_WHISPER_URL = process.env.FASTER_WHISPER_URL || 'http://localhost:8766/transcribe';

/**
 * Transcribe with Faster Whisper using the persistent GPU service.
 * Connects to the Flask server running large-v3 on port 8766.
 * Returns { text, sttMeta } where sttMeta contains confidence scores.
 */
async function transcribeWithFasterWhisper(wavPath) {
  try {
    const { default: fetch } = await import('node-fetch');
    const { createReadStream } = await import('fs');
    const FormData = (await import('form-data')).default;

    const form = new FormData();
    form.append('audio', createReadStream(wavPath));

    const response = await fetch(LOCAL_WHISPER_URL, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
      timeout: 60000, // 60s timeout for long audio
    });

    if (!response.ok) {
      throw new Error(`STT Service HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const transcript = data.text?.trim();

    if (!transcript) {
      throw new Error('Empty transcript from STT service');
    }

    // Extract confidence metadata from enhanced Whisper service
    const sttMeta = {
      confidence: data.confidence ?? null,
      no_speech_prob: data.no_speech_prob ?? null,
      avg_logprob: data.avg_logprob ?? null,
      segment_count: data.segment_count ?? null,
    };

    const confStr = sttMeta.confidence != null ? ` conf=${sttMeta.confidence}` : '';
    const nspStr = sttMeta.no_speech_prob != null ? ` nsp=${sttMeta.no_speech_prob}` : '';
    console.log(`Faster Whisper: "${transcript.substring(0, 80)}..."${confStr}${nspStr}`);

    return { text: transcript, sttMeta };
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error('Faster Whisper service not running (ECONNREFUSED) -- falling back to local Whisper');
    } else {
      console.error('Faster Whisper service error:', err.message);
    }
    throw err;
  }
}

async function transcribeWithVosk(wavPath) {
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', `${VOSK_SCRIPT} ${wavPath}`], { timeout: 10000 });

    if (stderr) {
      console.warn('Vosk stderr:', stderr);
    }

    const transcript = stdout.trim();
    if (!transcript) {
      throw new Error('Empty transcript from Vosk');
    }

    return transcript;
  } catch (err) {
    console.error('Vosk transcription error:', err.message);
    throw err;
  }
}

/**
 * Health check for the configured STT provider.
 * External providers (deepgram, openai) are skipped — they're always assumed reachable.
 * Local providers (faster-whisper, whisper-server, mlx-whisper, vosk) get a GET /health probe.
 * Does not exit on failure — allows graceful degradation.
 */
export async function checkSttHealth() {
  const provider = process.env.STT_PROVIDER ?? 'faster-whisper';
  const url = process.env.STT_URL ?? process.env.WHISPER_URL ?? process.env.MLX_WHISPER_URL;

  if (!url || provider.includes('deepgram') || provider.includes('openai')) {
    console.log(`[stt] Provider ${provider} — skipping health check (external or no URL configured)`);
    return;
  }

  const baseUrl = url.replace(/\/transcribe$/, '').replace(/\/$/, '');
  try {
    const res = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`[stt] Provider ${provider} healthy at ${baseUrl}`);
  } catch (err) {
    console.error(`[stt] WARNING: Provider ${provider} unreachable at ${baseUrl}: ${err.message}`);
    console.error('[stt] Bot will start but speech recognition will fail until STT is available');
  }
}
