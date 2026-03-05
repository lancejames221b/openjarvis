/**
 * Speech Output Manager
 * 
 * Manages audio playback queue, TTS synthesis, and output length enforcement.
 * Extracted from index.js to isolate output pipeline from input processing.
 */

import { createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, VoiceConnectionStatus } from '@discordjs/voice';
import { unlinkSync } from 'fs';
import { synthesizeSpeech, splitIntoSentences, isTTSAvailable } from './tts.js';
import { generateTldr } from './tldr-mode.js';

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
class AudioQueue {
  constructor() {
    this.queue = [];
    this.playing = false;
  }
  
  add(audioSource, metadata = {}) {
    this.queue.push({ audioSource, metadata });
    if (!this.playing) this.playNext();
  }
  
  clear() {
    this.queue = [];
    if (this.playing) {
      player.stop(true);
      this.playing = false;
    }
  }
  
  async playNext() {
    if (this.queue.length === 0) {
      this.playing = false;
      isSpeaking = false;
      return;
    }
    this.playing = true;
    isSpeaking = true;
    const { audioSource } = this.queue.shift();
    try { await playAudio(audioSource); } catch (err) { console.error('Queue playback error:', err.message); }
    try { unlinkSync(audioSource); } catch {}
    setImmediate(() => this.playNext());
  }
}

const audioQueue = new AudioQueue();
export { audioQueue };

// ── Audio Playback ───────────────────────────────────────────────────
export function playAudio(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const resource = createAudioResource(filePath);
      player.play(resource);
      
      const onIdle = () => { cleanup(); resolve(); };
      const onError = (err) => { cleanup(); reject(err); };
      const cleanup = () => {
        player.off(AudioPlayerStatus.Idle, onIdle);
        player.off('error', onError);
      };
      
      player.once(AudioPlayerStatus.Idle, onIdle);
      player.once('error', onError);
    } catch (err) {
      reject(err);
    }
  });
}

// ── Output Length Enforcement (Phase 3) ──────────────────────────────

// Maximum spoken seconds before auto-TL;DR kicks in (voice should be brief)
const MAX_SPOKEN_SECONDS = parseInt(process.env.MAX_SPOKEN_SECONDS || '20');
// Approximate chars per second of speech (Piper at 1.3x length_scale)
const CHARS_PER_SECOND = 12;
const MAX_SPOKEN_CHARS = MAX_SPOKEN_SECONDS * CHARS_PER_SECOND;

/**
 * Enforce output length on a full response text.
 * Returns { spoken, full, wasTruncated }
 * 
 * @param {string} fullText - Full response from gateway
 * @param {boolean} tldrModeEnabled - Whether TL;DR mode is on
 * @returns {{ spoken: string, full: string, wasTruncated: boolean }}
 */
export function enforceOutputLength(fullText, tldrModeEnabled = false) {
  if (!fullText) return { spoken: '', full: '', wasTruncated: false };
  
  const clean = fullText.replace(/<p>/g, ' ').trim();
  
  // Under limit — speak everything
  if (clean.length <= MAX_SPOKEN_CHARS && !tldrModeEnabled) {
    return { spoken: clean, full: clean, wasTruncated: false };
  }
  
  // Over limit or TL;DR mode — generate summary for voice
  if (tldrModeEnabled) {
    return {
      spoken: generateTldr(clean),
      full: clean,
      wasTruncated: true,
    };
  }
  
  // Smart truncation: take complete sentences up to limit
  const sentences = clean.split(/(?<=[.!?])\s+/);
  let spoken = '';
  for (const sentence of sentences) {
    if ((spoken + sentence).length > MAX_SPOKEN_CHARS) break;
    spoken += sentence + ' ';
  }
  spoken = spoken.trim();
  
  // Add continuation hint if we truncated
  if (spoken.length < clean.length) {
    spoken += ' Full details posted to text.';
  }
  
  return {
    spoken,
    full: clean,
    wasTruncated: spoken.length < clean.length,
  };
}

/**
 * Synthesize and queue text for playback.
 * Handles splitting into sentences, TTS synthesis, and queuing.
 * 
 * @param {string} text - Text to speak
 * @param {Function} [fallbackPost] - Function to post text if TTS unavailable
 */
export async function speakText(text, fallbackPost = null) {
  if (!text || text.trim().length < 2) return;

  // Validate voice connection before synthesizing -- don't waste TTS cycles
  // if audio will play to nowhere
  if (!isVoiceConnectionReady()) {
    console.warn('⚠️  speakText: voice connection not ready -- falling back to text');
    if (fallbackPost) {
      fallbackPost(`🔇 ${text}`);
    }
    return;
  }

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
      console.error('TTS synthesis failed:', err.message);
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
  try {
    const audio = await synthesizeSpeech(text);
    if (audio) {
      await playAudio(audio);
      try { unlinkSync(audio); } catch {}
      return true;
    }
  } catch {}
  return false;
}
