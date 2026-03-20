/**
 * FSM helpers — idle/sleep timer management and wake-up pattern matching.
 * Core state machine lives in bot-state.js; this module handles the timer
 * logic and wake-up detection that was inline in index.js.
 */

import { getState, transition } from './bot-state.js';
import { getEffectiveWindowMs, markBotResponse, endConversationWindow, WAKE_WORD_ENABLED, WAKE_WORD_FUZZY, WAKE_WORD_PHRASES, VOICE_WAKE_WORD, isContinuationPhrase, hasRecentContext, isFollowUpExpected } from './wakeword.js';
import { hasTaskContent, shouldSleep, getExtraWakeFromSleepWords } from './intent-classifier.js';
import logger from './logger.js';

// ── FSM Sleep/Idle Timers ─────────────────────────────────────────────
const ACTIVE_TO_IDLE_BASE_MS = 3 * 60 * 1000;  // 3 min baseline
const IDLE_TO_SLEEP_MS  = 2 * 60 * 1000;        // 2 more min IDLE -> SLEEP

let _activeTimer = null;
let _idleTimer = null;

// ── Post-Speak Attention Window ───────────────────────────────────────
// When Jarvis speaks a task result while in SLEEP state, open a brief window
// where the next utterance is accepted without a wake word. The user just
// heard Jarvis — they're clearly in conversation. After the window expires,
// revert to SLEEP.
const ATTENTION_WINDOW_MS = parseInt(process.env.POST_SPEAK_ATTENTION_MS || String(60 * 1000));

let _attentionWindowActive = false;
let _attentionTimer = null;

export function openAttentionWindow() {
  if (_attentionWindowActive) {
    // Extend if already open
    if (_attentionTimer) clearTimeout(_attentionTimer);
  } else {
    _attentionWindowActive = true;
    logger.info(`👂 Post-speak attention window opened (${ATTENTION_WINDOW_MS / 1000}s)`);
  }
  _attentionTimer = setTimeout(() => {
    _attentionWindowActive = false;
    _attentionTimer = null;
    logger.info('👂 Post-speak attention window closed — returning to SLEEP');
  }, ATTENTION_WINDOW_MS);
}

export function closeAttentionWindow() {
  if (_attentionTimer) clearTimeout(_attentionTimer);
  _attentionWindowActive = false;
  _attentionTimer = null;
}

export function isAttentionWindowActive() {
  return _attentionWindowActive;
}

// Callbacks wired in by index.js to avoid circular deps
let _getEnrollmentActive = () => false;
let _getAuthenticatedSession = () => false;
let _setAuthenticatedSession = () => {};
let _getPendingUtterance = () => ({});
let _clearPendingUtterance = () => {};

export function wireFSMCallbacks({
  getEnrollmentActive,
  getAuthenticatedSession,
  setAuthenticatedSession,
  getPendingUtterance,
  clearPendingUtterance,
}) {
  _getEnrollmentActive = getEnrollmentActive;
  _getAuthenticatedSession = getAuthenticatedSession;
  _setAuthenticatedSession = setAuthenticatedSession;
  _getPendingUtterance = getPendingUtterance;
  _clearPendingUtterance = clearPendingUtterance;
}

export function resetIdleSleepTimer() {
  if (_activeTimer) clearTimeout(_activeTimer);
  if (_idleTimer) clearTimeout(_idleTimer);

  const effectiveMs = Math.max(ACTIVE_TO_IDLE_BASE_MS, getEffectiveWindowMs());

  _activeTimer = setTimeout(() => {
    if (getState() === 'ACTIVE' && !_getEnrollmentActive()) {
      transition('IDLE', 'active-timeout');
      _setAuthenticatedSession(false);
      logger.info(`ACTIVE -> IDLE: no interaction for ${Math.round(effectiveMs / 1000)}s`);

      _idleTimer = setTimeout(() => {
        if (getState() === 'IDLE' && !_getEnrollmentActive()) {
          transition('SLEEP', 'idle-timeout');
          _clearPendingUtterance();
          logger.info('IDLE -> SLEEP: no interaction after IDLE timeout');
        }
      }, IDLE_TO_SLEEP_MS);
    }
  }, effectiveMs);
}

// ── Wake-Up Pattern Matching ──────────────────────────────────────────
// Build patterns from VOICE_WAKE_WORD (primary) + WAKE_WORD_PHRASES (mishears/aliases).
// WAKE_WORD_PHRASES (imported from wakeword.js) already includes auto-variants like
// "hey sonia", "yo sonia" — no need to rebuild from env.

const _ww = VOICE_WAKE_WORD; // e.g. "sonia"
const _wwEsc = _ww.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Full phrase list (VOICE_WAKE_WORD auto-variants + WAKE_WORD_PHRASES mishears)
const _allPhrases = [...new Set([...WAKE_WORD_PHRASES])];
const _phrasePattern = _allPhrases.length > 0
  ? new RegExp(`^(hey[,.]?\\s+)?(${_allPhrases.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i')
  : null;

export const WAKE_UP_PATTERNS = [
  // Wake-from-sleep commands using the configured wake word
  new RegExp(`^(${_wwEsc}[,.]?\\s*)?(wake up|i'm back|come back|resume|start listening|online)`, 'i'),
  // Direct wake word invocation: "Sonia" / "Hey Sonia"
  new RegExp(`^(hey[,.]?\\s+)?${_wwEsc}\\b`, 'i'),
  // Greeting + wake word: "Good morning, Sonia"
  new RegExp(`^(hi( there)?|hello|good (morning|evening|afternoon)|yo|sup|hey there)[,.]?\\s+${_wwEsc}\\b`, 'i'),
  // Full phrase list (auto-variants + mishears from WAKE_WORD_PHRASES)
  ...(_phrasePattern ? [_phrasePattern] : []),
];

export function isWakeUpCommand(transcript, speakerVerified = false) {
  const clean = transcript.trim().replace(/[.,!?;:]+$/g, '');
  if (WAKE_UP_PATTERNS.some(p => p.test(clean))) return true;

  // Extra wake-from-sleep words from SLEEP_WAKE_WORDS env var
  const extraWake = getExtraWakeFromSleepWords();
  if (extraWake.length > 0) {
    const lower = clean.toLowerCase();
    if (extraWake.some(w => lower.includes(w))) return true;
  }

  if (WAKE_WORD_FUZZY && speakerVerified) {
    const lower = clean.toLowerCase();
    const fuzzyMaxPrefix = parseInt(process.env.WAKE_WORD_FUZZY_MAX_PREFIX || '12');
    const fuzzyMinSentence = parseInt(process.env.WAKE_WORD_FUZZY_MIN_SENTENCE || '8');
    const fuzzyPattern = new RegExp(
      `^([a-z]{1,${fuzzyMaxPrefix}})[,.]?\\s+(.{${fuzzyMinSentence},})$`, 'i'
    );
    const m = lower.match(fuzzyPattern);
    if (m) {
      const prefix = m[1];
      const COMMON = [
        'so', 'but', 'and', 'the', 'its', 'ok', 'okay', 'yes', 'no', 'hey', 'well',
        'now', 'just', 'wait', 'oh', 'i', 'we', 'you', 'he', 'she', 'it', 'they',
        'this', 'that', 'what', 'how', 'why', 'when', 'where', 'can', 'could', 'would',
        'should', 'will', 'do', 'did', 'is', 'are', 'was', 'were', 'have', 'has', 'had',
        'get', 'got', 'go', 'going', 'let', 'make', 'take', 'also', 'actually',
        'basically', 'literally',
      ];
      if (!COMMON.includes(prefix)) {
        logger.info(`🎯 Fuzzy wake (FSM gate): "${prefix}" → treating as wake word (speaker verified)`);
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if transcript is a sleep/sign-off command and handle the transition.
 * Returns true if handled (caller should return), false if not a sleep command.
 * If hasTaskContent(), sets autoSleepAfterTask flag and returns false (let task flow through).
 * @param {string} transcript - lowercased, punctuation-stripped transcript
 * @param {string} transitionReason - reason label passed to transition('SLEEP', ...)
 * @param {string} userId
 * @param {object} pendingUtteranceRef - mutable ref to _pendingUtterance for autoSleepAfterTask flag
 * @param {Function} synthesizeSpeech - TTS function
 * @param {object} audioQueue - audio queue
 */
export async function handleSleepCheck(transcript, transitionReason, userId, pendingUtteranceRef, synthesizeSpeech, audioQueue) {
  if (!shouldSleep(transcript)) return false;
  if (hasTaskContent(transcript)) {
    logger.info(`Task detected with sign-off (${transitionReason}) — will auto-sleep after response: "${transcript}"`);
    if (pendingUtteranceRef) pendingUtteranceRef.autoSleepAfterTask = true;
    return false;
  }
  logger.info(`Sleep mode activated (${transitionReason}): "${transcript}"`);
  transition('SLEEP', transitionReason);
  _clearPendingUtterance();
  _setAuthenticatedSession(false);
  endConversationWindow(userId);
  const isConversational = /\b(sounds?\s*good|thanks?|thank\s*you|cheers|talk\s*to\s*you|catch\s*you|have\s*a\s*good|appreciate|later|all\s*set|im\s*(good|done|all set))\b/i.test(transcript);
  const farewells = isConversational
    ? ['Anytime, sir.', 'Of course.', 'Very good, sir.', 'Cheers.']
    : ['Going quiet. Just say my name when you need me.'];
  const farewell = farewells[Math.floor(Math.random() * farewells.length)];
  const ack = await synthesizeSpeech(farewell);
  if (ack) { audioQueue.add(ack); }
  return true;
}

/**
 * Apply implicit wake word on self-unmute.
 * @param {string} userId
 * @param {Function} setAuthenticatedSession
 */
export function applyImplicitWakeOnUnmute(userId, setAuthenticatedSession) {
  const currentState = getState();
  if (currentState !== 'ACTIVE') {
    transition('ACTIVE', 'implicit-wake-unmute');
    setAuthenticatedSession(true);
    logger.info(`🎙️  Implicit wake: self-unmute opened conversation window (was ${currentState})`);
  }
  markBotResponse(userId, { followUpLikely: false });
  resetIdleSleepTimer();
  logger.info(`🎙️  Implicit wake window open — first utterance does not require wake word`);
}

// ── Follow-Up Detection ───────────────────────────────────────────────

const FOLLOWUP_PATTERNS = [
  /\d+\.\s+\w/,
  /^\s*[-•]\s+\w/m,
  /\b(first|second|third|here are|top \d|there are \d)\b/i,
  /\bwant me to\b/i,
  /\bshould I\b/i,
  /\bwould you like\b/i,
  /\bdo you want\b/i,
  /\bany (questions|thoughts)\b/i,
  /\blet me know\b/i,
  /\bfor more (info|details|on)\b/i,
  /\?\s*$/,
];

export function detectFollowUpLikely(responseText) {
  if (!responseText || responseText.length < 20) return false;
  return FOLLOWUP_PATTERNS.some(p => p.test(responseText));
}
