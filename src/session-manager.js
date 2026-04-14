/**
 * Session Manager — rotating gateway session keys with haivemind-backed memory.
 *
 * Why: The OpenClaw gateway session accumulates ALL tool call results and
 * history unbounded. After 15+ voice tasks the context window balloons and
 * inference slows from 7s → 130s. Rotating the session key gives a fresh
 * context window. haivemind stores the memory so nothing is lost.
 *
 * Rotation trigger: idle gap (default 30 min). Active conversations never
 * get interrupted — only fires on next turn after silence.
 *
 * Memory strategy on session rotation (B → A fallback):
 *   B (primary): Inject the last N turns of the local conv.history — exact,
 *     chronological, zero hallucination risk. Available for mid-session rotations.
 *   A (fallback): Query haivemind with a prefix-anchored "VOICE-SESSION-END" query
 *     (not semantic). Returns actual stored session summaries sorted by recency.
 *     Used on fresh boots or when local history is empty.
 */
import { exec as _exec } from 'child_process';
import { promisify } from 'util';
import logger from './logger.js';

const execAsync = promisify(_exec);

/** How long idle before rotating on next turn (ms). Override via .env */
const IDLE_ROTATION_MS = parseInt(process.env.SESSION_ROTATION_IDLE_MS ?? '1800000'); // 30 min (was 5 min)

const SESSION_BASE = process.env.SESSION_USER || 'jarvis-voice-user';

let _suffix   = '';            // empty = use base name (initial session)
let _lastActivity = Date.now();
let _newSession   = false;     // true once after a rotation — consumed once

// ── Public API ───────────────────────────────────────────────────────────────

/** Returns the current active session user key to pass to the gateway */
export function getActiveSessionUser() {
  return _suffix ? `${SESSION_BASE}-${_suffix}` : SESSION_BASE;
}

/** Call at the start of every voice turn to track activity */
export function touchActivity() {
  _lastActivity = Date.now();
}

/**
 * Returns true once after a session rotation (consumed on read).
 * Use to decide whether to seed the new session with haivemind context.
 */
export function consumeNewSessionFlag() {
  const v = _newSession;
  _newSession = false;
  return v;
}

/**
 * Returns and clears the history stash from the previous session.
 * Used by getHaivemindContext() Option B to seed the new session with exact
 * chronological context from the rotated session, consumed once.
 */
export function consumeRotatedHistory() {
  const h = _rotatedHistory;
  _rotatedHistory = [];
  return h;
}

/**
 * Check if idle threshold exceeded. If so, store session summary to haivemind
 * and rotate the session key. Returns true if rotated.
 * @param {Array} history - local conversation history for summary storage
 */
export async function maybeRotateSession(history = []) {
  const idleMs = Date.now() - _lastActivity;
  if (idleMs < IDLE_ROTATION_MS) return false;

  logger.info({ idleMs: Math.round(idleMs / 1000) }, '🔄 Idle threshold hit — rotating gateway session');

  // Store summary to haivemind BEFORE rotating (Option A fallback for future boots)
  if (history.length > 0) {
    await _storeSessionSummary(history);
  }

  // Stash the history snapshot so getHaivemindContext() (Option B) can use it
  // on the very next turn after rotation, before local history fills back up.
  _rotatedHistory = history.slice(-6);

  _suffix     = Date.now().toString(36);
  _newSession = true;
  logger.info(`🔄 New session key: ${getActiveSessionUser()}`);
  return true;
}

// Stash of the last session's history for seeding the new session (Option B)
let _rotatedHistory = [];

/**
 * Store a completed task summary to haivemind.
 * Fire-and-forget — never blocks voice latency.
 */
export async function storeTaskToHaivemind(taskId, userMessage, spokenResult) {
  const ts         = new Date().toISOString().substring(0, 16);
  const userSnip   = (userMessage   || '').substring(0, 120);
  const resultSnip = (spokenResult  || '').substring(0, 200);
  const content    = `VOICE-TASK ${ts} task=${taskId}: request="${userSnip}" spoken="${resultSnip}"`;
  await _haivemindStore(content, 'voice-session');
}

/**
 * Fetch recent voice session context as a compact string for injection into new sessions.
 *
 * Strategy B → A fallback:
 *   B (primary): Use local conv.history from the just-ended session — exact chronological
 *     turns, no semantic search, no hallucination risk. formatHistoryContext() extracts
 *     the last N user turns as a compact summary.
 *   A (fallback): Query haivemind using the prefix-anchored "VOICE-SESSION-END" string
 *     (not a semantic query — this matches stored session-end summaries by prefix).
 *     Returns null if nothing found or on error.
 *
 * @param {Array} [recentHistory] - Local conv.history from the rotated session (Option B).
 *   Pass this from maybeRotateSession. If empty/absent, falls through to haivemind (Option A).
 * @returns {Promise<string|null>}
 */
export async function getHaivemindContext(recentHistory = []) {
  // Option B: use local history if available (exact, chronological, no hallucination)
  if (recentHistory && recentHistory.length > 0) {
    const ctx = _formatHistoryContext(recentHistory);
    if (ctx) {
      logger.info(`[session] Context seeded from local history (${recentHistory.length} turns)`);
      return ctx;
    }
  }

  // Option A: fallback — query haivemind with prefix-anchored session-end summaries
  // Using "VOICE-SESSION-END" as a prefix forces matching stored summaries, not random
  // semantic matches. This is still semantic search but the distinctive prefix dramatically
  // reduces hallucination compared to "VOICE-TASK recent".
  try {
    const { stdout } = await execAsync(
      `${MCPORTER_PATH} call haivemind.search_memories query="VOICE-SESSION-END" limit=3`,
      { timeout: 6000, cwd: '/home/generic' }
    );
    const raw  = stdout.trim();
    const data = JSON.parse(raw);
    const memories = data?.result?.memories || data?.memories || [];
    if (!memories.length) return null;
    // Only use memories that actually start with our prefix (filter semantic drift)
    const relevant = memories.filter(m => (m.content || '').startsWith('VOICE-SESSION-END'));
    if (!relevant.length) return null;
    logger.info(`[session] Context seeded from haivemind (${relevant.length} session summaries)`);
    return relevant
      .map(m => m.content || String(m))
      .join(' | ')
      .substring(0, 600);
  } catch (e) {
    logger.warn({ err: e.message }, 'haivemind context fetch failed (non-fatal)');
    return null;
  }
}

/**
 * Format the last N user+assistant turns of conv.history into a compact context string.
 * Strips long content to avoid injecting too much into the new session prompt.
 * @param {Array} history - conv.history array
 * @returns {string|null}
 */
function _formatHistoryContext(history) {
  const turns = history.slice(-6); // last 3 exchanges (user+assistant pairs)
  if (!turns.length) return null;
  const lines = turns.map(m => {
    const role = m.role === 'user' ? 'U' : 'J';
    const content = (m.content || '').substring(0, 150);
    return `${role}: ${content}`;
  });
  return `Recent session: ${lines.join(' | ')}`;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function _storeSessionSummary(history) {
  const ts    = new Date().toISOString().substring(0, 16);
  const lines = history
    .slice(-8)
    .map(m => `${m.role === 'user' ? 'U' : 'J'}: ${(m.content || '').substring(0, 100)}`)
    .join('; ');
  const content = `VOICE-SESSION-END ${ts}: ${lines}`;
  await _haivemindStore(content, 'voice-session');
  logger.info('💾 Session summary stored to haivemind');
}

const MCPORTER_PATH = process.env.MCPORTER_PATH || 'mcporter'; // set MCPORTER_PATH env var to override

async function _haivemindStore(content, category = 'voice-session') {
  try {
    // Shell-safe: escape single quotes inside the value
    const escaped = content.replace(/'/g, "'\\''");
    await execAsync(
      `${MCPORTER_PATH} call haivemind.store_memory content='${escaped}' category='${category}'`,
      { timeout: 8000, cwd: '/home/generic' }
    );
  } catch (e) {
    logger.warn({ err: e.message }, 'haivemind store failed (non-fatal)');
  }
}
