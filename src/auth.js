/**
 * Speaker authentication module
 * Handles speaker verification HTTP calls, isVerifiedOwner helper, and enrollment logic.
 */

import logger from './logger.js';

const SPEAKER_ENROLL_URL = process.env.SPEAKER_VERIFY_URL?.replace('/verify', '') || 'http://localhost:8767';

// Guided enrollment prompts — wake word variants first (like Siri), then longer phrases
const ENROLLMENT_PROMPTS = [
  // Wake word variants (5) — the actual authentication trigger
  "Hey Jarvis.",
  "Jarvis, are you there?",
  "Hey Jarvis, can you hear me?",
  "Yo Jarvis.",
  "Jarvis.",
  // Longer phrases (5) — hacker movie references, diverse phonemes
  "My voice is my passport, verify me.",
  "I'm in.",
  "The only winning move is not to play.",
  "I need you to hack the planet.",
  "Jarvis, put everything we have into the thrusters.",
];

/**
 * Check if speaker is verified as owner at the required confidence tier.
 * @param {object} spkr - Speaker verification result from /verify endpoint
 * @param {'high'|'medium'|'low'} requiredTier - Minimum confidence tier required
 * @returns {boolean}
 */
export function isVerifiedOwner(spkr, requiredTier = 'high') {
  if (!spkr?.is_owner) return false;
  const tiers = { high: 3, medium: 2, low: 1 };
  return (tiers[spkr.confidence_tier] ?? 0) >= (tiers[requiredTier] ?? 3);
}

/**
 * Verify a speaker against the enrolled voiceprint.
 * Called by stt.js; exposed here for manual/test use.
 * @param {string} wavPath - Path to WAV audio file
 * @param {string} userId - Discord user ID
 * @returns {Promise<object>} Speaker verification result
 */
export async function verifySpeaker(wavPath, userId) {
  const SPEAKER_VERIFY_URL = process.env.SPEAKER_VERIFY_URL || 'http://localhost:8767/verify';
  try {
    const { default: fetch } = await import('node-fetch');
    const { createReadStream } = await import('fs');
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('audio', createReadStream(wavPath));
    if (userId) form.append('user_id', userId);
    const res = await fetch(SPEAKER_VERIFY_URL, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
      timeout: 8000,
    });
    if (!res.ok) throw new Error(`Speaker verify ${res.status}`);
    return await res.json();
  } catch (err) {
    logger.warn(`Speaker verify failed: ${err.message}`);
    return null;
  }
}

/**
 * Enrollment state machine.
 * Activated by "Jarvis, enroll my voice". Captures N audio clips and POSTs to the
 * speaker verification enrollment endpoint.
 */
export const enrollmentState = {
  active: false,
  learnMode: false,
  clipsNeeded: 10,
  clipsCollected: 0,
  promptIndex: 0,
  userId: null,
  recorded: [],

  get prompts() { return ENROLLMENT_PROMPTS; },

  start(userId, learn = false) {
    this.active = true;
    this.learnMode = learn;
    this.clipsNeeded = ENROLLMENT_PROMPTS.length;
    this.clipsCollected = 0;
    this.promptIndex = 0;
    this.userId = userId;
    this.recorded = new Array(ENROLLMENT_PROMPTS.length).fill(false);
    if (!learn) {
      fetch(`${SPEAKER_ENROLL_URL}/enroll/reset`, { method: 'POST' }).catch(() => {});
    }
  },

  currentPrompt() {
    return ENROLLMENT_PROMPTS[this.promptIndex] || null;
  },

  goToPrompt(num) {
    const idx = num - 1;
    if (idx >= 0 && idx < ENROLLMENT_PROMPTS.length) {
      this.promptIndex = idx;
      return ENROLLMENT_PROMPTS[idx];
    }
    return null;
  },

  advanceToNext() {
    this.promptIndex++;
    if (this.promptIndex >= ENROLLMENT_PROMPTS.length) {
      return null;
    }
    return ENROLLMENT_PROMPTS[this.promptIndex];
  },

  async addClip(wavPath) {
    try {
      const { default: fetch } = await import('node-fetch');
      const { createReadStream } = await import('fs');
      const FormData = (await import('form-data')).default;
      const form = new FormData();
      form.append('audio', createReadStream(wavPath));
      const res = await fetch(`${SPEAKER_ENROLL_URL}/enroll`, {
        method: 'POST',
        body: form,
        headers: form.getHeaders(),
        timeout: 10000,
      });
      const data = await res.json();
      if (data.accepted) {
        this.recorded[this.promptIndex] = true;
        this.clipsCollected = this.recorded.filter(Boolean).length;
        return { accepted: true, total: this.clipsCollected, needed: this.clipsNeeded };
      }
      return { accepted: false, reason: data.reason || 'unknown' };
    } catch (err) {
      return { accepted: false, reason: err.message };
    }
  },

  async finalize() {
    try {
      const res = await fetch(`${SPEAKER_ENROLL_URL}/enroll/finalize`, { method: 'POST' });
      const data = await res.json();
      if (!this.learnMode) this.active = false;
      return data;
    } catch (err) {
      if (!this.learnMode) this.active = false;
      return { saved: false, error: err.message };
    }
  },

  cancel() {
    this.active = false;
    this.learnMode = false;
    this.clipsCollected = 0;
    this.promptIndex = 0;
    this.recorded = [];
    fetch(`${SPEAKER_ENROLL_URL}/enroll/reset`, { method: 'POST' }).catch(() => {});
  },
};
