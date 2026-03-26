/**
 * Text-to-Speech Module
 * 
 * Edge TTS only (free, Australian William voice).
 * No OpenAI TTS fallback — if Edge is down, degrade to text-only.
 * 
 * Circuit breaker: after 3 failures in 5 minutes, stops attempting
 * TTS and returns null (caller posts to text channel instead).
 * Auto-retries after 5 minute cooldown.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';
import { formatNumbersForSpeech } from './number-formatter.js';
import logger from './logger.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, '..', 'tmp');
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

const STREAMING_TTS_ENABLED = process.env.STREAMING_TTS_ENABLED !== 'false'; // Default true

// Find edge-tts binary
const EDGE_TTS_BIN = process.env.EDGE_TTS_PATH || `${process.env.HOME}/.local/bin/edge-tts`;

// ── TTS Provider ─────────────────────────────────────────────────────
// TTS_PROVIDER controls which engine is used: 'edge' | 'piper' | 'openai' | 'chatterbox'
// Read dynamically so runtime .env changes take effect on restart.
const getTTSProvider = () => (process.env.TTS_PROVIDER || 'piper').toLowerCase();

// ── Piper TTS (JARVIS voice) ─────────────────────────────────────────
// Local JARVIS voice via Piper. Only used when TTS_PROVIDER=piper.
// PIPER_ENABLED is kept for backward compat but TTS_PROVIDER takes precedence.
const isPiperEnabled = () => getTTSProvider() === 'piper' && process.env.PIPER_ENABLED !== 'false';
const PIPER_URL = process.env.PIPER_URL || 'http://127.0.0.1:3336';
const PIPER_MODEL = process.env.PIPER_MODEL || 'medium'; // medium (~1.5s) or high (~3.5s)

// ── Chatterbox TTS ────────────────────────────────────────────────────
// Multi-voice Chatterbox TTS service. Only used when TTS_PROVIDER=chatterbox.
// CHATTERBOX_VOICE selects the startup voice (jarvis | custom). Default: jarvis.
// _activeChatterboxVoice is the runtime-mutable voice — updated by switchChatterboxVoice().
const CHATTERBOX_URL   = process.env.CHATTERBOX_URL   || 'http://127.0.0.1:3340';
const CHATTERBOX_VOICE = process.env.CHATTERBOX_VOICE || 'jarvis';
let _activeChatterboxVoice = CHATTERBOX_VOICE; // mutable — persona switches update this

// ── Kokoro TTS ────────────────────────────────────────────────────────
// OpenAI-compatible TTS service — 114-155ms/sentence. Only used when TTS_PROVIDER=kokoro.
// British male voices: bm_lewis (default), bm_daniel, bm_george.
const KOKORO_URL   = process.env.KOKORO_URL   || 'http://localhost:8880';
const KOKORO_VOICE = process.env.KOKORO_VOICE || 'bm_lewis';

// ── Qwen3 TTS ─────────────────────────────────────────────────────────
// Qwen3-TTS VoiceDesign — describe the voice you want via instruct text.
// Only used when TTS_PROVIDER=qwen3.
const QWEN3_URL      = process.env.QWEN3_TTS_URL      || 'http://127.0.0.1:3341';
const QWEN3_INSTRUCT = process.env.QWEN3_TTS_VOICE    || '';  // empty = use server default
const QWEN3_LANG     = process.env.QWEN3_TTS_LANG     || 'english';

// ── TTS Circuit Breaker ──────────────────────────────────────────────
// After 3 Edge TTS failures within 5 minutes, stop trying for 5 minutes.
// Returns null so callers degrade to text-only delivery.
const TTS_CIRCUIT_BREAKER = {
  failures: [],                          // timestamps of recent failures
  threshold: 3,                          // failures to trip
  windowMs: 5 * 60 * 1000,              // 5-minute rolling window
  cooldownMs: 5 * 60 * 1000,            // 5-minute cooldown before retrying
  tripped: false,
  trippedAt: null,
  
  recordFailure() {
    const now = Date.now();
    this.failures.push(now);
    // Prune failures outside the window
    this.failures = this.failures.filter(t => now - t < this.windowMs);
    if (this.failures.length >= this.threshold && !this.tripped) {
      this.tripped = true;
      this.trippedAt = now;
      logger.info(`⚡ TTS circuit breaker OPEN — Edge TTS down (${this.threshold} failures in ${this.windowMs / 1000}s). Text-only mode for ${this.cooldownMs / 1000}s.`);
    }
  },
  
  recordSuccess() {
    // Single success after recovery resets everything
    if (this.tripped) {
      logger.info('🟢 TTS circuit breaker CLOSED — Edge TTS recovered');
    }
    this.tripped = false;
    this.trippedAt = null;
    this.failures = [];
  },
  
  isOpen() {
    if (!this.tripped) return false;
    // Check if cooldown has elapsed — allow a probe
    if (Date.now() - this.trippedAt > this.cooldownMs) {
      logger.info('🟡 TTS circuit breaker cooldown elapsed — probing Edge TTS');
      this.tripped = false;
      this.trippedAt = null;
      return false;
    }
    return true;
  },
  
  getStatus() {
    if (this.tripped) {
      const remaining = Math.round((this.cooldownMs - (Date.now() - this.trippedAt)) / 1000);
      return `down (circuit breaker open, ${remaining}s until retry)`;
    }
    if (this.failures.length > 0) {
      return `degraded (${this.failures.length}/${this.threshold} failures)`;
    }
    return 'edge';
  },
};

/**
 * Get current TTS health status for monitoring
 */
export function getTTSHealth() {
  const provider = getTTSProvider();
  const edge = TTS_CIRCUIT_BREAKER.getStatus();
  if (provider === 'qwen3') {
    return `qwen3-tts @ ${QWEN3_URL} (fallback: none — text-only on failure)`;
  }
  if (provider === 'kokoro') {
    const voice = process.env.KOKORO_VOICE || 'bm_lewis';
    return `kokoro-${voice} @ ${KOKORO_URL} (fallback: none — text-only on failure)`;
  }
  if (provider === 'chatterbox') {
    const voice = process.env.CHATTERBOX_VOICE || 'jarvis';
    return `chatterbox-${voice} (fallback: none — text-only on failure)`;
  }
  if (provider === 'piper' && process.env.PIPER_ENABLED !== 'false') {
    return `piper-jarvis (fallback: ${edge})`;
  }
  return `edge:${process.env.EDGE_TTS_VOICE || 'en-AU-WilliamNeural'} (${edge})`;
}

/**
 * Check if TTS is currently available (circuit breaker closed)
 */
export function isTTSAvailable() {
  return !TTS_CIRCUIT_BREAKER.isOpen();
}

/**
 * Sanitize text input for TTS to avoid crashes
 * @param {string} text - Raw text input
 * @returns {string|null} Sanitized text, or null if text is invalid/empty
 */
function sanitizeTextForTTS(text) {
  if (!text || typeof text !== 'string') return null;
  
  // Strip control characters, zero-width chars, and other problematic Unicode
  let cleaned = text
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Control chars
    .replace(/[\u200B-\u200D\uFEFF]/g, '')         // Zero-width chars
    .replace(/[\u00AD]/g, '')                       // Soft hyphens
    .trim();
  
  // If text is ONLY punctuation marks (e.g., just "?", "!", "..."), return null
  const textWithoutPunctuation = cleaned.replace(/[.,!?;:\-—…'"]/g, '').trim();
  if (textWithoutPunctuation.length === 0) {
    logger.info('⏭️  Text is only punctuation, skipping TTS synthesis');
    return null;
  }
  
  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ');

  // Format numbers for natural speech (years, dates, times, percentages)
  cleaned = formatNumbersForSpeech(cleaned);

  return cleaned;
}

/**
 * Synthesize text to speech and save to a file.
 * Returns null if Edge TTS fails or circuit breaker is open —
 * caller should degrade to text-only delivery.
 * 
 * @param {string} text - Text to speak
 * @returns {Promise<string|null>} Path to audio file, or null if TTS unavailable
 */
export async function synthesizeSpeech(text) {
  // Sanitize input
  const sanitized = sanitizeTextForTTS(text);
  if (!sanitized) {
    logger.info('⏭️  Empty/invalid text after sanitization, skipping synthesis');
    return null;
  }
  
  // Circuit breaker check — if open, skip TTS entirely
  if (TTS_CIRCUIT_BREAKER.isOpen()) {
    logger.info('⏭️  TTS circuit breaker open — skipping synthesis (text-only mode)');
    return null;
  }
  
  const provider = getTTSProvider();
  logger.info(`🔊 TTS provider: ${provider}`);

  // Qwen3-TTS (voice design) — only when TTS_PROVIDER=qwen3
  if (provider === 'qwen3') {
    const result = await synthesizeQwen3(sanitized);
    if (result) return result;
    logger.warn('Qwen3 TTS failed, retrying once in 500ms...');
    await new Promise(r => setTimeout(r, 500));
    const retryResult = await synthesizeQwen3(sanitized);
    if (retryResult) return retryResult;
    logger.warn('Qwen3 TTS unavailable after retry — text-only mode');
    return null;
  }

  // Kokoro (British male voice) — only when TTS_PROVIDER=kokoro
  if (provider === 'kokoro') {
    const result = await synthesizeKokoro(sanitized);
    if (result) return result;
    logger.warn('Kokoro TTS failed, retrying once in 500ms...');
    await new Promise(r => setTimeout(r, 500));
    const retryResult = await synthesizeKokoro(sanitized);
    if (retryResult) return retryResult;
    logger.warn('Kokoro TTS unavailable after retry — text-only mode');
    return null;
  }

  // Chatterbox TTS (voice clone) — only when TTS_PROVIDER=chatterbox
  if (provider === 'chatterbox') {
    const result = await synthesizeChatterbox(sanitized);
    if (result) return result;
    logger.warn('⚠️ Chatterbox TTS failed, retrying once in 500ms...');
    await new Promise(r => setTimeout(r, 500));
    const retryResult = await synthesizeChatterbox(sanitized);
    if (retryResult) return retryResult;
    logger.warn('⚠️ Chatterbox TTS unavailable after retry — text-only mode');
    return null;
  }

  // Piper (JARVIS voice clone) — only when TTS_PROVIDER=piper
  if (provider === 'piper' && process.env.PIPER_ENABLED !== 'false') {
    const piperResult = await synthesizePiper(sanitized);
    if (piperResult) return piperResult;
    logger.warn('⚠️ Piper TTS failed, retrying once in 500ms...');
    await new Promise(r => setTimeout(r, 500));
    const retryResult = await synthesizePiper(sanitized);
    if (retryResult) return retryResult;
    logger.warn('⚠️ Piper TTS unavailable after retry — text-only mode (no voice switch)');
    return null;
  }

  // Edge TTS — default when TTS_PROVIDER=edge (or anything other than piper/chatterbox)
  return synthesizeEdge(sanitized);
}

/**
 * Synthesize via Qwen3-TTS VoiceDesign.
 * ~20s per sentence on 4090 — slower than Kokoro but much richer voice quality.
 *
 * @param {string} text - Sanitized text to speak
 * @returns {Promise<string|null>} Path to WAV file, or null if unavailable
 */
async function synthesizeQwen3(text) {
  try {
    const start = Date.now();
    const body = { text, language: QWEN3_LANG };
    if (QWEN3_INSTRUCT) body.instruct = QWEN3_INSTRUCT;

    const res = await fetch(`${QWEN3_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000), // 2 min — model inference is slow
    });

    if (!res.ok) {
      logger.warn(`Qwen3 TTS returned ${res.status}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const outputPath = join(TMP_DIR, `qwen3_${Date.now()}.wav`);
    const { writeFile } = await import('fs/promises');
    await writeFile(outputPath, buffer);

    const latency = res.headers.get('X-Qwen3-Latency-Ms') || '?';
    const duration = res.headers.get('X-Qwen3-Duration-S') || '?';
    logger.info(`🐉 Qwen3 TTS: ${latency}ms → ${duration}s audio`);
    return outputPath;
  } catch (err) {
    logger.warn(`Qwen3 TTS unavailable: ${err.message}`);
    return null;
  }
}

/**
 * Synthesize via Kokoro TTS (OpenAI-compatible, British male voice).
 * ~114-155ms per sentence — effectively real-time.
 *
 * @param {string} text - Sanitized text to speak
 * @returns {Promise<string|null>} Path to WAV file, or null if unavailable
 */
async function synthesizeKokoro(text) {
  try {
    const start = Date.now();
    const res = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'kokoro', voice: KOKORO_VOICE, input: text, response_format: 'wav' }),
      signal: AbortSignal.timeout(10000), // 10s — should be <200ms in practice
    });

    if (!res.ok) {
      logger.warn(`Kokoro TTS returned ${res.status}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const outputPath = join(TMP_DIR, `kokoro_${Date.now()}.wav`);
    const { writeFile } = await import('fs/promises');
    await writeFile(outputPath, buffer);

    logger.info(`Kokoro TTS: ${Date.now() - start}ms (${KOKORO_VOICE})`);
    return outputPath;
  } catch (err) {
    logger.warn(`Kokoro TTS unavailable: ${err.message}`);
    return null;
  }
}

/**
 * Synthesize via Kokoro TTS with streaming response.
 * Collects the full WAV in chunks and calls onFile once complete.
 * Kokoro is fast enough that chunked playback adds latency rather than reducing it,
 * so this just streams the HTTP body and writes a single file per call.
 *
 * @param {string} text - Sanitized text to speak
 * @param {function(string): void} onFile - Callback invoked with WAV path when ready
 * @returns {Promise<void>}
 */
export async function synthesizeKokoroStream(text, onFile) {
  try {
    const start = Date.now();
    const res = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'kokoro', voice: KOKORO_VOICE, input: text, response_format: 'wav', stream: true }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      logger.warn(`Kokoro stream returned ${res.status}`);
      return;
    }

    const chunks = [];
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const buffer = Buffer.concat(chunks.map(c => Buffer.from(c)));
    const outputPath = join(TMP_DIR, `kokoro_stream_${Date.now()}.wav`);
    const { writeFile } = await import('fs/promises');
    await writeFile(outputPath, buffer);

    logger.info(`Kokoro stream: ${Date.now() - start}ms`);
    onFile(outputPath);
  } catch (err) {
    logger.warn(`Kokoro stream unavailable: ${err.message}`);
  }
}

/**
 * Synthesize via Chatterbox streaming TTS endpoint.
 * Returns an async generator that yields WAV file paths as each sentence completes.
 * The server splits text into sentences, generates sequentially, and streams NDJSON.
 *
 * @param {string} text - Sanitized full text to speak
 * @param {function(string): void} onFile - Callback invoked with each WAV path as it arrives
 * @returns {Promise<void>}
 */
export async function synthesizeChatterboxStream(text, onFile) {
  try {
    const res = await fetch(`${CHATTERBOX_URL}/tts/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: _activeChatterboxVoice }),
      signal: AbortSignal.timeout(120000), // 2 min total for long responses
    });

    if (!res.ok) {
      logger.warn(`⚠️ Chatterbox stream returned ${res.status}`);
      return;
    }

    const { writeFile } = await import('fs/promises');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete NDJSON lines
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.error) {
            logger.warn(`⚠️ Chatterbox stream error on sentence ${parsed.index}: ${parsed.error}`);
            continue;
          }
          if (!parsed.audio_b64) continue;

          const audioBuffer = Buffer.from(parsed.audio_b64, 'base64');
          const outputPath = join(TMP_DIR, `chatterbox_stream_${Date.now()}_${parsed.index}.wav`);
          await writeFile(outputPath, audioBuffer);
          logger.info(`🎭 Chatterbox stream sentence ${parsed.index}: ${parsed.latency_ms}ms`);
          onFile(outputPath);
        } catch (parseErr) {
          logger.warn(`⚠️ Chatterbox stream parse error: ${parseErr.message}`);
        }
      }
    }

    // Process any remaining buffer content
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        if (parsed.audio_b64) {
          const { writeFile } = await import('fs/promises');
          const audioBuffer = Buffer.from(parsed.audio_b64, 'base64');
          const outputPath = join(TMP_DIR, `chatterbox_stream_${Date.now()}_${parsed.index}.wav`);
          await writeFile(outputPath, audioBuffer);
          onFile(outputPath);
        }
      } catch {}
    }
  } catch (err) {
    logger.warn(`⚠️ Chatterbox stream unavailable: ${err.message}`);
  }
}

/**
 * Synthesize via Chatterbox TTS (voice clone)
 * @param {string} text - Sanitized text to speak
 * @returns {Promise<string|null>} Path to WAV file, or null if unavailable
 */
async function synthesizeChatterbox(text) {
  try {
    const res = await fetch(`${CHATTERBOX_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: _activeChatterboxVoice }),
      signal: AbortSignal.timeout(60000), // 60s — model inference takes time
    });

    if (!res.ok) {
      logger.warn(`⚠️ Chatterbox TTS returned ${res.status}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const outputPath = join(TMP_DIR, `chatterbox_${Date.now()}.wav`);
    const { writeFile } = await import('fs/promises');
    await writeFile(outputPath, buffer);

    const latency = res.headers.get('X-Chatterbox-Latency-Ms') || '?';
    logger.info(`🎭 Chatterbox TTS: ${latency}ms`);
    return outputPath;
  } catch (err) {
    logger.warn(`⚠️ Chatterbox TTS unavailable: ${err.message}`);
    return null;
  }
}

/**
 * Synthesize via local Piper TTS server (JARVIS voice)
 * @param {string} text - Sanitized text to speak
 * @returns {Promise<string|null>} Path to WAV file, or null if Piper unavailable
 */
async function synthesizePiper(text) {
  try {
    const res = await fetch(`${PIPER_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model: PIPER_MODEL }),
      signal: AbortSignal.timeout(30000), // 30s timeout for high model
    });
    
    if (!res.ok) {
      logger.warn(`⚠️ Piper TTS returned ${res.status}, falling back to Edge`);
      return null;
    }
    
    const buffer = Buffer.from(await res.arrayBuffer());
    const outputPath = join(TMP_DIR, `piper_${Date.now()}.wav`);
    const { writeFile } = await import('fs/promises');
    await writeFile(outputPath, buffer);
    
    const latency = res.headers.get('X-Piper-Latency-Ms') || '?';
    logger.info(`🎭 Piper JARVIS TTS: ${latency}ms`);
    return outputPath;
  } catch (err) {
    logger.warn(`⚠️ Piper TTS unavailable: ${err.message}, falling back to Edge`);
    return null;
  }
}

/**
 * Synthesize text to speech as a streaming Readable.
 * Returns null if Edge TTS fails or circuit breaker is open.
 * 
 * @param {string} text - Text to speak
 * @returns {Promise<Readable|null>} Readable stream of MP3 audio, or null
 */
export async function synthesizeSpeechStream(text) {
  // Sanitize input
  const sanitized = sanitizeTextForTTS(text);
  if (!sanitized) {
    logger.info('⏭️  Empty/invalid text after sanitization, skipping synthesis');
    return null;
  }
  
  // Circuit breaker check
  if (TTS_CIRCUIT_BREAKER.isOpen()) {
    logger.info('⏭️  TTS circuit breaker open — skipping stream synthesis (text-only mode)');
    return null;
  }
  
  try {
    return await synthesizeEdgeStream(sanitized);
  } catch (err) {
    logger.error(`❌ Edge TTS stream failed: ${err.message}`);
    TTS_CIRCUIT_BREAKER.recordFailure();
    return null;
  }
}

async function synthesizeEdge(text) {
  const outputPath = join(TMP_DIR, `tts_${Date.now()}.mp3`);
  const voice = process.env.EDGE_TTS_VOICE || 'en-AU-WilliamNeural';
  
  try {
    await execFileAsync(EDGE_TTS_BIN, [
      '--voice', voice,
      '--text', text,
      '--write-media', outputPath,
    ], { timeout: 15000 });
    
    TTS_CIRCUIT_BREAKER.recordSuccess();
    return outputPath;
  } catch (err) {
    logger.error(`❌ Edge TTS failed: ${err.message}`);
    TTS_CIRCUIT_BREAKER.recordFailure();
    return null;
  }
}

function synthesizeEdgeStream(text) {
  return new Promise((resolve, reject) => {
    const voice = process.env.EDGE_TTS_VOICE || 'en-AU-WilliamNeural';
    
    // Spawn edge-tts with stdout output
    const proc = spawn(EDGE_TTS_BIN, [
      '--voice', voice,
      '--text', text,
      '--write-media', '-', // Write to stdout
    ]);
    
    // Edge TTS may write some text to stderr before audio starts
    proc.stderr.on('data', (chunk) => {
      // Ignore stderr noise
    });
    
    let started = false;
    const stream = new Readable({
      read() {}
    });
    
    // Timeout fallback — stored so we can clear on success
    const timeoutId = setTimeout(() => {
      if (!started) {
        proc.kill('SIGKILL');
        TTS_CIRCUIT_BREAKER.recordFailure();
        reject(new Error('Edge TTS stream timeout'));
      }
    }, 5000);
    
    proc.stdout.on('data', (chunk) => {
      if (!started) {
        started = true;
        clearTimeout(timeoutId);
        TTS_CIRCUIT_BREAKER.recordSuccess();
        resolve(stream);
      }
      stream.push(chunk);
    });
    
    proc.stdout.on('end', () => {
      stream.push(null);
    });
    
    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      TTS_CIRCUIT_BREAKER.recordFailure();
      if (!started) {
        reject(new Error(`Edge TTS stream failed: ${err.message}`));
      }
    });
    
    proc.on('exit', (code) => {
      clearTimeout(timeoutId);
      if (!started && code !== 0) {
        TTS_CIRCUIT_BREAKER.recordFailure();
        reject(new Error(`Edge TTS exited with code ${code}`));
      }
    });
  });
}

/**
 * Split text into chunks for streaming TTS.
 * Batches multiple sentences together (target ~80-150 chars per chunk)
 * so Piper has enough phonetic context for smooth, consistent output.
 * Short fragments sound garbled; longer chunks sound natural.
 * 
 * @param {string} text - Text to split
 * @returns {string[]} Array of sentence batches
 */
export function splitIntoSentences(text) {
  // Protect known abbreviations so their periods don't trigger false sentence splits.
  // e.g. "Mr. Smith", "U.S. markets", "Dr. Biden", "Gov. Newsom"
  const PLACEHOLDER = '\x00'; // null byte — safe sentinel not present in normal text

  const ABBREV_PATTERNS = [
    // Titles and honorifics
    /\b(Mr|Mrs|Ms|Miss|Dr|Prof|Gov|Sen|Rep|Gen|Col|Lt|Sgt|Cpl|Pvt|Sr|Jr|Rev|Capt|Cmdr|Adm|Atty|Supt|Det|Insp)\./gi,
    // Common abbreviations
    /\b(vs|etc|approx|est|dept|corp|inc|llc|vol|pp|ed|fig|ave|blvd|rd)\./gi,
    // Month abbreviations
    /\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\./gi,
    // Single/double capital initials mid-abbreviation: U.S., U.K., D.C.
    /\b([A-Z])\.(?=[A-Z]\.|[a-z]|\s[A-Z][a-z])/g,
  ];

  let protected_text = text;
  for (const pattern of ABBREV_PATTERNS) {
    protected_text = protected_text.replace(pattern, (m) => m.replace(/\./g, PLACEHOLDER));
  }

  // Split on . ! ? followed by space or end of string
  // Keep the punctuation with the sentence
  const sentences = protected_text
    .split(/([.!?]+\s+|[.!?]+$)/g)
    .filter(s => s.trim().length > 0);
  
  // Recombine sentence with its punctuation, restore protected periods
  const individual = [];
  for (let i = 0; i < sentences.length; i += 2) {
    const sentence = sentences[i].trim().replace(/\x00/g, '.');
    const punct = (sentences[i + 1] || '').replace(/\x00/g, '.');
    if (sentence) {
      individual.push(sentence + punct);
    }
  }
  
  // Batch sentences into chunks — fast providers (Chatterbox, Kokoro) benefit from larger chunks
  // for better prosody. Piper/edge: smaller chunks → faster first-audio.
  const _provider = (process.env.TTS_PROVIDER || 'piper').toLowerCase();
  const _isFastProvider = _provider === 'chatterbox' || _provider === 'kokoro';
  const MIN_CHUNK = _isFastProvider ? 120 : 60;
  const MAX_CHUNK = _isFastProvider ? 450 : 300;
  const result = [];
  let current = '';
  
  for (const sent of individual) {
    const candidate = current ? current + ' ' + sent : sent;
    if (candidate.length > MAX_CHUNK && current.length >= MIN_CHUNK) {
      // Current chunk is big enough, push it and start new
      result.push(current.trim());
      current = sent;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) {
    result.push(current.trim());
  }
  
  return result.filter(s => s.length > 0);
}

/**
 * Switch the active Chatterbox voice.
 * Calls POST /voice/switch on the Chatterbox service, which:
 *   1. Unloads the prior voice's conditionals from GPU
 *   2. Runs torch.cuda.empty_cache() to return VRAM to the pool
 *   3. Pre-warms conditionals for the new voice
 *
 * No-op if TTS_PROVIDER !== 'chatterbox'.
 */
export async function switchChatterboxVoice(voice, { throwOnFail = false } = {}) {
  if ((process.env.TTS_PROVIDER || 'piper').toLowerCase() !== 'chatterbox') return;
  if (!voice) return;
  const prev = _activeChatterboxVoice;
  _activeChatterboxVoice = voice;
  logger.info(`[chatterbox] active voice: ${prev} → ${voice} (next TTS request will use ${voice})`);
  // Also pre-warm the voice on the server side so first response isn't slow
  try {
    const res = await fetch(`${CHATTERBOX_URL}/voice/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      logger.info(`[chatterbox] pre-warmed voice: ${JSON.stringify(data)}`);
    } else {
      const msg = `pre-warm failed (${res.status}): ${JSON.stringify(data)}`;
      if (throwOnFail) {
        _activeChatterboxVoice = prev; // revert local state too
        throw new Error(msg);
      }
      logger.warn(`[chatterbox] ${msg} — will still use ${voice} per-request`);
    }
  } catch (e) {
    if (throwOnFail) {
      _activeChatterboxVoice = prev; // revert local state
      throw e;
    }
    logger.warn(`[chatterbox] pre-warm error: ${e.message} — will still use ${voice} per-request`);
  }
}

export { STREAMING_TTS_ENABLED };
