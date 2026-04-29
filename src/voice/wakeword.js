/**
 * Wake Word Detection Module
 * 
 * Simple transcript-based wake word detection using Whisper.
 * No additional ML dependencies - just checks the transcript for configured phrases.
 */

import 'dotenv/config';
import logger from '../logger.js';

// ── Feature Flag: VOICE_WAKE_WORD_ENABLED ─────────────────────────────────────
// Clean on/off toggle for wake word detection.
//   VOICE_WAKE_WORD_ENABLED=false (default) → always listening, no wake word needed
//   VOICE_WAKE_WORD_ENABLED=true            → only activates when wake word is heard
//
// VOICE_WAKE_WORD: primary wake word phrase (default: 'hey jarvis')
// WAKE_WORD_PHRASES: optional comma-separated list for additional phrases
// WAKE_WORD_AUTO: auto-require wake word when others are in the channel (default: true)
// ─────────────────────────────────────────────────────────────────────────────
const VOICE_WAKE_WORD_ENABLED_RAW = process.env.VOICE_WAKE_WORD_ENABLED;
const VOICE_WAKE_WORD = (process.env.VOICE_WAKE_WORD || 'jarvis').toLowerCase().trim();

// VOICE_NAME: human-readable name used in greetings and system prompts.
// Derived from VOICE_WAKE_WORD with first letter capitalized (e.g. "jarvis" → "Jarvis", "jenny" → "Jenny").
// Override with VOICE_NAME env var if the display name should differ from the wake word.
export const VOICE_NAME = process.env.VOICE_NAME
  ? process.env.VOICE_NAME.trim()
  : VOICE_WAKE_WORD.charAt(0).toUpperCase() + VOICE_WAKE_WORD.slice(1);

// Auto-build standard prefix variants from the wake word name.
// "jenny" → ["jenny", "hey jenny", "yo jenny", "ok jenny", "okay jenny"]
// These are always active — no need to list them in WAKE_WORD_PHRASES.
function buildAutoVariants(name) {
  return [name, `hey ${name}`, `yo ${name}`, `ok ${name}`, `okay ${name}`];
}
const autoVariants = buildAutoVariants(VOICE_WAKE_WORD);

// WAKE_WORD_PHRASES: optional extra phrases (mishears, aliases, legacy phrases).
// Auto-variants are merged in automatically — no need to repeat "hey jarvis" etc. here.
const WAKE_WORD_PHRASES_RAW = process.env.WAKE_WORD_PHRASES || '';
const phrasesFromEnv = WAKE_WORD_PHRASES_RAW
  .split(',')
  .map(p => p.trim().toLowerCase())
  .filter(p => p.length > 0);

// Merge auto-variants + env overrides, dedup
// These are the STATIC base phrases (env-configured). Always active.
const WAKE_WORD_PHRASES = [...new Set([...autoVariants, ...phrasesFromEnv])];

// ── Dynamic persona wake words ────────────────────────────────────────────────
// Set at runtime when a persona is activated. Merged with WAKE_WORD_PHRASES
// on every checkWakeWord call. Jarvis variants remain active regardless of persona
// because they live in WAKE_WORD_PHRASES (built from VOICE_WAKE_WORD default='jarvis').
let _personaWakeWords = [];

/**
 * Update the active persona's extra wake words.
 * Called on persona switch from index.js.
 * @param {string[]} words - wake word phrases from the persona's frontmatter
 */
export function setPersonaWakeWords(words = []) {
  const normalized = words.map(w => w.toLowerCase().trim()).filter(w => w.length > 0);
  _personaWakeWords = normalized;
  logger.info(`🎭 Persona wake words: [${normalized.join(', ')}] (jarvis variants always active)`);
}

// VOICE_WAKE_WORD_ENABLED is the explicit toggle:
//   'false' → disabled (always listen — default, existing behavior)
//   'true'  → enabled (require wake word prefix)
//   unset   → legacy: enabled only if WAKE_WORD_PHRASES are set
const WAKE_WORD_ENABLED = VOICE_WAKE_WORD_ENABLED_RAW === 'false'
  ? false
  : VOICE_WAKE_WORD_ENABLED_RAW === 'true'
    ? true
    : phrasesFromEnv.length > 0;

const WAKE_WORD_AUTO = process.env.WAKE_WORD_AUTO !== 'false'; // Default: auto-enable when others present
const CONVERSATION_WINDOW_MS = parseInt(process.env.CONVERSATION_WINDOW_MS || '120000'); // 2 minutes

// ── Fuzzy wake word ──────────────────────────────────────────────────────────
// When Whisper mishears "Jarvis" as a phonetically similar word (Curtis, Gervas,
// Douglas, service, etc.), the pattern [short-word], [sentence] still reveals intent.
// Requires WAKE_WORD_FUZZY=true AND speaker verified (unless WAKE_WORD_FUZZY_REQUIRE_SPEAKER=false)
const WAKE_WORD_FUZZY = process.env.WAKE_WORD_FUZZY === 'true'; // default: false
const WAKE_WORD_FUZZY_MIN_SENTENCE = parseInt(process.env.WAKE_WORD_FUZZY_MIN_SENTENCE || '8');
const WAKE_WORD_FUZZY_MAX_PREFIX = parseInt(process.env.WAKE_WORD_FUZZY_MAX_PREFIX || '12');
const WAKE_WORD_FUZZY_REQUIRE_SPEAKER = process.env.WAKE_WORD_FUZZY_REQUIRE_SPEAKER !== 'false'; // default: true

// Startup log: wake word feature flag status
if (WAKE_WORD_ENABLED) {
  logger.info(`🎯 Wake word: ENABLED (VOICE_WAKE_WORD_ENABLED=true) — phrases: [${WAKE_WORD_PHRASES.join(', ')}]`);
} else {
  logger.info(`🎤 Wake word: DISABLED (VOICE_WAKE_WORD_ENABLED=false) — free-listen mode`);
}

// Track when the bot last spoke to each user for conversation window
const lastBotResponseTime = new Map();

// Track whether the last response invites follow-up (lists, questions, partial info)
let followUpLikely = false;
const EXTENDED_WINDOW_MS = parseInt(process.env.EXTENDED_CONVERSATION_WINDOW_MS || '90000'); // 90s when follow-up expected — raised from 30s to match 30-90s think-and-respond cadence

// Interaction velocity: track timestamps of recent exchanges
const interactionTimestamps = [];
const VELOCITY_WINDOW_MS = 15 * 60 * 1000; // 15 min rolling window
const VELOCITY_THRESHOLD = 3; // 3+ exchanges = working session

// Continuation phrases that bypass wake word in IDLE (must reference prior context)
const CONTINUATION_PATTERNS = [
  /^(tell me|go) more/i,
  /^(what|how) about (the |that |this )/i,
  /^(and |also |what about )/i,
  /^expand on (that|this|it)/i,
  /^go (on|ahead|deeper|for it)/i,
  /^(the )?(first|second|third|fourth|fifth|last|next) (one|item|thing|point|story|article|headline)/i,
  /^(which|what) (one|was)/i,
  /^more (on|about|info|details|detail)/i,
  /^(can you |could you )?(elaborate|explain|clarify)/i,
  /^(yes|yeah|yep|sure|ok|okay)(,?\s*| )(tell me|go on|go for it|more|and|what|please|brief me|do it)?\.?$/i,
  /^(number |#)?\d+ /i, // "2" or "number 2" to select from list
  /^repeat that/i,
  /^say that again/i,
  /^what (else|did you|was that)/i,
  /^brief me/i,
  /^(do it|hit me|let's hear it|fire away|lay it on me|shoot)\.?$/i,
];

// Track whether others (non-owner, non-bot) are in the voice channel
let othersPresent = false;

/**
 * Update whether non-owner humans are in the voice channel.
 * Called from voiceStateUpdate in index.js.
 * @param {boolean} hasOthers - true if non-owner humans are present
 */
export function setOthersPresent(hasOthers) {
  const prev = othersPresent;
  othersPresent = hasOthers;
  if (prev !== hasOthers) {
    logger.info(`👥 Others in voice: ${hasOthers ? 'YES — wake word REQUIRED' : 'no — free listen'}`);
  }
}

/**
 * Check if wake word is currently required.
 * - Always required if WAKE_WORD_ENABLED=true (static override)
 * - Auto-required when non-owner humans are in channel
 * - Not required when owner is alone with Jarvis
 */
function isWakeWordRequired() {
  if (WAKE_WORD_ENABLED) return true;
  if (WAKE_WORD_AUTO && othersPresent) return true;
  return false;
}

// Prune expired entries every 5 minutes to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [userId, time] of lastBotResponseTime) {
    if (now - time > CONVERSATION_WINDOW_MS * 2) {
      lastBotResponseTime.delete(userId);
    }
  }
}, 5 * 60 * 1000);

/**
 * Check if transcript contains a wake word
 * @param {string} transcript - The transcribed text
 * @param {string} userId - Discord user ID (for conversation window tracking)
 * @returns {{ detected: boolean, cleanedTranscript: string, wakeWordUsed: boolean }}
 */
export function checkWakeWord(transcript, userId = null, speakerVerified = false) {
  if (!isWakeWordRequired()) {
    return { detected: true, cleanedTranscript: transcript, wakeWordUsed: false };
  }

  // Conversation window: skip wake word if bot spoke recently
  // BUT: when others are present, wake word is ALWAYS required (no window bypass)
  if (!othersPresent && userId && lastBotResponseTime.has(userId)) {
    const timeSinceLastResponse = Date.now() - lastBotResponseTime.get(userId);
    const windowMs = getEffectiveWindowMs();
    if (timeSinceLastResponse < windowMs) {
      const reason = windowMs > CONVERSATION_WINDOW_MS ? 'extended' : 'standard';
      logger.info(`💬 Within ${reason} conversation window (${Math.round(timeSinceLastResponse / 1000)}s ago, ${Math.round(windowMs/1000)}s window) — wake word not required`);
      return { detected: true, cleanedTranscript: transcript, wakeWordUsed: false };
    }
  }
  
  // Strip punctuation that Whisper inserts (commas, periods, etc.) for matching
  const lower = transcript.toLowerCase().trim();
  const PUNCT = /[,.\-!?;:'"]/g;
  const stripped = lower.replace(PUNCT, '').replace(/\s+/g, ' ').trim();

  // Sort phrases longest-first so "hey jarvis" matches before "jarvis"
  // Merge static base phrases + active persona's wake words (deduplicated)
  const sortedPhrases = [...new Set([...WAKE_WORD_PHRASES, ..._personaWakeWords])]
    .sort((a, b) => b.length - a.length);

  for (const phrase of sortedPhrases) {
    const phraseClean = phrase.replace(PUNCT, '').replace(/\s+/g, ' ').trim();

    // Check start of transcript (punctuation-stripped)
    if (stripped.startsWith(phraseClean)) {
      // Build regex to find the wake phrase in the original transcript
      // allowing optional punctuation between words
      const phraseWords = phraseClean.split(' ');
      const sep = '[^a-z0-9]*';
      const flexPattern = phraseWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(sep);
      const re = new RegExp('^' + flexPattern + sep, 'i');
      const match = transcript.match(re);
      const cleaned = match ? transcript.substring(match[0].length).trim() : transcript.substring(phrase.length).trim();
      logger.info(`🎯 Wake word detected: "${phrase}"`);
      return { detected: true, cleanedTranscript: cleaned, wakeWordUsed: true };
    }

    // Flexible: phrase anywhere in first 10 words (punctuation-stripped)
    const words = stripped.split(' ');
    const firstTenWords = words.slice(0, 10).join(' ');
    if (firstTenWords.includes(phraseClean)) {
      const phraseWords = phraseClean.split(' ');
      const sep = '[^a-z0-9]*';
      const flexPattern = phraseWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(sep);
      const re = new RegExp(flexPattern + sep, 'i');
      const match = transcript.match(re);
      const cleaned = match ? (transcript.substring(0, match.index) + transcript.substring(match.index + match[0].length)).trim() : transcript;
      logger.info(`🎯 Wake word detected (flexible): "${phrase}"`);
      return { detected: true, cleanedTranscript: cleaned, wakeWordUsed: true };
    }
  }

  // ── Fuzzy wake word: vocative pattern matching ──────────────────────────────
  // Catches Whisper mishears of "Jarvis" → "Curtis", "Gervas", "Douglas", "service", etc.
  // Pattern: [short-word], [sentence] where the short-word sounds like a name/address
  // Requires: WAKE_WORD_FUZZY=true AND (speaker verified OR WAKE_WORD_FUZZY_REQUIRE_SPEAKER=false)
  if (WAKE_WORD_FUZZY) {
    if (WAKE_WORD_FUZZY_REQUIRE_SPEAKER && !speakerVerified) {
      logger.info(`🔍 Fuzzy wake word: skipped (speaker not verified)`);
    } else {
      // Match: one word (1–WAKE_WORD_FUZZY_MAX_PREFIX chars), optional separator, then sentence
      // Handles: "word, sentence" / "word. sentence" / "word.sentence" / "word sentence"
      const fuzzyPattern = new RegExp(
        `^([a-z]{1,${WAKE_WORD_FUZZY_MAX_PREFIX}})[,.]?\\s*(.{${WAKE_WORD_FUZZY_MIN_SENTENCE},})$`,
        'i'
      );
      const fuzzyMatch = lower.match(fuzzyPattern);
      if (fuzzyMatch) {
        const prefix = fuzzyMatch[1];
        const sentence = fuzzyMatch[2].trim();
        // Sanity check: prefix must not be a common word that starts sentences naturally
        const COMMON_SENTENCE_STARTERS = [
          'so', 'but', 'and', 'the', 'its', 'ok', 'okay', 'yes', 'no', 'hey', 'well',
          'now', 'just', 'wait', 'oh', 'i', 'we', 'you', 'he', 'she', 'it', 'they',
          'this', 'that', 'what', 'how', 'why', 'when', 'where', 'can', 'could', 'would',
          'should', 'will', 'do', 'did', 'is', 'are', 'was', 'were', 'have', 'has', 'had',
          'get', 'got', 'go', 'going', 'let', 'make', 'take', 'also', 'actually',
          'basically', 'literally',
          // Additional common ambient phrases that triggered false wakes (added 2026-03-11)
          'thank', 'thanks', 'sorry', 'please', 'um', 'uh', 'right', 'yeah',
          'alright', 'hi', 'hello', 'good', 'hmm', 'anyway', 'wow',
        ];
        if (!COMMON_SENTENCE_STARTERS.includes(prefix.toLowerCase())) {
          logger.info(`🎯 Fuzzy wake word detected: "${prefix}" (vocative pattern, speaker verified: ${speakerVerified})`);
          return {
            detected: true,
            cleanedTranscript: sentence,
            wakeWordUsed: true,
            fuzzyMatch: true,
            fuzzyPrefix: prefix,
          };
        } else {
          logger.info(`🔍 Fuzzy wake word: rejected prefix "${prefix}" (common sentence starter)`);
        }
      }
    }
  }

  logger.info(`🚫 No wake word detected in: "${transcript.substring(0, 50)}..."`);
  return { detected: false, cleanedTranscript: transcript, wakeWordUsed: false };
}

/**
 * Check if transcript is a continuation phrase (references prior exchange).
 * Used by IDLE gate to allow follow-ups without wake word.
 * @param {string} transcript
 * @returns {boolean}
 */
export function isContinuationPhrase(transcript) {
  const clean = transcript.toLowerCase().replace(/[.,!?;:'"]/g, '').trim();
  return CONTINUATION_PATTERNS.some(p => p.test(clean));
}

/**
 * Check if the last bot response was flagged as expecting a follow-up.
 * Used by IDLE gate to allow verified-owner responses without wake word
 * after alerts, questions, and other prompts.
 */
export function isFollowUpExpected() {
  return followUpLikely;
}

/**
 * Mark that the bot just responded to a user (starts the conversation window)
 * @param {string} userId - Discord user ID
 * @param {{ followUpLikely?: boolean }} options
 */
export function markBotResponse(userId, options = {}) {
  if (userId) {
    lastBotResponseTime.set(userId, Date.now());
  }
  if (options.followUpLikely !== undefined) {
    followUpLikely = options.followUpLikely;
  }
  // Track interaction velocity
  interactionTimestamps.push(Date.now());
}

/**
 * Get the effective conversation window duration.
 * Extended when follow-up is likely or interaction velocity is high.
 */
export function getEffectiveWindowMs() {
  // Prune old timestamps
  const cutoff = Date.now() - VELOCITY_WINDOW_MS;
  while (interactionTimestamps.length && interactionTimestamps[0] < cutoff) {
    interactionTimestamps.shift();
  }
  const highVelocity = interactionTimestamps.length >= VELOCITY_THRESHOLD;

  if (followUpLikely || highVelocity) {
    return EXTENDED_WINDOW_MS;
  }
  return CONVERSATION_WINDOW_MS;
}

/**
 * Check if a recent interaction exists within the extended window (for IDLE continuation).
 * Returns true if last bot response was within 10 min (wider than conversation window).
 */
export function hasRecentContext(userId) {
  if (!userId || !lastBotResponseTime.has(userId)) return false;
  const elapsed = Date.now() - lastBotResponseTime.get(userId);
  return elapsed < getEffectiveWindowMs(); // Use actual conversation window, not hardcoded 10min
}

/**
 * Force-end the conversation window for a user (stop listening mode).
 * @param {string} userId - Discord user ID
 */
export function endConversationWindow(userId) {
  if (userId && lastBotResponseTime.has(userId)) {
    lastBotResponseTime.delete(userId);
    logger.info(`🛑 Conversation window force-closed for user ${userId}`);
    return true;
  }
  return false;
}

export function isOthersPresent() { return othersPresent; }

export { WAKE_WORD_ENABLED, WAKE_WORD_PHRASES, EXTENDED_WINDOW_MS, WAKE_WORD_FUZZY, VOICE_WAKE_WORD };
