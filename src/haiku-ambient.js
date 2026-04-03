/**
 * haiku-ambient.js — Ambient Intent Classifier (Haiku-powered)
 *
 * Sits in the speech dispatch pipeline BEFORE the main intent system.
 * Fires only when no wake word was detected — classifies whether an
 * utterance is ambient noise, self-talk, a sleep command, or actually
 * directed at Jarvis.
 *
 * Returns one of five outcomes:
 *   DIRECTED   — utterance is addressed to the bot (fall through to normal processing)
 *   SELF_TALK  — speaker talking to themselves, not the bot (silent ignore)
 *   AMBIENT    — non-language sounds: humming, "hmm", "ugh", filler (silent ignore)
 *   SLEEP      — clear sign-off / dismissal (trigger sleep FSM transition)
 *   UNCERTAIN  — ambiguous — fail-safe: stay quiet
 *
 * FAIL OPEN: on timeout, error, or any ambiguity → UNCERTAIN → silent ignore.
 *
 * ── Active Conversation Window (2026-04-02) ───────────────────────────────────
 * The classifier does NOT fire on every utterance. It only activates when we are
 * inside an "active conversation window" — i.e., within HAIKU_AMBIENT_WINDOW_MS
 * (default: 60000ms = 60s) of the last wake word.
 *
 * Rationale: cost control. We don't want to make a Haiku API call for every ambient
 * sound captured all day. If the user hasn't said "Jarvis" in the last 60 seconds,
 * all no-wake-word utterances are silently ignored — no API call, no classification.
 *
 * The caller (brain.js / index.js) is responsible for passing `lastWakeWordTime`
 * (a Unix timestamp in ms) in the context object. If omitted, the classifier falls
 * back to the old always-on behaviour (for backward compatibility during rollout).
 *
 * Phase gating (HAIKU_AMBIENT_PHASE env var):
 *   Phase 1 — act on AMBIENT only (hmm, ugh, non-language sounds)
 *   Phase 2 — act on AMBIENT + SELF_TALK
 *   Phase 3 — full (all five outcomes active)
 */

import logger from './logger.js';

const GATEWAY_URL = process.env.CLAWDBOT_GATEWAY_URL || process.env.GATEWAY_URL || 'http://127.0.0.1:22100';
const GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN;
const COMPLETIONS_URL = `${GATEWAY_URL}/v1/chat/completions`;

const CLASSIFIER_MODEL = process.env.HAIKU_AMBIENT_MODEL || 'unit/claude-haiku-4-5';
const CLASSIFIER_TIMEOUT_MS = parseInt(process.env.HAIKU_AMBIENT_TIMEOUT_MS || '2000');
const AMBIENT_ENABLED = process.env.HAIKU_AMBIENT_CLASSIFIER_ENABLED === 'true';
const AMBIENT_LOG_DECISIONS = process.env.HAIKU_AMBIENT_LOG_DECISIONS !== 'false'; // default true
const AMBIENT_LOG_CHANNEL = process.env.HAIKU_AMBIENT_LOG_CHANNEL || 'HUD_CHANNEL_ID';
const AMBIENT_PHASE = parseInt(process.env.HAIKU_AMBIENT_PHASE || '1');
// How long after the last wake word the ambient classifier is still active.
// Default: 60s. Set to 0 to disable window-gating (always-on, not recommended).
const AMBIENT_WINDOW_MS = parseInt(process.env.HAIKU_AMBIENT_WINDOW_MS || '60000');

// ── Logging ──────────────────────────────────────────────────────────────────

const GATEWAY_BASE = process.env.CLAWDBOT_GATEWAY_URL || process.env.GATEWAY_URL || 'http://127.0.0.1:22100';
const DISCORD_POST_URL = `${GATEWAY_BASE}/discord/channels/${AMBIENT_LOG_CHANNEL}/messages`;

/**
 * Post a brief decision log entry to the configured Discord channel.
 * Non-blocking — errors are swallowed silently.
 */
async function logDecision(transcript, result, reason) {
  if (!AMBIENT_LOG_DECISIONS) return;
  if (!GATEWAY_TOKEN) return;
  const short = transcript.length > 60 ? transcript.substring(0, 57) + '…' : transcript;
  const content = `[AMBIENT] "${short}" → **${result}** (${reason})`;
  try {
    await fetch(DISCORD_POST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        'X-OpenClaw-Scopes': 'operator.write',
      },
      body: JSON.stringify({ content }),
    });
  } catch {
    // Non-critical — swallow silently
  }
}

// ── System Prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an ambient speech classifier for a voice assistant called Jarvis.

Your job: decide whether a spoken utterance requires Jarvis to respond, or whether it should be silently ignored.

Classify into EXACTLY ONE of these five outcomes:

AMBIENT
  Non-language sounds, filler vocalizations, background noise captured by microphone.
  Examples: "hmm", "mm", "ugh", "ah", humming, breathing sounds, single non-word syllables.
  Rule: if it could have come from ambient audio and carries no communicative intent, it's AMBIENT.

SELF_TALK
  A complete thought addressed to nobody in particular — the speaker is thinking aloud.
  Examples: "yeah exactly", "wait no", "actually...", "oh right", "okay so", "hmm let me think",
  "no that's wrong", "wait what", "oh I see", "interesting", "right right".
  Rule: conversational internal monologue. No request, no question to the bot, no wake word.

SLEEP
  A clear goodbye, dismissal, or sign-off directed at Jarvis (or the room).
  Examples: "good night", "stand down", "that's all", "thanks Jarvis", "goodbye", "we're done".
  Rule: only if it is clearly a dismissal. When in doubt, do NOT classify as SLEEP.

DIRECTED
  The utterance is addressed to the bot, OR contains a question/task the bot should handle.
  Examples: "Jarvis what time is it", "hey what's the weather", "play some music",
  "check my emails", "what was that?", "remind me at 3".
  Rule: wake word present, question addressed to bot, task verb with no self-talk context.

UNCERTAIN
  Ambiguous — could be any of the above. Fail-safe: Jarvis stays quiet.
  Use UNCERTAIN liberally. It is ALWAYS safer than a wrong DIRECTED or SLEEP.

DECISION RULES (apply in order):
1. Empty or whitespace → UNCERTAIN
2. Non-word sounds only (hmm, mm, ugh, ah, huh with no words) → AMBIENT
3. Wake word present → DIRECTED
4. Clear sign-off phrase (goodbye, good night, stand down, that's all) → SLEEP
5. Complete thought with no bot-direction, no question mark, no task verb → SELF_TALK
6. Question ending in "?" with no clear self-talk context → DIRECTED
7. Task verb (check, find, play, send, remind, show, tell, what is, how do) → DIRECTED
8. Everything else → UNCERTAIN

IMPORTANT:
- FAIL OPEN: when uncertain, return UNCERTAIN. Never guess DIRECTED.
- Never return SLEEP unless the sign-off is unambiguous.
- SELF_TALK requires a complete thought — single words are usually AMBIENT.
- Respond ONLY with a JSON object, no markdown, no explanation.

Response format:
{"result": "<AMBIENT|SELF_TALK|SLEEP|DIRECTED|UNCERTAIN>", "reason": "<one short phrase>"}`;

// ── Phase Gating ──────────────────────────────────────────────────────────────

/**
 * Apply phase-based gating to the raw classifier result.
 * Phase 1: only act on AMBIENT (everything else falls through as null)
 * Phase 2: act on AMBIENT + SELF_TALK
 * Phase 3: full — all five outcomes active
 *
 * Returns the effective result to act on, or null if the result should
 * fall through to existing logic unchanged.
 */
function applyPhaseGating(result) {
  if (AMBIENT_PHASE >= 3) return result; // Full phase — all outcomes
  if (AMBIENT_PHASE >= 2) {
    // Phase 2: AMBIENT + SELF_TALK are actionable; SLEEP + DIRECTED + UNCERTAIN fall through
    if (result === 'AMBIENT' || result === 'SELF_TALK') return result;
    return null;
  }
  // Phase 1 (default): only AMBIENT is actionable
  if (result === 'AMBIENT') return result;
  return null;
}

// ── Classifier ────────────────────────────────────────────────────────────────

/**
 * Classify an utterance's ambient intent using Haiku.
 *
 * @param {string} transcript - The raw STT transcript (pre wake-word strip)
 * @param {object} [context] - Optional context signals
 * @param {boolean} [context.wakeWordDetected] - Whether a wake word was found (should be false here)
 * @param {number}  [context.wordCount] - Word count of the transcript
 * @param {boolean} [context.hasTaskVerb] - Whether transcript contains a task verb
 * @param {boolean} [context.isQuestion] - Whether transcript ends with ?
 * @param {string[]} [context.recentHistory] - Last 2-3 user utterances + bot responses
 *
 * @returns {Promise<'DIRECTED'|'SELF_TALK'|'AMBIENT'|'SLEEP'|'UNCERTAIN'>}
 *   Always returns a string — never throws. Defaults to UNCERTAIN on any failure.
 */
export async function classifyAmbient(transcript, context = {}) {
  // Guard: only run when enabled
  if (!AMBIENT_ENABLED) return 'DIRECTED'; // Pass through if disabled

  // Guard: empty transcript
  if (!transcript || !transcript.trim()) {
    logger.debug('[haiku-ambient] Empty transcript → UNCERTAIN');
    return 'UNCERTAIN';
  }

  // Guard: no gateway token
  if (!GATEWAY_TOKEN) {
    logger.warn('[haiku-ambient] No gateway token — UNCERTAIN (fail open)');
    return 'UNCERTAIN';
  }

  const {
    wakeWordDetected = false,
    wordCount = transcript.split(/\s+/).filter(Boolean).length,
    hasTaskVerb = false,
    isQuestion = /\?\s*$/.test(transcript.trim()),
    recentHistory = [],
    lastWakeWordTime = null,  // Unix timestamp (ms) of the most recent wake word event
  } = context;

  // Fast path: wake word present → always DIRECTED (caller should handle this,
  // but defend against being called with wake word anyway)
  if (wakeWordDetected) {
    return 'DIRECTED';
  }

  // ── Active Conversation Window Guard ────────────────────────────────────────
  // Only fire the classifier when we are within AMBIENT_WINDOW_MS of the last
  // wake word. Outside this window every utterance is silently dropped — no API
  // call, no cost. If AMBIENT_WINDOW_MS=0 the guard is disabled (always-on).
  //
  // `lastWakeWordTime` must be passed by the caller (brain.js / index.js).
  // If it is not provided we skip the guard for backward-compat, but log a
  // warning so the caller can be updated.
  if (AMBIENT_WINDOW_MS > 0) {
    if (lastWakeWordTime === null) {
      logger.warn('[haiku-ambient] lastWakeWordTime not provided — window guard skipped (update caller)');
    } else {
      const msSinceWakeWord = Date.now() - lastWakeWordTime;
      if (msSinceWakeWord > AMBIENT_WINDOW_MS) {
        logger.debug(`[haiku-ambient] Outside active window (${Math.round(msSinceWakeWord / 1000)}s since wake word, limit ${AMBIENT_WINDOW_MS / 1000}s) → silent ignore`);
        return 'UNCERTAIN'; // Treat as UNCERTAIN so existing logic stays quiet
      }
    }
  }

  // Build the user message for the classifier
  const historySection = recentHistory.length > 0
    ? `\nRECENT HISTORY (last ${recentHistory.length} exchanges):\n${recentHistory.map((h, i) => `  ${i + 1}. ${h}`).join('\n')}`
    : '';

  const userMessage = [
    `TRANSCRIPT: "${transcript}"`,
    `WORD_COUNT: ${wordCount}`,
    `WAKE_WORD_DETECTED: ${wakeWordDetected}`,
    `HAS_TASK_VERB: ${hasTaskVerb}`,
    `IS_QUESTION: ${isQuestion}`,
    historySection,
  ].filter(Boolean).join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);

  try {
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        'X-OpenClaw-Scopes': 'operator.write',
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 80,
        model: CLASSIFIER_MODEL,
        user: 'jarvis-voice-ambient-classifier',
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text();
      logger.warn(`[haiku-ambient] Gateway ${res.status}: ${body.substring(0, 100)} → UNCERTAIN`);
      return 'UNCERTAIN';
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      logger.warn('[haiku-ambient] Empty response → UNCERTAIN');
      return 'UNCERTAIN';
    }

    // Parse JSON — handle potential markdown wrapping
    const jsonStr = content.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(jsonStr);

    const VALID_RESULTS = new Set(['DIRECTED', 'SELF_TALK', 'AMBIENT', 'SLEEP', 'UNCERTAIN']);
    const rawResult = parsed.result?.toUpperCase();
    const reason = parsed.reason || 'no reason';

    if (!rawResult || !VALID_RESULTS.has(rawResult)) {
      logger.warn(`[haiku-ambient] Unknown result "${rawResult}" → UNCERTAIN`);
      return 'UNCERTAIN';
    }

    // Apply phase gating — may convert to null (fall through)
    const effectiveResult = applyPhaseGating(rawResult);
    const phaseNote = effectiveResult === null
      ? ` [phase ${AMBIENT_PHASE}: gated out, fall-through]`
      : '';

    logger.info(`[haiku-ambient] "${transcript.substring(0, 50)}" → ${rawResult}${phaseNote} (${reason})`);

    // Log to Discord (non-blocking)
    logDecision(transcript, rawResult + phaseNote, reason);

    // If phase gating neutralized the result, return DIRECTED so existing logic handles it
    if (effectiveResult === null) return 'DIRECTED';
    return effectiveResult;

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      logger.warn(`[haiku-ambient] Timed out after ${CLASSIFIER_TIMEOUT_MS}ms → UNCERTAIN`);
    } else if (err instanceof SyntaxError) {
      logger.warn('[haiku-ambient] Failed to parse JSON response → UNCERTAIN');
    } else {
      logger.warn(`[haiku-ambient] Error: ${err.message} → UNCERTAIN`);
    }
    return 'UNCERTAIN';
  }
}

/**
 * Check whether the ambient classifier is enabled and active.
 * Used by index.js to guard the integration point.
 */
export function isAmbientClassifierEnabled() {
  return AMBIENT_ENABLED;
}

/**
 * Return the current phase (1/2/3) for diagnostic use.
 */
export function getAmbientPhase() {
  return AMBIENT_PHASE;
}
