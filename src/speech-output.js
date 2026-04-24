/**
 * Speech Output Manager
 * 
 * Manages audio playback queue, TTS synthesis, and output length enforcement.
 * Extracted from index.js to isolate output pipeline from input processing.
 */

import { createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, VoiceConnectionStatus } from '@discordjs/voice';
import { unlinkSync, copyFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { synthesizeSpeech, synthesizeChatterboxStream, splitIntoSentences, isTTSAvailable } from './tts.js';
import { generateTldr } from './tldr-mode.js';
import logger from './logger.js';

// ── Audio Player ─────────────────────────────────────────────────────
// Default player -- replaced by index.js via setPlayer() to share the
// connection-subscribed player. Without setPlayer(), audio plays to void.
let player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play },
});
player.setMaxListeners(20);

let isSpeaking = false;

// ── Voice Connection Reference ───────────────────────────────────────
// Set by index.js after joining voice channel. Used to validate
// connection is alive before queuing audio (prevents silent drops).
let _voiceConnection = null;
export function setVoiceConnection(conn) { _voiceConnection = conn; }

function isVoiceConnectionReady() {
  if (!_voiceConnection) return false;
  return _voiceConnection.state.status === VoiceConnectionStatus.Ready;
}

export function getPlayer() { return player; }
export function setPlayer(p) { player = p; }
export function getIsSpeaking() { return isSpeaking; }
export function setIsSpeaking(val) { isSpeaking = val; }

// ── Audio Queue ──────────────────────────────────────────────────────
// NOTE: This is the speech-output module's own AudioQueue for TTS/ack playback.
// src/index.js has a separate AudioQueue instance for direct voice channel audio.
// Both are intentional — they manage different audio pipelines and are NOT duplicates.
const AUDIO_QUEUE_MAX_SIZE = parseInt(process.env.AUDIO_QUEUE_MAX_SIZE || '50');

class AudioQueue {
  constructor() {
    this.queue = [];
    this.playing = false;
    this._drainedCallbacks = [];
  }

  /**
   * Register a one-shot callback that fires when the queue fully drains
   * (i.e. all queued audio has finished playing).
   * Multiple callers can register; all fire on the same drain event.
   */
  onDrained(cb) {
    if (typeof cb !== 'function') return;
    // If not currently playing, fire immediately
    if (!this.playing && this.queue.length === 0) {
      setImmediate(cb);
    } else {
      this._drainedCallbacks.push(cb);
    }
  }

  add(audioSource, metadata = {}) {
    if (this.queue.length >= AUDIO_QUEUE_MAX_SIZE) {
      const dropped = this.queue.shift();
      logger.warn(`[AudioQueue] Max size (${AUDIO_QUEUE_MAX_SIZE}) reached — dropping oldest item: ${dropped.audioSource}`);
      try { unlinkSync(dropped.audioSource); } catch {}
    }
    this.queue.push({ audioSource, metadata });
    if (!this.playing) this.playNext();
  }
  
  clear() {
    this.queue = [];
    if (this.playing) {
      player.stop(true);
      this.playing = false;
    }
    // Fire drained callbacks immediately on clear (queue is gone)
    this._fireDrained();
  }

  _fireDrained() {
    const cbs = this._drainedCallbacks.splice(0);
    for (const cb of cbs) {
      try { setImmediate(cb); } catch {}
    }
  }
  
  async playNext() {
    if (this.queue.length === 0) {
      this.playing = false;
      isSpeaking = false;
      this._fireDrained();
      return;
    }
    this.playing = true;
    isSpeaking = true;
    const { audioSource, metadata } = this.queue.shift();
    try { await playAudio(audioSource); } catch (err) { logger.error('Queue playback error:', err.message); }
    // Skip unlink for entries marked keep:true (e.g. ACK_CACHE originals — only copies should be deleted)
    if (!metadata?.keep) { try { unlinkSync(audioSource); } catch {} }
    setImmediate(() => this.playNext());
  }
}

const audioQueue = new AudioQueue();
export { audioQueue };

// ── Audio Playback ───────────────────────────────────────────────────
export function playAudio(filePath) {
  return new Promise((resolve, reject) => {
    let timeoutHandle = null;
    try {
      // Safety timeout sized to the audio's real duration + 3s slack. Before
      // this fix, if AudioPlayer never emitted Idle/error (e.g. voice connection
      // dropped mid-play, player disposed), the Promise pended forever, the
      // queue deadlocked, and isSpeaking stayed true — silent catastrophic stall.
      let maxDurationMs = 30_000; // fallback
      try {
        const size = statSync(filePath).size;
        // WAV 24kHz mono 16-bit = 48kB/s; MP3 ~16kB/s. Use the smaller bytes/sec
        // so the timeout is generous (overestimates duration).
        maxDurationMs = Math.max(5_000, (size / 16000) * 1000 + 3_000);
      } catch {}

      const resource = createAudioResource(filePath);
      player.play(resource);

      const onIdle = () => { cleanup(); resolve(); };
      const onError = (err) => { cleanup(); reject(err); };
      const cleanup = () => {
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        player.off(AudioPlayerStatus.Idle, onIdle);
        player.off('error', onError);
      };

      player.once(AudioPlayerStatus.Idle, onIdle);
      player.once('error', onError);
      timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error(`playAudio timed out after ${maxDurationMs}ms`));
      }, maxDurationMs);
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    }
  });
}

// ── Output Length Enforcement (Phase 3) ──────────────────────────────

// No automatic length-based truncation — speak everything unless TL;DR mode is explicitly on.
// MAX_SPOKEN_SECONDS is kept for monitoring/logging only; it does NOT cut speech.
const MAX_SPOKEN_SECONDS = parseInt(process.env.MAX_SPOKEN_SECONDS || '20');
const _ttsProvider = (process.env.TTS_PROVIDER || 'piper').toLowerCase();
// Kokoro and Chatterbox speak at natural cadence (~14 chars/sec); slower providers ~12.
const CHARS_PER_SECOND = (_ttsProvider === 'chatterbox' || _ttsProvider === 'kokoro') ? 14 : 12;
const MAX_SPOKEN_CHARS = MAX_SPOKEN_SECONDS * CHARS_PER_SECOND; // reference only

/**
 * Enforce output length on a full response text.
 * Returns { spoken, full, wasTruncated }
 *
 * Length-based truncation is DISABLED — Jarvis speaks the full response.
 * Only TL;DR mode (explicit user toggle) produces a summary instead.
 *
 * @param {string} fullText - Full response from gateway
 * @param {boolean} tldrModeEnabled - Whether TL;DR mode is on
 * @returns {{ spoken: string, full: string, wasTruncated: boolean }}
 */
export function enforceOutputLength(fullText, tldrModeEnabled = false) {
  if (!fullText) return { spoken: '', full: '', wasTruncated: false };
  
  const clean = fullText.replace(/<p>/g, ' ').trim();

  // TL;DR mode only — explicit user toggle, not auto-triggered by length
  if (tldrModeEnabled) {
    return {
      spoken: generateTldr(clean),
      full: clean,
      wasTruncated: true,
    };
  }

  // Always speak everything
  if (clean.length > MAX_SPOKEN_CHARS) {
    logger.info(`📏 Long response (${clean.length} chars) — speaking in full, posting to text channel`);
  }

  return { spoken: clean, full: clean, wasTruncated: false };
}

/**
 * Synthesize and queue text for playback.
 * For Chatterbox: uses the streaming /tts/stream endpoint — server splits sentences,
 * generates sequentially, and we queue each WAV as it arrives (fast first-audio).
 * For other providers: splits client-side and calls synthesizeSpeech() per chunk.
 *
 * @param {string} text - Text to speak
 * @param {Function} [fallbackPost] - Function to post text if TTS unavailable
 */
export async function speakText(text, fallbackPost = null) {
  if (!text || text.trim().length < 2) return;

  // Validate voice connection before synthesizing -- don't waste TTS cycles
  // if audio will play to nowhere
  if (!isVoiceConnectionReady()) {
    logger.warn('⚠️  speakText: voice connection not ready -- falling back to text');
    if (fallbackPost) {
      fallbackPost(`🔇 ${text}`);
    }
    return;
  }

  const provider = (process.env.TTS_PROVIDER || 'piper').toLowerCase();

  // Chatterbox: use server-side streaming — bypasses client sentence splitting
  // Server handles splitting, caches voice conditionals, streams NDJSON as sentences complete
  if (provider === 'chatterbox') {
    let anyAudio = false;
    try {
      await synthesizeChatterboxStream(text.trim(), (audioPath) => {
        audioQueue.add(audioPath);
        anyAudio = true;
      });
    } catch (err) {
      logger.error('Chatterbox stream failed:', err.message);
    }
    if (!anyAudio && fallbackPost) {
      fallbackPost(`🔇 ${text}`);
    }
    return;
  }

  // Non-chatterbox: client-side sentence splitting + per-sentence synthesis
  const sentences = splitIntoSentences(text);
  for (const sentence of sentences) {
    if (sentence.trim().length < 2) continue;
    try {
      const audio = await synthesizeSpeech(sentence.trim());
      if (audio) {
        audioQueue.add(audio);
      } else if (!isTTSAvailable() && fallbackPost) {
        fallbackPost(`🔇 ${sentence}`);
      }
    } catch (err) {
      logger.error('TTS synthesis failed:', err.message);
    }
  }
}

/**
 * Speak a single short phrase (acks, chimes, etc.)
 * Returns immediately after queuing.
 */
export async function speakPhrase(text) {
  try {
    const audio = await synthesizeSpeech(text);
    if (audio) audioQueue.add(audio);
    return !!audio;
  } catch {
    return false;
  }
}

/**
 * Play a phrase and wait for it to finish (blocking).
 * Used for greetings, mode change acks, etc.
 */
export async function speakAndWait(text) {
  let audio = null;
  try {
    audio = await synthesizeSpeech(text);
    if (!audio) return false;
    await playAudio(audio);
    return true;
  } catch {
    return false;
  } finally {
    // Unlink the wav on EVERY exit path — previously the unlink was after
    // playAudio and only ran on success, leaking /tmp wavs on any throw.
    if (audio) { try { unlinkSync(audio); } catch {} }
  }
}

// ── Pre-cached Ack Phrases ───────────────────────────────────────────
// WAV files synthesized at startup for instant playback (zero TTS latency on ack).

const ACK_PHRASES = [
  'On it, sir.',
  'Give me a moment.',
  'Checking that now.',
  'Looking into it.',
  'Right away, sir.',
  'One moment.',
  'Let me check.',
  'Of course.',
];

const ACK_CACHE = []; // array of file paths (persistent for process lifetime)

/**
 * Pre-synthesize all ack phrases and store paths in ACK_CACHE.
 * @param {Function} synthesizeFn - synthesizeSpeech function
 */
export async function preloadAckPhrases(synthesizeFn) {
  let loaded = 0;
  for (const phrase of ACK_PHRASES) {
    try {
      const filePath = await synthesizeFn(phrase);
      if (filePath) {
        ACK_CACHE.push(filePath);
        loaded++;
      }
    } catch (err) {
      logger.warn(`Ack preload failed for "${phrase}": ${err.message}`);
    }
  }
  logger.info(`⚡ Pre-cached ${loaded} ack phrases`);
}

/**
 * Returns a copy of a random cached ack WAV path, or null if not ready.
 * Returns a copy so the original is preserved after queue playback deletes it.
 */
export function getRandomCachedAck() {
  if (ACK_CACHE.length === 0) return null;
  const src = ACK_CACHE[Math.floor(Math.random() * ACK_CACHE.length)];
  const dest = join(tmpdir(), `jarvis-ack_play_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
  try {
    copyFileSync(src, dest);
    return dest;
  } catch {
    return null;
  }
}
