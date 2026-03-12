/**
 * Command dispatch — intent routing
 * Routes cleaned transcript → action (mode toggle, enrollment command, interrupt, brain call).
 * Returns a dispatch result that index.js acts on.
 */

import logger from './logger.js';
import { isTldrToggleCommand, setTldrMode, isTranscriptToggleCommand, setTranscriptMode, isAskModeToggleCommand, setAskMode } from './tldr-mode.js';
import { isMobileModeToggle, setMobileMode } from './mobile-mode.js';
import { isTtsToggleCommand, setTtsProvider } from './tts-toggle.js';
import { shouldDismiss, isSideTalk } from './intent-classifier.js';

// ── Interrupt pattern detection ───────────────────────────────────────

const INTERRUPT_PATTERNS = [
  /^(jarvis\s*[,.]?\s*)?(stop|cancel|abort|shut up|be quiet|enough|nevermind|never mind|hold on|wait)\.?$/i,
  /^(jarvis\s*[,.]?\s*)?(stop|cancel)\s+(that|it|talking|speaking|please|now)\.?$/i,
  /^(jarvis\s*[,.]?\s*)?that's\s+(enough|ok|okay|fine)\.?$/i,
];

export function isInterruptCommand(transcript) {
  const clean = transcript.trim().replace(/[.,!?;:]+$/g, '');
  return INTERRUPT_PATTERNS.some(p => p.test(clean));
}

// ── Stop word filter ──────────────────────────────────────────────────

const STOP_WORDS = ['sounds good', 'thank you', 'thanks', 'obviously', 'ok', 'okay'];

/**
 * Route a cleaned transcript to an action.
 *
 * @param {string} rawTranscript - original (pre-wake-word-strip) transcript
 * @param {string} cleanedTranscript - wake-word-stripped, lowercased transcript
 * @param {string} userId
 * @param {string[]} allowedUsers
 * @param {object} enrollmentState - enrollment state object from auth.js
 * @returns {object} dispatch result:
 *   { type: 'mode_toggle' | 'enrollment' | 'interrupt' | 'stop_word' | 'side_talk' | 'bare_wake' | 'brain', ... }
 */
export function dispatchCommand(rawTranscript, cleanedTranscript, userId, allowedUsers, enrollmentState) {
  const isAdmin = allowedUsers.includes(userId);

  // ── TL;DR mode toggle ──────────────────────────────────────────────
  const tldrToggle = isAdmin ? isTldrToggleCommand(rawTranscript) : null;
  if (tldrToggle !== null) {
    const success = setTldrMode(tldrToggle);
    return { type: 'mode_toggle', mode: 'tldr', enabled: tldrToggle, success };
  }

  // ── Full transcript mode toggle ────────────────────────────────────
  const transcriptToggle = isAdmin ? isTranscriptToggleCommand(rawTranscript) : null;
  if (transcriptToggle !== null) {
    const success = setTranscriptMode(transcriptToggle);
    return { type: 'mode_toggle', mode: 'transcript', enabled: transcriptToggle, success };
  }

  // ── Ask mode toggle ────────────────────────────────────────────────
  const askToggle = isAdmin ? isAskModeToggleCommand(rawTranscript) : null;
  if (askToggle !== null) {
    const success = setAskMode(askToggle);
    return { type: 'mode_toggle', mode: 'ask', enabled: askToggle, success };
  }

  // ── TTS provider toggle ────────────────────────────────────────────
  const ttsToggle = isAdmin ? isTtsToggleCommand(rawTranscript) : null;
  if (ttsToggle) {
    const success = setTtsProvider(ttsToggle);
    return { type: 'mode_toggle', mode: 'tts', provider: ttsToggle, success };
  }

  // ── Mobile mode toggle ─────────────────────────────────────────────
  const mobileToggle = isAdmin ? isMobileModeToggle(rawTranscript) : null;
  if (mobileToggle !== null) {
    const success = setMobileMode(mobileToggle);
    return { type: 'mode_toggle', mode: 'mobile', enabled: mobileToggle, success };
  }

  // ── Enrollment commands ────────────────────────────────────────────
  if (isAdmin) {
    const cancelEnrollMatch = cleanedTranscript.match(/^(cancel|stop)\s*enroll/i);
    if (cancelEnrollMatch && enrollmentState.active) {
      return { type: 'enrollment', action: 'cancel' };
    }

    const restartEnrollMatch = cleanedTranscript.match(/^(restart|redo|reset)\s*(enroll|enrollment|voice)/i);
    if (restartEnrollMatch) {
      return { type: 'enrollment', action: 'restart', restartMatch: restartEnrollMatch };
    }

    const learnMatch = cleanedTranscript.match(/^(learn\s*mode|add\s*(more\s*)?samples|improve\s*voice)/i);
    if (learnMatch) {
      return { type: 'enrollment', action: 'learn' };
    }

    const enrollMatch = rawTranscript.match(/(en\s*roll|in\s*roll|and\s*roll|can\s*roll|un\s*roll)\s*(my\s*)?voice/i);
    if (enrollMatch) {
      return { type: 'enrollment', action: 'start' };
    }
  }

  // ── Interrupt/stop ────────────────────────────────────────────────
  if (isAdmin && isInterruptCommand(rawTranscript)) {
    return { type: 'interrupt' };
  }

  // ── Bare wake word (empty after strip) ───────────────────────────
  const bareCheck = cleanedTranscript.replace(/[.,!?;:\-'"]/g, '').trim();
  if (!bareCheck || bareCheck.length === 0) {
    return { type: 'bare_wake' };
  }

  // ── Stop word filter ──────────────────────────────────────────────
  const normalizedTranscript = cleanedTranscript.trim().toLowerCase().replace(/[.,!?]+$/, '');
  if (STOP_WORDS.includes(normalizedTranscript)) {
    logger.info(`[voice] stop word filtered: "${cleanedTranscript}"`);
    return { type: 'stop_word' };
  }

  // ── Dismiss / side-talk ───────────────────────────────────────────
  const dismissResult = shouldDismiss(cleanedTranscript);
  if (dismissResult.dismiss) {
    logger.info(`🤚 Stop word dismissed (${dismissResult.reason}): "${cleanedTranscript}"`);
    return { type: 'stop_word', reason: dismissResult.reason };
  }

  // Note: wakeWordUsed must be passed in; extracted from checkWakeWord result upstream
  // We can't call checkWakeWord here without the full pipeline context.
  // Callers must check isSideTalk separately if needed.

  // ── Brain call ────────────────────────────────────────────────────
  return { type: 'brain', transcript: cleanedTranscript };
}
