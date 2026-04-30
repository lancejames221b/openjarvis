/**
 * tts-delivery.js — TTS speak queue and delivery gate.
 *
 * Extracted from src/index.js. Manages the AudioQueue class, the TTS delivery
 * active flag, and the pending speaks buffer that buffers /speak callbacks
 * while TTS is streaming or audio is playing.
 *
 * Export: AudioQueue class, audioQueue instance (shared), plus delivery helpers.
 */

import { unlinkSync } from 'fs';
import logger from '../logger.js';
import { synthesizeSpeech, splitIntoSentences } from './tts.js';
import { getPlayer, audioQueue as speechAudioQueue, setIsSpeaking, getIsSpeaking } from './speech-output.js';
import { cancelTaskAutoSleep, resetIdleSleepTimer, openAttentionWindow } from '../state/fsm.js';
import { getState } from '../state/bot-state.js';
import { isActive as isMuteQueueActive, addEntry as muteQueueAdd } from '../state/mute-queue.js';
import { ttsDelivery, pendingSpeaks } from '../state/runtime.js';
import { postToTextChannel } from '../discord/posting.js';

const MUTE_QUEUE_ENABLED = process.env.MUTE_QUEUE_ENABLED === 'true';
const AUDIO_QUEUE_MAX_SIZE = parseInt(process.env.AUDIO_QUEUE_MAX_SIZE || '50');

// ── TTS Delivery Active Gate ──────────────────────────────────────────

export function setTTSDeliveryActive(val) { ttsDelivery.active = !!val; }
export function isTTSDeliveryActive() { return ttsDelivery.active; }

export function _shouldBufferSpeak() {
  return ttsDelivery.active || speechAudioQueue.playing;
}

// ── Flush Pending Speaks ──────────────────────────────────────────────

export async function flushPendingSpeaks() {
  ttsDelivery.flushScheduled = false;
  while (pendingSpeaks.length > 0) {
    const { message, speakOpts } = pendingSpeaks.shift();
    logger.info(`🔔 Flushing queued /speak (${pendingSpeaks.length} remaining): "${message.substring(0, 60)}"`);
    await _deliverSpeak(message, speakOpts);
  }
}

export function scheduleFlushOnDrain() {
  if (ttsDelivery.flushScheduled || pendingSpeaks.length === 0) return;
  ttsDelivery.flushScheduled = true;
  speechAudioQueue.onDrained(() => flushPendingSpeaks().catch(() => {}));
}

// ── Deliver Speak ─────────────────────────────────────────────────────

export async function _deliverSpeak(message, speakOpts = {}) {
  if (!message || message.trim().length < 2) return;
  if (MUTE_QUEUE_ENABLED && isMuteQueueActive()) {
    const source = speakOpts.source || 'speak';
    const priority = speakOpts.priority || 3;
    muteQueueAdd(message.trim(), source, priority);
    logger.info(`🔇 /speak intercepted - queued for mute debrief (${source})`);
    return;
  }
  cancelTaskAutoSleep();
  resetIdleSleepTimer();
  const wasAsleep = getState() === 'SLEEP';
  const sentences = splitIntoSentences(message);
  audioQueue.setGenerating(true);
  try {
    for (const sentence of sentences) {
      if (sentence.trim().length < 2) continue;
      const audio = await synthesizeSpeech(sentence.trim());
      if (audio) {
        audioQueue.add(audio);
      } else {
        postToTextChannel(`🔇 ${sentence}`);
      }
    }
  } finally {
    audioQueue.setGenerating(false);
  }
  if (wasAsleep) openAttentionWindow();
}

// ── AudioQueue Class ──────────────────────────────────────────────────

export class AudioQueue {
  constructor() {
    this.queue = [];
    this.playing = false;
    this._holdTimer = null;
    this._ttsGenerating = false;
    /** @type {Array<() => void>} */
    this._drainWaiters = [];
  }

  _isPlaybackIdle() {
    return this.queue.length === 0 && !this.playing && !this._ttsGenerating && !this._holdTimer;
  }

  _notifyPlaybackDrainedIfIdle() {
    if (!this._isPlaybackIdle()) return;
    const waiters = this._drainWaiters.splice(0);
    for (const fn of waiters) {
      try { fn(); } catch (e) { logger.error('[AudioQueue] drain waiter error:', e.message); }
    }
  }

  waitForPlaybackDrained() {
    return new Promise((resolve) => {
      if (this._isPlaybackIdle()) { resolve(); return; }
      this._drainWaiters.push(resolve);
    });
  }

  onDrained(fn) {
    if (this._isPlaybackIdle()) {
      fn();
    } else {
      this._drainWaiters.push(fn);
    }
  }

  setGenerating(value) {
    this._ttsGenerating = !!value;
    if (!value && this.queue.length === 0 && !this.playing) {
      serverMuteOwner(false);
      setIsSpeaking(false);
      this._notifyPlaybackDrainedIfIdle();
    }
  }

  add(audioSource, metadata = {}) {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
    if (this.queue.length >= AUDIO_QUEUE_MAX_SIZE) {
      const dropped = this.queue.shift();
      logger.warn(`[AudioQueue] Max size (${AUDIO_QUEUE_MAX_SIZE}) reached - dropping oldest item: ${dropped.audioSource}`);
      try { unlinkSync(dropped.audioSource); } catch {}
    }
    this.queue.push({ audioSource, metadata });
    if (!this.playing) this.playNext();
  }

  clear() {
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
    this.queue = [];
    const player = getPlayer();
    if (this.playing) {
      player?.stop(true);
      this.playing = false;
    }
    serverMuteOwner(false);
    this._notifyPlaybackDrainedIfIdle();
  }

  async playNext() {
    if (this.queue.length === 0) {
      if (this._ttsGenerating) {
        this.playing = false;
        return;
      }
      const holdMs = parseInt(process.env.SPEAKING_HOLD_MS || '800');
      if (holdMs > 0 && this.playing) {
        this._holdTimer = setTimeout(() => {
          this._holdTimer = null;
          if (this.queue.length === 0 && !this._ttsGenerating) {
            this.playing = false;
            setIsSpeaking(false);
            serverMuteOwner(false);
            this._notifyPlaybackDrainedIfIdle();
          } else {
            this.playNext();
          }
        }, holdMs);
        return;
      }
      this.playing = false;
      setIsSpeaking(false);
      serverMuteOwner(false);
      this._notifyPlaybackDrainedIfIdle();
      return;
    }
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }

    const { isOthersPresent } = await import('./wakeword.js');
    const { WAKE_WORD_ENABLED } = await import('./wakeword.js');
    // ownerMuted is in interactionState — import lazily to avoid circular dep
    const { interactionState } = await import('../state/runtime.js');

    if (isOthersPresent() && !interactionState.ownerMuted && !WAKE_WORD_ENABLED) {
      logger.info(`🤫 Holding response - owner unmuted with others present (${this.queue.length} queued)`);
      this.playing = false;
      setIsSpeaking(false);
      return;
    }

    const nextItem = this.queue[0];
    const nextCtx = nextItem?.metadata ?? null;
    const { isSonosModeEnabled, getSonosCtx } = await import('../sonos-mode.js');
    const nextRoutesToSonos = nextCtx?.channelId
      ? isSonosModeEnabled(nextCtx.channelId)
      : isSonosModeEnabled(getSonosCtx().channelId);

    const wasPlaying = this.playing;
    this.playing = true;
    setIsSpeaking(true);
    if (!wasPlaying) {
      if (!nextRoutesToSonos) serverMuteOwner(true);
      const { markBotResponse } = await import('./wakeword.js');
      const { pendingUtterance, activeTasks } = await import('../state/runtime.js');
      const _qOwner = pendingUtterance?.userId || [...activeTasks.values()][0]?.userId;
      if (_qOwner) markBotResponse(_qOwner);
    }

    let { audioSource, metadata } = this.queue.shift();
    if (!wasPlaying) {
      const { prependSilence } = await import('./voice-receiver.js');
      const btLeadMs = parseInt(process.env.BT_LEAD_IN_MS || '0');
      const padded = prependSilence(audioSource, btLeadMs);
      if (padded !== audioSource) {
        try { unlinkSync(audioSource); } catch {}
        audioSource = padded;
      }
    }

    const { playAudioEnhanced } = await import('./voice-receiver.js');
    try { await playAudioEnhanced(audioSource, metadata); } catch (err) { logger.error('Queue playback error:', err.message); }
    try { unlinkSync(audioSource); } catch {}
    setImmediate(() => this.playNext());
  }
}

// Lazy circular-dep resolution for serverMuteOwner
async function serverMuteOwner(mute) {
  const { serverMuteOwner: smo } = await import('./voice-receiver.js');
  return smo(mute);
}

// ── Singleton audioQueue ──────────────────────────────────────────────
export const audioQueue = new AudioQueue();
