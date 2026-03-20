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

// ── Chatterbox TTS (Lance voice clone) ───────────────────────────────
// Lance's cloned voice via Chatterbox TTS. Only used when TTS_PROVIDER=chatterbox.
// Runs as a local FastAPI service at CHATTERBOX_URL.
const CHATTERBOX_URL = process.env.CHATTERBOX_URL || 'http://127.0.0.1:3340';

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
  if (provider === 'chatterbox') {
    return `chatterbox-lance (fallback: none — text-only on failure)`;
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

  // Chatterbox (Lance voice clone) — only when TTS_PROVIDER=chatterbox
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
 * Synthesize via Chatterbox TTS (Lance voice clone)
 * @param {string} text - Sanitized text to speak
 * @returns {Promise<string|null>} Path to WAV file, or null if unavailable
 */
async function synthesizeChatterbox(text) {
  try {
    const res = await fetch(`${CHATTERBOX_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
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
    logger.info(`🎭 Chatterbox Lance TTS: ${latency}ms`);
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
  // Split on . ! ? followed by space or end of string
  // Keep the punctuation with the sentence
  const sentences = text
    .split(/([.!?]+\s+|[.!?]+$)/g)
    .filter(s => s.trim().length > 0);
  
  // Recombine sentence with its punctuation
  const individual = [];
  for (let i = 0; i < sentences.length; i += 2) {
    const sentence = sentences[i].trim();
    const punct = sentences[i + 1] || '';
    if (sentence) {
      individual.push(sentence + punct);
    }
  }
  
  // Batch sentences into chunks for Piper -- lower min for faster first-audio
  const MIN_CHUNK = 60;
  const MAX_CHUNK = 300;
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

export { STREAMING_TTS_ENABLED };
