/**
 * Session Manager — rotating gateway session keys with haivemind-backed memory.
 *
 * Why: The OpenClaw gateway session accumulates ALL tool call results and
 * history unbounded. After 15+ voice tasks the context window balloons and
 * inference slows from 7s → 130s. Rotating the session key gives a fresh
 * context window. haivemind stores the memory so nothing is lost.
 *
 * Rotation trigger: idle gap (default 5 min). Active conversations never
 * get interrupted — only fires on next turn after silence.
 */
import { exec as _exec } from 'child_process';
import { promisify } from 'util';
import logger from './logger.js';

const execAsync = promisify(_exec);

/** How long idle before rotating on next turn (ms). Override via .env */
const IDLE_ROTATION_MS = parseInt(process.env.SESSION_ROTATION_IDLE_MS ?? '300000'); // 5 min

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
 * Check if idle threshold exceeded. If so, store session summary to haivemind
 * and rotate the session key. Returns true if rotated.
 * @param {Array} history - local conversation history for summary storage
 */
export async function maybeRotateSession(history = []) {
  const idleMs = Date.now() - _lastActivity;
  if (idleMs < IDLE_ROTATION_MS) return false;

  logger.info({ idleMs: Math.round(idleMs / 1000) }, '🔄 Idle threshold hit — rotating gateway session');

  // Store summary to haivemind BEFORE rotating
  if (history.length > 0) {
    await _storeSessionSummary(history);
  }

  _suffix     = Date.now().toString(36);
  _newSession = true;
  logger.info(`🔄 New session key: ${getActiveSessionUser()}`);
  return true;
}

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
 * Fetch recent voice session context from haivemind as a compact string.
 * Returns null if nothing found or on error.
 */
export async function getHaivemindContext() {
  try {
    const { stdout } = await execAsync(
      `${MCPORTER_PATH} call haivemind.search_memories query="VOICE-TASK recent" limit=5`,
      { timeout: 6000, cwd: '/home/generic' }
    );
    const raw  = stdout.trim();
    const data = JSON.parse(raw);
    const memories = data?.result?.memories || data?.memories || [];
    if (!memories.length) return null;
    return memories
      .map(m => m.content || String(m))
      .join(' | ')
      .substring(0, 600);
  } catch (e) {
    logger.warn({ err: e.message }, 'haivemind context fetch failed (non-fatal)');
    return null;
  }
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
