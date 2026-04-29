import logger from './logger.js';
import 'dotenv/config';

// ── Wake word config (read from env, never hardcoded) ────────────────────────
const _wakeWord = (process.env.VOICE_WAKE_WORD || 'jarvis').toLowerCase().trim();
const _wakeVariants = [_wakeWord, `hey ${_wakeWord}`, `yo ${_wakeWord}`, `ok ${_wakeWord}`];

// ── Extra env-configurable stop/dismiss words ─────────────────────────────────
// STOP_WORDS_EXTRA: comma-separated exact phrases added to STOP_WORDS_EXACT
// STOP_PREFIXES_EXTRA: comma-separated prefixes added to STOP_PREFIXES
let _extraStopWords = null;
let _extraStopPrefixes = null;
function getExtraStopWords() {
  if (_extraStopWords !== null) return _extraStopWords;
  _extraStopWords = (process.env.STOP_WORDS_EXTRA || '')
    .split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
  return _extraStopWords;
}
function getExtraStopPrefixes() {
  if (_extraStopPrefixes !== null) return _extraStopPrefixes;
  _extraStopPrefixes = (process.env.STOP_PREFIXES_EXTRA || '')
    .split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
  return _extraStopPrefixes;
}
/**
 * Intent Classifier - Dynamic Response Intelligence
 *
 * Central module for all utterance classification:
 *
 * PRE-GATEWAY FILTERS (run before any LLM call):
 *   - isHallucination()  — Whisper phantom phrases from silence/ambient
 *   - shouldSleep()      — Sleep/mute/dismiss commands
 *   - shouldDismiss()    — Stop words and acknowledgments (length-gated)
 *   - isSideTalk()       — Non-directed speech in conversation window
 *
 * RESPONSE BUDGETING (classifyIntent, run before brain call):
 *   1. ADMIN_CMD     - Model switching, exec, memory, meta commands
 *   2. CHAT          - Greetings, small talk
 *   3. EMAIL_DETAIL  - Follow-up on specific email after SUMMARIZE
 *   4. FOLLOW_UP     - Continuation phrases
 *   5. EMAIL_SUMMARY - Inbox summary requests
 *   6. EMAIL_ACTION  - Reply, forward, compose, flag emails
 *   7. EMAIL_QUERY   - Questions about specific emails
 *   8. CALENDAR      - Calendar queries and actions
 *   9. MEMORY_CMD    - Remember/recall commands
 *  10. PLAN_CMD      - Planning/todo commands
 *  11. STUDY_CMD     - Deep research/study commands
 *  12. QUERY         - General information requests
 *  13. ACTION        - Task execution (expanded verb list)
 *  14. LIST_QUERY    - Listing/enumeration
 *  15. DEEP_DIVE     - Detailed explanations
 *  16. Duration-based fallback
 */

// ── Pre-Gateway Filters ──────────────────────────────────────────────────────
// These run BEFORE classifyIntent, BEFORE the gateway call.
// They determine whether the utterance should be silently dropped.

const WHISPER_HALL_EXACT = new Set([
  // NOTE: 'thank you' removed — it's a real phrase, not a hallucination
  'you', 'bye', 'hmm', 'um', 'uh', 'ah', 'oh',
  'so', 'okay', "i'm sorry", 'what', 'no no no',
  'no, no, no', 'the end', 'goodbye',
]);

const WHISPER_HALL_PREFIX = [
  'thanks for watching', 'thanks for listening',
  "we'll be right back", 'please subscribe',
  'subtitles by', 'subtitles made by', 'translated by',
];

// Known short commands that should NOT be filtered as TV noise
// (these are valid 1-2 word voice commands)
// Wake word variants are injected dynamically from VOICE_WAKE_WORD — no hardcoding
const SHORT_COMMAND_WHITELIST = new Set([
  ..._wakeVariants, 'stop', 'sleep', 'mute', 'pause', 'play',
  'cancel', 'quiet', 'silence', 'resume', 'next', 'back', 'louder',
  'softer', 'volume up', 'volume down', 'lights on', 'lights off',
  'good morning', 'good night', 'wake up', 'stand down', 'dismissed',
  'enroll', 'enroll voice', 'enroll my voice',
  'brief mode', 'tldr mode', 'tldr on', 'tldr off',
  'brief mode on', 'brief mode off',
  'mobile mode', 'mobile mode on', 'mobile mode off',
  'desk mode', 'heading out', 'going mobile', 'on the go',
  // Follow-up / debrief responses (mute queue, alert briefing, any "shall I?" prompt)
  'yes', 'yes please', 'yeah', 'yep', 'sure', 'ok', 'okay',
  'go for it', 'do it', 'go ahead', 'brief me', 'hit me',
  'fire away', 'lets hear it', 'no', 'no thanks', 'not now',
  'tell me', 'tell me more', 'go on', 'continue', 'more',
  'what was it', 'say again', 'repeat that', 'skip it',
  'thank you', 'thanks', 'thank you jarvis', 'thanks jarvis',
]);

// Callback to check if a follow-up is expected (set by index.js at init)
let _followUpExpectedFn = null;
export function setFollowUpExpectedCallback(fn) { _followUpExpectedFn = fn; }

/**
 * Detect Whisper hallucinations — phantom phrases generated from silence/ambient noise.
 * Also filters short TV audio bleed-through fragments (under 3 words, not matching commands).
 * @param {string} rawTranscript - Raw transcript from Whisper STT
 * @returns {boolean} true if this is a hallucination to be dropped
 */
export function isHallucination(rawTranscript) {
  const check = rawTranscript.toLowerCase().replace(/[.,!?]/g, '').trim();
  if (check.length < 3) return true;
  if (WHISPER_HALL_EXACT.has(check)) return true;
  if (WHISPER_HALL_PREFIX.some(h => check.startsWith(h))) return true;

  // TV noise suppression: short fragments (under 3 words) that aren't known commands
  // are likely TV audio bleed-through. Drop them silently.
  // BYPASS: when a follow-up is expected (mute queue debrief, alert briefing, etc.),
  // short phrases are legitimate responses — don't filter them.
  const words = check.split(/\s+/);
  if (words.length < 3 && !SHORT_COMMAND_WHITELIST.has(check)) {
    // Skip TV filter when follow-up is expected (conversation in progress)
    if (_followUpExpectedFn && _followUpExpectedFn()) {
      logger.info(`💬 Short phrase allowed (follow-up expected): "${check}"`);
    } else {
      // Also allow if it contains a wake word variant (might be "jarvis" + noise)
      const hasWakeWord = /\b(jarvis|harvest|harvey|harvis|jarvas|jarvi|service|gargis)\b/i.test(check);
      if (!hasWakeWord) {
        logger.info(`🔇 TV noise filter: "${check}" (${words.length} words, not a known command)`);
        return true;
      }
    }
  }

  return false;
}

// Trailing-fragment patterns — utterances that are clearly mid-sentence cut-offs.
// These result from VAD firing during a pause (1.5s silence threshold).
// Dropping silently is better than responding to "...so something is a"
const TRAILING_FRAGMENT_RE = /(\.\.\.|…)$|(\s(a|an|the|to|of|in|at|on|and|but|or|so|is|are|was|were|be|been|being|do|did|have|had|my|your|our|their|this|that|these|those|with|for|from|by|as|if|then|than|because|when|where|while|which|who|how|what|why)\s*[.,!?]?\s*)$/i;

/**
 * Detect VAD-clipped mid-sentence fragments — utterances that ended because
 * the speaker paused too long (VAD timeout) rather than finishing their thought.
 *
 * Silently drop these rather than responding with "sounds like that got clipped."
 *
 * @param {string} text - Cleaned or raw transcript
 * @returns {boolean} true if this looks like a truncated fragment
 */
export function isTruncatedFragment(text) {
  const trimmed = text.trim();
  // Whisper ellipsis — explicit truncation signal
  if (trimmed.endsWith('...') || trimmed.endsWith('…')) return true;
  // Short utterance (< 10 words) ending with dangling article/preposition/conjunction
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length <= 12 && TRAILING_FRAGMENT_RE.test(trimmed)) return true;
  return false;
}

// Superset of both pre-wake and post-wake sleep patterns
const SLEEP_PATTERNS = [
  /^sleep$/i, /^stop$/i,
  /\bstop\s*listen/i, /\bgo\s*to\s*sleep/i, /\bsleep\s*mode/i,
  /\bshut\s*up/i, /\bbe\s*quiet/i, /\bsilence\b/i,
  /\bstop\s*talking/i, /\bquiet\s*down/i, /\bmute\b/i,
  /\bgo\s*away/i, /\bleave\s*me\s*alone/i,
  /\bthat\s*(is|'s)\s*all\b/i, /\bthat\s*will\s*be\s*all\b/i,
  /\bsee\s*you\s*(later|soon|tomorrow|around)/i,
  /\bgood\s*night/i, /\bbye\b/i, /\bgoodbye\b/i,
  /\btake\s*care/i, /\blater\b$/i,
  /\bstand\s*down\b/i, /\bdismissed\b/i,
  /\bgo\s*silent\b/i, /\bgo\s*dark\b/i, /\bpower\s*down\b/i,
  // Natural conversational sign-offs
  /\btalk\s*to\s*you\s*(later|soon|tomorrow|in a bit)/i,
  /\bcatch\s*you\s*(later|soon|tomorrow)/i,
  /\bpeace\s*out/i, /\bim\s*(out|done|good)\b/i,
  /\bthats\s*it\s*(for now|for today)?\b/i,
  /\bnothing\s*(else|more)\s*(for now|right now|today)?\b/i,
  /\ball\s*set\b/i, /\bwe\s*re\s*(good|done|all set)\b/i,
  /\bim\s*all\s*(good|set|done)\b/i,
  /\bhave\s*a\s*good\s*(one|night|evening|day|morning)/i,
  // "Thank you Jarvis" / "Jarvis, thank you" / "Thanks Jarvis" — direct sleep
  /\b(thanks?(\s*you)?)\s*(very\s*much\s*)?jarvis\b/i,
  /\bjarvis\s*,?\s*(thanks?(\s*you)?)\b/i,
  // "talking to myself" — sleep word: user was not addressing Jarvis.
  // Matches: "talking to myself", "I'm talking to myself", "I was talking to myself",
  //          "just talking to myself", "sorry, talking to myself", etc.
  /\btalking\s+to\s+myself\b/i,
];

// Compound sign-offs: "sounds good" / "thank you" / "thanks" + jarvis or sign-off word.
// These are too short to be sleep patterns alone, but combined they signal end of conversation.
// e.g., "sounds good jarvis", "thanks jarvis talk to you later", "sounds good thank you"
const SIGNOFF_COMPOUND = /\b(sounds?\s*good|thanks?(\s*you)?|cheers|appreciate\s*it|perfect)\b/i;
// SIGNOFF_CLOSER built dynamically — includes current wake word from env.
// Also include the base name (last word of wake phrase) so "sounds good jarvis" works
// even when VOICE_WAKE_WORD="hey jarvis" (which makes _wakeVariants miss bare "jarvis").
const _wakeBaseName = _wakeWord.split(/\s+/).pop();
const _signoffWakeVariants = [...new Set([..._wakeVariants, _wakeBaseName])];
const _signoffWakePattern = _signoffWakeVariants.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const SIGNOFF_CLOSER = new RegExp(`\\b(${_signoffWakePattern}|talk\\s*to\\s*you|later|bye|good\\s*night|see\\s*you|take\\s*care|thats?\\s*(all|it)|peace|im\\s*(done|out|good)|have\\s*a\\s*good)`, 'i');

// ── Env-configurable extra sleep/wake words ──────────────────────────────────
// SLEEP_WORDS: comma-separated phrases appended to SLEEP_PATTERNS at first call
// SLEEP_WAKE_WORDS: comma-separated phrases used by isEnvWakeFromSleep() in fsm.js
// Lazy-parsed (on first shouldSleep call) so dotenv has time to load.
let _extraSleepPatterns = null;
function getExtraSleepPatterns() {
  if (_extraSleepPatterns !== null) return _extraSleepPatterns;
  const raw = process.env.SLEEP_WORDS || '';
  _extraSleepPatterns = raw
    .split(',')
    .map(w => w.trim().toLowerCase())
    .filter(Boolean)
    .map(w => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  return _extraSleepPatterns;
}

// Exported so fsm.js can check SLEEP_WAKE_WORDS without duplicating parse logic
let _extraWakeFromSleepWords = null;
export function getExtraWakeFromSleepWords() {
  if (_extraWakeFromSleepWords !== null) return _extraWakeFromSleepWords;
  const raw = process.env.SLEEP_WAKE_WORDS || '';
  _extraWakeFromSleepWords = raw
    .split(',')
    .map(w => w.trim().toLowerCase())
    .filter(Boolean);
  return _extraWakeFromSleepWords;
}

/**
 * Detect sleep/mute commands — bot should transition to SLEEP state.
 * Works for both pre-wake (no wake word) and post-wake contexts.
 * Includes compound sign-offs: "sounds good jarvis", "thanks, talk to you later"
 * Extra patterns from SLEEP_WORDS env var are appended at first call.
 * @param {string} text - Cleaned transcript text
 * @returns {boolean} true if this is a sleep command
 */
export function shouldSleep(text) {
  const clean = text.toLowerCase().replace(/[.,!?']/g, '').trim();
  if (SLEEP_PATTERNS.some(p => p.test(clean))) return true;
  if (getExtraSleepPatterns().some(p => p.test(clean))) return true;

  // Compound sign-off: gratitude/acknowledgment + closer/name, max 8 words
  // "sounds good jarvis" / "thanks jarvis talk to you later" / "sounds good thank you"
  const words = clean.split(/\s+/);
  if (words.length <= 8 && SIGNOFF_COMPOUND.test(clean) && SIGNOFF_CLOSER.test(clean)) {
    return true;
  }
  return false;
}

const STOP_WORDS_EXACT = new Set([
  'thanks', 'thank you', 'cheers',
  'got it', 'okay', 'ok', 'alright', 'all right',
  'never mind', 'nevermind', 'forget it', 'forget about it',
  'that will be all',
  'stop', 'cancel', 'shut up', 'enough', 'quiet',
  'cool', 'great', 'perfect', 'nice', 'good', 'fine',
  'yes', 'no', 'yep', 'nope', 'yeah', 'nah',
  'later', 'peace', 'right', 'sure', 'fair enough',
  'no worries', 'no problem', 'all good', 'my bad',
  'roger', 'roger that', 'copy', 'copy that', 'word',
  'noted', 'bet', 'see you', 'see ya',
  'obviously',
]);

const STOP_PREFIXES = [
  'sounds good', 'no worries', 'all good', 'thats fine',
  'that works', 'works for me', 'fair enough', 'good enough',
  'okay cool', 'ok cool', 'alright cool',
  'cool cool', 'right on', 'appreciate it',
  'ill handle', 'ill take care', 'ill fix', 'ill do',
  'let me handle', 'let me take', 'let me fix', 'let me do',
  'im going to', 'im gonna', 'i will',
  'i got it', 'i got this',
  'no thats', 'nah thats', 'yeah thats',
  'never mind', 'nevermind',
];

/**
 * Detect dismissal phrases — acknowledgments/stop words that need no response.
 * Length-gated: prefix matches only fire for short utterances (<=5 words).
 * "no actually can you check something" won't be dismissed.
 * @param {string} text - Cleaned transcript (post wake-word strip)
 * @returns {{ dismiss: boolean, reason?: string }}
 */

// Phrases that explicitly signal the speaker was talking to themselves — not directing Jarvis.
// Silently dropped regardless of utterance length or whether a wake word was used.
const SELF_TALK_RE = /\b(i(?:'m| am| was)(?: just)? talking to (my|our)self|talking to (my|our)self|never mind[, ]+i was talking to myself|sorry[, ]+i was talking to myself|i(?:'m| am) just talking to myself)\b/i;

export function shouldDismiss(text) {
  const clean = text.toLowerCase().replace(/[.,!?']/g, '').trim();
  const words = clean.split(/\s+/);
  // Self-talk: speaker was not addressing Jarvis — always silent, no word-count gate
  if (SELF_TALK_RE.test(clean)) return { dismiss: true, reason: 'self-talk' };
  if (STOP_WORDS_EXACT.has(clean)) return { dismiss: true, reason: 'stop-word' };
  if (getExtraStopWords().includes(clean)) return { dismiss: true, reason: 'stop-word-extra' };
  if (words.length <= 5 && STOP_PREFIXES.some(p => clean.startsWith(p))) {
    return { dismiss: true, reason: 'stop-prefix' };
  }
  if (words.length <= 5 && getExtraStopPrefixes().some(p => clean.startsWith(p))) {
    return { dismiss: true, reason: 'stop-prefix-extra' };
  }
  return { dismiss: false };
}

const SIDE_TALK_RE = /^(yeah|no|uh huh|mm hmm|right|okay|sure|got it|yep|nope|exactly|totally|absolutely|definitely|seriously|honestly|literally|basically|i know|i mean|i think|i guess|you know|oh really|oh wow|oh no|oh my god|oh man|for real|same|true|facts|fair|word|bet|to me|for me|i said|i was|he was|she was|they were|we were|it was|that was|this is|thats|oh yeah|uh oh|hmm|thank you|thanks|you too|good job|nice|cool|interesting|wow|huh|nah|yeah yeah|no no|alright|of course|of course not|sorry|my bad|no worries|no problem|sounds good|makes sense|got it|understood|noted|okay okay|mm|mhm|uh|um|ah|oh|yup|nope nope|right right)\b/i;

// Task verbs — any utterance containing these is likely a real command, not side-talk
// TASK_VERB_RE: wake word variants injected dynamically, no hardcoded names
const _taskWakePattern = _wakeVariants.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const TASK_VERB_RE = new RegExp(`\\b(check|search|find|look up|run|send|cancel|delete|remove|create|make|set|get|show|tell|read|write|update|fix|open|close|start|stop|play|pause|remind|schedule|call|move|list|pull|push|deploy|test|build|monitor|scan|add|help|explain|summarize|what is|whats|what are|how do|why did|when is|where is|who is|can you|could you|would you|do you|is there|any emails|any meetings|how many|how much|${_taskWakePattern}|hey)\\b`, 'i');

// Max word count for coherence gate — fragments this short with no task verb are background chatter
const COHERENCE_MAX_WORDS = 8;

/**
 * Detect side-talk — short non-directed speech in conversation window bypass.
 * Only triggers when wake word was NOT used and utterance is short.
 *
 * Two layers:
 * 1. SIDE_TALK_RE: explicit filler/social phrases (always active)
 * 2. Coherence gate: short fragment (≤8 words) with no task verb = background noise, drop silently
 *    — SKIPPED when inConversationWindow is true (short follow-up replies are legitimate)
 *
 * @param {string} text - Cleaned transcript
 * @param {boolean} wakeWordUsed - Whether wake word was literally spoken
 * @param {boolean} [inConversationWindow=false] - Whether we're inside an active conversation window
 * @returns {boolean} true if this is side-talk to be dropped
 */
export function isSideTalk(text, wakeWordUsed, inConversationWindow = false) {
  if (wakeWordUsed) return false;
  if (text.length >= 60) return false;
  const clean = text.toLowerCase().replace(/[.,!?']/g, '').trim();

  // Layer 1: explicit side-talk phrases
  // Inside a conversation window, only drop if the ENTIRE utterance is a filler phrase
  // (no follow-up question or task content appended after the filler)
  if (SIDE_TALK_RE.test(clean)) {
    if (inConversationWindow) {
      // Check if there's anything meaningful after the matched filler
      const words = clean.split(/\s+/).filter(Boolean);
      const hasFollowUp = words.length > 3 || clean.includes('?') || TASK_VERB_RE.test(clean);
      if (hasFollowUp) return false; // Let it through — "sounds good, how are you doing?" is real
    } else {
      return true;
    }
    return true; // Pure filler even in conv window
  }

  // Layer 2: coherence gate — short fragment with no task verb → background noise
  // Skip this gate when in conversation window: "what about Tuesday?" is a legitimate follow-up
  if (!inConversationWindow) {
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length <= COHERENCE_MAX_WORDS && !TASK_VERB_RE.test(clean)) return true;
  }

  return false;
}

// ── Task Content Detection ───────────────────────────────────────────────────
// Used by two-tier sleep detection: if a sleep phrase co-occurs with task content,
// execute the task first, then auto-sleep after the response completes.
// e.g. "sounds good jarvis, now check my email" → dispatch task, auto-sleep after.

const TASK_VERBS = /\b(check|search|find|look up|run|send|cancel|delete|remove|create|make|set|get|show|tell|read|write|update|fix|open|close|start|stop|play|pause|remind|schedule|call|move|list|pull|push|deploy|test|build|monitor|scan|add|help|explain|summarize|what is|whats|what are|how do|why did|when is|where is|who is|can you|could you|would you|do you|is there|any emails|any meetings|how many|how much)\b/i;

/**
 * Detect whether an utterance contains actionable task content beyond a sign-off.
 * Used to distinguish "we're good" (standalone sleep) from
 * "we're good, now check my email" (task + auto-sleep).
 * @param {string} text - Full utterance text
 * @returns {boolean} true if task content is detected
 */
export function hasTaskContent(text) {
  const clean = text.toLowerCase().replace(/[.,!?']/g, '').trim();
  return TASK_VERBS.test(clean);
}

// ── Response Budgeting ───────────────────────────────────────────────────────

/**
 * Classify user intent and determine response budget
 * 
 * @param {Object} signals - Input signals for classification
 * @param {string} signals.transcript - The user's words
 * @param {number} signals.speechDurationMs - How long they spoke
 * @param {number} signals.conversationDepth - Number of turns in current conversation
 * @param {boolean} signals.isFollowUp - Whether inside conversation window
 * @param {string|null} signals.previousResponseType - What kind of response we gave last
 * 
 * @returns {Object} Classification result with budget instructions
 */
export function classifyIntent(signals) {
  const {
    transcript,
    speechDurationMs = 0,
    conversationDepth = 0,
    isFollowUp = false,
    previousResponseType = null,
  } = signals;
  
  const lower = transcript.toLowerCase();
  const wordCount = transcript.split(/\s+/).length;
  
  // ── 0. SCHEDULER intents — must be checked before other patterns ────
  if (/every\s+\d+\s*(second|minute|hour|min|sec|s|m|h)s?/i.test(lower) &&
      /(check|monitor|watch|run|poll|ping|test)\b/i.test(lower)) {
    return buildBudget('RECURRING_CHECK', {
      maxSentences: 1,
      maxSpokenSeconds: 3,
      responseStyle: 'ack',
      spillover: false,
      budgetInstruction: 'SCHEDULER: User wants a recurring check. Parse interval and task, confirm the schedule in one sentence.',
    });
  }

  if (/\b(list|show|what)\b.{0,30}\bschedules?\b/i.test(lower) ||
      /\bschedules?\s+(are\s+)?(running|active|pending)\b/i.test(lower)) {
    return buildBudget('LIST_SCHEDULES', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'concise-answer',
      spillover: false,
      budgetInstruction: 'SCHEDULER: List active schedules.',
    });
  }

  if (/\b(stop|cancel|remove|delete)\b.{0,30}\bschedule\b/i.test(lower)) {
    return buildBudget('DELETE_SCHEDULE', {
      maxSentences: 1,
      maxSpokenSeconds: 3,
      responseStyle: 'ack',
      spillover: false,
      budgetInstruction: 'SCHEDULER: Remove the specified schedule.',
    });
  }

  // ── 1. ADMIN_CMD - Model switching, exec, meta commands ─────────────
  // These are high-priority overrides — must be checked first
  
  // Model switching: "use opus", "switch to sonnet", "use haiku"
  if (lower.match(/\b(use|switch to|change to|go to)\s+(opus|sonnet|haiku|advanced|basic|default)\b/)) {
    return buildBudget('ADMIN_CMD', {
      maxSentences: 1,
      maxSpokenSeconds: 3,
      responseStyle: 'ack',
      spillover: false,
      budgetInstruction: 'ADMIN COMMAND: Model switch requested. Switch the model, then confirm in ONE sentence. Example: "Switched to Opus." Do NOT explain what the model is or what it does.',
      meta: { action: 'model_switch' },
    });
  }
  
  // Exec/shell commands: "exec [command]", "run command [x]"
  if (lower.match(/^exec\s/) || lower.match(/\b(run command|execute command|shell|terminal|bash)\b/)) {
    return buildBudget('ADMIN_CMD', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'ack',
      spillover: true,
      spilloverHint: 'post command output to Discord text',
      budgetInstruction: 'ADMIN COMMAND: Shell/exec command. Execute silently, confirm result in 1-2 sentences. Post full output to text channel. Example: "Done. Service restarted, no errors." Never read command output aloud.',
      meta: { action: 'exec' },
    });
  }
  
  // Admin commands: "admin [x]", "config [x]", "restart [service]"
  if (lower.match(/^admin\s/) || lower.match(/\b(gateway config|jarvis config|restart gateway|restart service|check status|system status|health check|update jarvis)\b/)) {
    return buildBudget('ADMIN_CMD', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'ack',
      spillover: true,
      spilloverHint: 'post details to Discord text',
      budgetInstruction: 'ADMIN COMMAND: System administration task. Execute the command, confirm result briefly. Post full details to text if verbose output. Example: "Gateway restarted. All services healthy."',
      meta: { action: 'admin' },
    });
  }
  
  // Self-reflect: "self reflect", "reflect on [x]"
  if (lower.match(/\b(self reflect|reflect on|optimize|what did we learn|lessons learned)\b/)) {
    return buildBudget('ADMIN_CMD', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'ack',
      spillover: true,
      spilloverHint: 'post reflection to Discord text',
      budgetInstruction: 'ADMIN COMMAND: Self-reflection requested. Use the self-reflect skill. Acknowledge briefly in voice, post full reflection to text. Example: "Reflecting on that now. I\'ll post the analysis to text."',
      meta: { action: 'self_reflect' },
    });
  }
  
  // ── 1b. NOTIFY_DELEGATE - "let me know when done" / "DM me" / async task patterns
  // These ALWAYS force delegation to background agent + DM notification
  // Must be checked early — before QUERY swallows them
  if (lower.match(/\b(let me know|notify me|dm me|message me|alert me|ping me|tell me when|text me)\b/) &&
      lower.match(/\b(when|once|after|if|done|ready|finished|complete|available|it's out|it drops)\b/)) {
    return buildBudget('ACTION', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'ack',
      spillover: true,
      spilloverHint: 'DM user when task completes',
      budgetInstruction: 'ASYNC TASK: User wants to be notified when something completes. Acknowledge in 1-2 sentences. Delegate the work to background, then DM user with results when done. Example: "Got it. I\'ll DM you when it\'s ready."',
      meta: { action: 'notify_delegate', forceDelegation: true },
    });
  }

  // "Monitor X" / "keep an eye on" / "watch for" — async monitoring patterns
  if (lower.match(/\b(monitor|keep an eye on|watch for|watch this|keep track|keep watching|stay on top of|follow up on this)\b/) &&
      !lower.match(/^(what|how|is|are|did|does|can)\b/)) {
    return buildBudget('ACTION', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'ack',
      spillover: true,
      spilloverHint: 'DM user when monitoring detects change',
      budgetInstruction: 'MONITOR TASK: User wants ongoing monitoring. Set up the check, store a reminder in haivemind, and DM user when the condition is met. Acknowledge in 1-2 sentences. Example: "Monitoring it. I\'ll DM you when there\'s a change."',
      meta: { action: 'monitor_delegate', forceDelegation: true },
    });
  }

  // "Do X and let me know" / "grab X and DM me" — compound action + notify
  if (lower.match(/\b(and|then)\s+(let me know|notify me|dm me|message me|ping me|tell me)\b/)) {
    return buildBudget('ACTION', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'ack',
      spillover: true,
      spilloverHint: 'DM user when task completes',
      budgetInstruction: 'ASYNC TASK: User wants work done and notification on completion. Do the work in background, DM user when done. Acknowledge in 1-2 sentences. Example: "On it. I\'ll DM you when it\'s done."',
      meta: { action: 'notify_delegate', forceDelegation: true },
    });
  }

  // ── 2. CHAT - Greetings, small talk, short responses ────────────────
  if (lower.match(/^(hello|hey|hi|good morning|good evening|yo|sup|what's up|how are you|thanks|thank you|cheers|appreciated|nice|cool|great|awesome)(\s|$)/) ||
      (lower.match(/^(ok|okay|sure|alright)(\s|$)/) && wordCount <= 3)) {
    return buildBudget('CHAT', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'conversational',
      spillover: false,
      budgetInstruction: 'RESPONSE BUDGET: Casual exchange. Match their energy. 1-2 sentences max. Be warm but brief.',
    });
  }
  
  // ── 3. EMAIL_DETAIL - Follow-up detail request after SUMMARIZE ──────
  if (isFollowUp && previousResponseType === 'SUMMARIZE') {
    if ((lower.match(/\b(tell me|read|details|detail|what about|open)\b/) || lower.includes('more')) &&
        (lower.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|one|email)\b/) ||
         lower.match(/\b(legal|urgent|marketing|sales|newsletter|contract|review|project|that|about)\b/))) {
      return buildBudget('EMAIL_DETAIL', {
        maxSentences: 6,
        maxSpokenSeconds: 20,
        responseStyle: 'detailed-single',
        spillover: false,
        budgetInstruction: 'EMAIL DETAIL MODE: User wants full details on a specific email from the previous summary. Instructions: 1. Identify which email they\'re referring to using conversation context. 2. Fetch the full email content. 3. Speak: sender name, subject, key points from body, and any attachments. 4. Keep it conversational but thorough - up to 6 sentences. Example: "Legal email from Jane Doe about the vendor agreement. She needs contract review by Friday. Three documents attached: master agreement, SOW, and amendment. Marked urgent because legal deadline is approaching. Want me to forward it to someone?"',
      });
    }
  }
  
  // ── 4. FOLLOW_UP - Continuation phrases ─────────────────────────────
  if (isFollowUp && lower.match(/^(yes|yeah|yep|yup|no|nope|nah|go ahead|do it|proceed|continue|the first one|first one|second one|that one|more|tell me more|anything else|what else)/)) {
    const prevStyle = previousResponseType || 'QUERY';
    const maxSentences = prevStyle === 'DEEP_DIVE' ? 6 : prevStyle === 'LIST_QUERY' ? 4 : 3;
    
    return buildBudget('FOLLOW_UP', {
      maxSentences,
      maxSpokenSeconds: prevStyle === 'DEEP_DIVE' ? 20 : 10,
      responseStyle: 'continuation',
      spillover: prevStyle === 'DEEP_DIVE',
      budgetInstruction: `RESPONSE BUDGET: Continuation. Match the detail level of what came before (previous was ${prevStyle}). If they said 'yes' to an offer, deliver concisely. If they want 'more', provide the next level of detail.`,
    });
  }
  
  // ── 5. EMAIL_SUMMARY - Inbox summary requests ───────────────────────
  // Only match broad inbox queries, NOT "any emails from [person]" or "read [specific] email"
  if ((lower.match(/\b(summarize|summary|quick rundown)\b/) && lower.match(/\b(emails?|inbox|messages?)\b/)) ||
      (lower.match(/\b(what's in my|what is in my|check my)\b/) && lower.match(/\b(emails?|inbox)\b/)) ||
      (lower.match(/\b(any (new |urgent |important )?emails?)\b/) && !lower.match(/\b(from|about|regarding)\b/)) ||
      (lower.match(/\b(read my)\b/) && lower.match(/\b(inbox|emails)\b/) && !lower.match(/\b(latest|last|recent|first)\b/))) {
    return buildBudget('SUMMARIZE', {
      maxSentences: 8,
      maxSpokenSeconds: 25,
      responseStyle: 'brief-summary',
      spillover: false,
      budgetInstruction: 'VOICE SUMMARY MODE: Email inbox summary requested. Instructions: 1. Fetch recent unread emails (use google-workspace MCP or GAM). 2. For each email, provide ONE sentence: "[Sender] about [subject/topic]". 3. Max 5-7 emails spoken. 4. End with: "Want details on any of these?". 5. Keep it BRIEF - one sentence per email, no elaboration. Example output: "You have 8 unread. Here\'s the top 5: First: John from sales about Q1 revenue numbers. Second: Marketing team about the new campaign launch. Third: Legal about contract review - marked urgent. Fourth: Newsletter from TechCrunch. Fifth: Project manager about project status. Want details on any of these?"',
    });
  }
  
  // ── 6. EMAIL_ACTION - Reply, forward, compose, flag ─────────────────
  if (lower.match(/\b(reply to|respond to|write back|forward|compose|draft|send an? email|email .+ about|flag|star|mark as|snooze|archive|delete)\b/) &&
      lower.match(/\b(email|message|mail|that|it|this|them)\b/)) {
    return buildBudget('EMAIL_ACTION', {
      maxSentences: 3,
      maxSpokenSeconds: 10,
      responseStyle: 'brief-confirm',
      spillover: true,
      spilloverHint: 'post email draft/details to Discord text',
      budgetInstruction: 'EMAIL ACTION: User wants to act on email. Execute the action (reply, forward, compose, flag, etc.). For compose/reply: draft the content and confirm verbally in 1-2 sentences. For flag/archive/delete: do it silently, confirm. Example compose: "I\'ve drafted a reply to Jane about the contract. Want me to send it or post the draft for review?" Example flag: "Done. Flagged as urgent."',
    });
  }
  
  // ── 7. EMAIL_QUERY - Questions about specific emails ────────────────
  if (lower.match(/\b(emails?|messages?|mail)\b/) &&
      (lower.match(/\b(from|about|regarding|subject|did .+ send|did .+ email|have I got)\b/) ||
       lower.match(/\b(what did .+ say|what's .+ email|read .+ email|latest from|read my latest|read my last|read my recent|any .+ from)\b/))) {
    return buildBudget('EMAIL_QUERY', {
      maxSentences: 5,
      maxSpokenSeconds: 15,
      responseStyle: 'concise-answer',
      spillover: false,
      budgetInstruction: 'EMAIL QUERY: User asking about specific email(s). Search emails using google-workspace MCP or GAM. Answer concisely: sender, subject, key content. Max 5 sentences. Example: "Yes, you got an email from John at 2pm about the Q1 numbers. He\'s asking for your review by Friday. Three attachments: spreadsheet, deck, and summary."',
    });
  }
  
  // ── 8. CALENDAR - Calendar queries and actions ──────────────────────
  
  // Calendar queries: "what's on my calendar", "next meeting", "am I free at"
  // Also catch standalone availability questions without "calendar" keyword
  if ((lower.match(/\b(calendar|schedule|meetings?|events?|appointments?)\b/) &&
      (lower.match(/\b(what's|what is|do i have|any|show|next|today|tomorrow|this week|tonight|morning|afternoon)\b/) ||
       lower.match(/\b(am i free|am i busy|available at|open at|free at|block off|when is|what time)\b/))) ||
      lower.match(/\b(am i free|am i busy|what's my next meeting|when's my next|do i have any meetings|any meetings)\b/)) {
    return buildBudget('CALENDAR', {
      maxSentences: 5,
      maxSpokenSeconds: 15,
      responseStyle: 'concise-answer',
      spillover: false,
      budgetInstruction: 'CALENDAR QUERY: Check calendar using google-workspace MCP. Be specific: time, title, attendees. For "am I free" questions, answer yes/no first, then details. Example: "You have 3 meetings today. 10am standup with engineering, 1pm review with a colleague, and 4pm call with the client. You\'re free between 2 and 4." For availability: "Yes, you\'re free at 3pm. Your next meeting is at 4."',
    });
  }
  
  // Calendar actions: "schedule a meeting", "cancel my 3pm", "move my meeting"
  if ((lower.match(/\b(calendar|meeting|event|appointment)\b/) &&
      lower.match(/\b(schedule|book|set up|create|cancel|move|reschedule|postpone|push back|block off|add|invite)\b/)) ||
      (lower.match(/\b(cancel|reschedule|postpone|push back|move)\b/) && lower.match(/\b(my |the )?\d+(pm|am|:\d\d)\b/))) {
    return buildBudget('CALENDAR_ACTION', {
      maxSentences: 3,
      maxSpokenSeconds: 10,
      responseStyle: 'brief-confirm',
      spillover: false,
      budgetInstruction: 'CALENDAR ACTION: Create, modify, or cancel a calendar event using google-workspace MCP. Always create with attendees if a person is mentioned. Confirm with time, date, and title. Example: "Done. Meeting with the colleague scheduled for Tuesday at 2pm. Calendar invite sent."',
    });
  }
  
  // ── 9. MEMORY_CMD - Remember/recall commands ────────────────────────
  if (lower.match(/\b(remember (this|that)?)\b/) || lower.match(/^remember\s/)) {
    return buildBudget('MEMORY_CMD', {
      maxSentences: 1,
      maxSpokenSeconds: 3,
      responseStyle: 'ack',
      spillover: false,
      budgetInstruction: 'MEMORY STORE: User wants you to remember something. Store it to haivemind immediately and silently. Confirm in ONE sentence. Example: "Got it." Do NOT repeat back what they said or explain where it was stored.',
      meta: { action: 'remember' },
    });
  }
  
  if (lower.match(/\b(recall|do you remember|what did i say about|what was that)\b/)) {
    return buildBudget('MEMORY_CMD', {
      maxSentences: 4,
      maxSpokenSeconds: 12,
      responseStyle: 'concise-answer',
      spillover: false,
      budgetInstruction: 'MEMORY RECALL: User wants to recall something. Search haivemind for the relevant memory. Answer concisely with what you found. If nothing found, say so briefly. Example: "Yes, you mentioned the deployment deadline is February 15th."',
      meta: { action: 'recall' },
    });
  }
  
  // ── 10. PLAN_CMD - Planning/todo commands ────────────────────────────
  if (lower.match(/\b(plan|todo|to-do|action items|action plan|put together a plan|break down|task list|prioritize)\b/) &&
      (lower.match(/\b(create|make|build|let's|need|start|new)\b/) || wordCount <= 5)) {
    return buildBudget('PLAN_CMD', {
      maxSentences: 3,
      maxSpokenSeconds: 10,
      responseStyle: 'ack-then-work',
      spillover: true,
      spilloverHint: 'post full plan to Discord text',
      budgetInstruction: 'PLAN MODE: User wants a plan or todo list. Switch to Opus for reasoning. Create the plan, store todo list in haivemind, post full plan to text channel. Voice response: brief summary of what you\'re planning. Example: "Building the plan now. I\'ll break it into phases and post it to text."',
      meta: { action: 'plan' },
    });
  }
  
  // ── 11. STUDY_CMD - Deep research/study commands ────────────────────
  // Only when it's a standalone research request, NOT delegation structures like "I need you to investigate"
  if (lower.match(/\b(study|research|deep dive into|look into|dig into)\b/) &&
      lower.match(/\b(the|this|that|how|why|about)\b/) &&
      !lower.match(/\b(emails?|inbox|messages?)\b/) &&
      !lower.match(/^(i need you to|can you please|go ahead and|let's)/)) {
    return buildBudget('STUDY_CMD', {
      maxSentences: 2,
      maxSpokenSeconds: 5,
      responseStyle: 'ack-then-work',
      spillover: true,
      spilloverHint: 'post full study/research to Discord text',
      budgetInstruction: 'STUDY MODE: User wants deep research on a topic. Acknowledge briefly, then do the research thoroughly in background. Post full findings to text channel. Voice: brief ack only. Example: "On it. I\'ll research that and post findings to text."',
      meta: { action: 'study' },
    });
  }
  
  // ── 12. QUERY - Information requests ────────────────────────────────
  // Check BEFORE ACTION to catch questions with action verbs
  // But AFTER email/calendar/memory specific queries
  if (lower.match(/\b(what|when|where|who|which|how many|how much|is there|do i have|did|does|can you|could you|would you|any|find|status|how's|how is)\b/) ||
      lower.match(/\?$/)) {
    
    // But NOT if it starts with delegation structures
    if (!lower.match(/^(go ahead|let's|i need you to|can you please|would you mind)/)) {
      return buildBudget('QUERY', {
        maxSentences: 4,
        maxSpokenSeconds: 12,
        responseStyle: 'concise-answer',
        spillover: false,
        budgetInstruction: 'RESPONSE BUDGET: Direct query. Answer in ≤4 sentences. Lead with the answer, not "Let me check." If listing items, max 3 spoken, then say how many more and offer details. Example: "Yes, 2 meetings today. 2pm standup and 4pm review. Both in conference room A."',
      });
    }
  }
  
  // ── 13. ACTION - Task execution commands (expanded) ─────────────────
  // Full verb list from communication pattern study
  if (lower.match(/\b(clean|archive|delete|remove|send|post|message|move|schedule|remind|set up|create|add|update|cancel|clear|mark|flag|snooze|forward|reply|draft|setup|configure|install|deploy|run|execute|start|stop|restart|kill|check out|clone|pull|push|commit|merge|build|implement|migrate|refactor|fix|debug|organize|generate|compile|prepare|test|apply|sync|document|validate|verify|monitor|track|handle|design|schema|write|review and fix|spin up|tear down|provision|bootstrap|scaffold|wire up|hook up|connect|disconnect|enable|disable|activate|deactivate|publish|release|ship|launch|rollback|revert)\b/)) {
    return buildBudget('ACTION', {
      maxSentences: 3,
      maxSpokenSeconds: 15,
      responseStyle: 'brief-confirm',
      spillover: true,
      spilloverHint: 'post details to Discord text',
      budgetInstruction: 'RESPONSE BUDGET: Action task. Do the work silently. Confirm in ≤3 sentences. Never narrate your process. Just: what you did, the key result, and one follow-up offer if relevant. Example: "Done. Archived 34 emails, 5 need attention. Want the rundown?"',
    });
  }
  
  // Delegation structures that imply ACTION even without matching a verb above
  if (lower.match(/^(go ahead and|let's |i need you to|can you please|would you mind|take care of|handle |get started on|work on|start working on|begin |continue with|proceed with|follow up on|when you get a chance)/)) {
    return buildBudget('ACTION', {
      maxSentences: 3,
      maxSpokenSeconds: 15,
      responseStyle: 'brief-confirm',
      spillover: true,
      spilloverHint: 'post details to Discord text',
      budgetInstruction: 'RESPONSE BUDGET: Delegated action task. User is assigning work. Do the work silently. Confirm in ≤3 sentences. Never narrate your process. Example: "On it. I\'ll handle that and let you know when it\'s done."',
    });
  }
  
  // ── 14. LIST_QUERY - Listing/enumeration requests ───────────────────
  if (lower.match(/\b(list|show me|what's on|what are|tell me about my|give me)\b/) && 
      lower.match(/\b(emails?|messages?|threads?|calendar|events?|meetings?|tasks?|reminders?|notifications?|channels?|servers?|files?|documents?|repos?|branches|issues?|tickets?|PRs?|pull requests?)\b/)) {
    return buildBudget('LIST_QUERY', {
      maxSentences: 4,
      maxSpokenSeconds: 15,
      responseStyle: 'summary-list',
      spillover: true,
      spilloverHint: 'post full list to Discord text',
      budgetInstruction: 'RESPONSE BUDGET: List query. State the count first. Speak top 3-5 items max. If more exist, say "plus N more" and offer to post full list to text. Never read an entire list aloud. Example: "You have 12 unread. Top 3: [item], [item], [item]. Plus 9 more. Want the full list in text?"',
    });
  }
  
  // ── 15. DEEP_DIVE - Detailed explanation requests ───────────────────
  if (lower.match(/\b(explain|walk me through|tell me about|break down|analyze|deep dive|how does|why does|what's the difference|compare|what happened|investigate|research|look into|review|summarize|give me the full|detailed|thorough)\b/)) {
    // Safety net: email/inbox summarize should have been caught earlier
    if (lower.match(/\b(emails?|inbox|messages?)\b/) && lower.match(/\b(summarize|summary)\b/)) {
      return buildBudget('SUMMARIZE', {
        maxSentences: 8,
        maxSpokenSeconds: 25,
        responseStyle: 'brief-summary',
        spillover: false,
        budgetInstruction: 'VOICE SUMMARY MODE: Email inbox summary requested. Fetch and summarize briefly.',
      });
    }
    
    return buildBudget('DEEP_DIVE', {
      maxSentences: 8,
      maxSpokenSeconds: 30,
      responseStyle: 'detailed',
      spillover: true,
      spilloverHint: 'post full analysis to Discord text',
      budgetInstruction: 'RESPONSE BUDGET: Detail requested. Up to 8 sentences OK. Be thorough but still conversational. If very complex, give the verbal summary and offer to post the full analysis to text. Lead with the key insight, then supporting details.',
    });
  }
  
  // ── 16. Duration-Based Fallback ─────────────────────────────────────
  
  if (speechDurationMs < 3000) {
    return buildBudget('QUERY', {
      maxSentences: 3,
      maxSpokenSeconds: 8,
      responseStyle: 'concise-answer',
      spillover: false,
      budgetInstruction: 'RESPONSE BUDGET: Quick query. Very brief response. ≤3 sentences. Lead with the answer.',
    });
  }
  
  if (speechDurationMs > 15000) {
    return buildBudget('QUERY', {
      maxSentences: 6,
      maxSpokenSeconds: 20,
      responseStyle: 'detailed',
      spillover: true,
      spilloverHint: 'post details to Discord text',
      budgetInstruction: 'RESPONSE BUDGET: Thorough question. Match their detail level. Up to 6 sentences spoken. If answer is complex, summarize verbally and offer to post full details to text.',
    });
  }
  
  // Default: moderate query
  return buildBudget('QUERY', {
    maxSentences: 4,
    maxSpokenSeconds: 12,
    responseStyle: 'concise-answer',
    spillover: false,
    budgetInstruction: 'RESPONSE BUDGET: Standard query. Answer in ≤4 sentences. Be direct and clear.',
  });
}

// Intent types that should route to an isolated task agent (full MCP, fresh session)
const TASK_AGENT_INTENTS = new Set([
  'ACTION', 'EMAIL_ACTION', 'EMAIL_QUERY', 'EMAIL_DETAIL',
  'CALENDAR', 'CALENDAR_ACTION', 'SUMMARIZE', 'LIST_QUERY',
  'PLAN_CMD', 'STUDY_CMD', 'DEEP_DIVE',
]);

/**
 * Build a budget response object
 * @private
 */
function buildBudget(type, options) {
  const result = {
    type,
    maxSentences: options.maxSentences || 4,
    maxSpokenSeconds: options.maxSpokenSeconds || 12,
    responseStyle: options.responseStyle || 'concise-answer',
    spillover: options.spillover || false,
    spilloverHint: options.spilloverHint || null,
    budgetInstruction: options.budgetInstruction,
    taskAgent: TASK_AGENT_INTENTS.has(type),
  };

  // Optional metadata for special handling (model switch, exec, etc.)
  if (options.meta) {
    result.meta = options.meta;
  }

  return result;
}
