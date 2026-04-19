/**
 * Session Manager — rotating gateway session keys with file + haivemind memory.
 *
 * Why: The OpenClaw gateway session accumulates ALL tool call results and
 * history unbounded. After 15+ voice tasks the context window balloons and
 * inference slows from 7s → 130s. Rotating the session key gives a fresh
 * context window. Memory is persisted so nothing is lost across restarts.
 *
 * Memory tiers (both run in parallel):
 *   1. data/memory.md  — local append-only log, primary source on cold start
 *   2. hAIveMind       — external tool (optional, feature-flagged)
 *
 * Rotation trigger: idle gap (default 30 min). Active conversations never
 * get interrupted — only fires on next turn after silence.
 *
 * Memory strategy on session rotation (B → A fallback):
 *   B (primary): Inject the last N turns of the local conv.history — exact,
 *     chronological, zero hallucination risk. Available for mid-session rotations.
 *   A (fallback): Local memory.md / haivemind VOICE-TASK prefix query (not semantic).
 */
import { exec as _exec } from 'child_process';
import { promisify } from 'util';
import { readFile, appendFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import { mcpCall } from './mcp-access.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const execAsync = promisify(_exec);

// ── hAIveMind config ─────────────────────────────────────────────────────────
// All haivemind integration is gated on HAIVEMIND_ENABLED. Set to "false" to
// disable all memory reads/writes (useful when hAIveMind isn't running or the
// user wants to disable this external dependency entirely).
const HAIVEMIND_ENABLED = (process.env.VOICE_MEMORY_ENABLED ?? 'true').toLowerCase() !== 'false';
// mcporter CLI path — override if not on PATH
const MCPORTER_PATH = process.env.MCPORTER_PATH || 'mcporter';
// Optional direct HTTP URL — bypasses mcporter subprocess when set
const HAIVEMIND_URL = process.env.HAIVEMIND_URL || '';
// Hard timeout on all haivemind calls — prevents ECONNREFUSED from stalling dispatch
const HAIVEMIND_TIMEOUT_MS = parseInt(process.env.HAIVEMIND_TIMEOUT_MS ?? '8000');

// ── haivemind circuit breaker ─────────────────────────────────────────────────
// 3 failures in 60 s → open for 90 s. Short backoff so recovery after a crash/restart
// is detected quickly rather than staying blind for 5 minutes.
const _hmBreaker = {
  failures: [],
  openUntil: 0,
  isOpen() {
    if (!this.openUntil) return false;
    if (Date.now() < this.openUntil) return true;
    this.openUntil = 0;
    this.failures = [];
    logger.info('[haivemind] circuit breaker closed — retrying');
    return false;
  },
  recordFailure() {
    const now = Date.now();
    this.failures = this.failures.filter(t => now - t < 60_000);
    this.failures.push(now);
    if (this.failures.length >= 3 && !this.openUntil) {
      this.openUntil = now + 90_000; // open for 90 s (was 5 min)
      logger.warn('[haivemind] circuit breaker opened — 3 failures in 60 s, backing off 90 s');
    }
  },
  recordSuccess() {
    if (this.openUntil) {
      this.openUntil = 0;
      this.failures = [];
      logger.info('[haivemind] circuit breaker closed after recovery');
    }
  },
};

// ── Local memory file ─────────────────────────────────────────────────────────
// data/memory.md — append-only log of completed tasks, no external dependency.
// On cold start this is read first; haivemind supplements if enabled.
const MEMORY_FILE = process.env.VOICE_MEMORY_FILE
  || join(__dirname, '..', 'data', 'memory.md');
const MEMORY_RECALL_ENTRIES = parseInt(process.env.VOICE_MEMORY_RECALL ?? '10');

/** How long idle before rotating on next turn (ms). Override via .env */
const IDLE_ROTATION_MS = parseInt(process.env.SESSION_ROTATION_IDLE_MS ?? '1800000'); // 30 min (was 5 min)

const SESSION_BASE = process.env.SESSION_USER || 'jarvis-voice-user';

let _suffix   = '';            // empty = use base name (initial session)
let _lastActivity = Date.now();
let _newSession   = true;      // true on cold start + after rotation — seeds first turn with haivemind context

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

  // Stash the history snapshot so getLocalMemoryContext() (Option B) can use it
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
 * Returns and clears the history stash from the previous session.
 * Used by getLocalMemoryContext() Option B to seed the new session with exact
 * chronological context from the rotated session, consumed once.
 */
export function consumeRotatedHistory() {
  const h = _rotatedHistory;
  _rotatedHistory = [];
  return h;
}

/**
 * Append a completed task to data/memory.md (local file, no external deps).
 * Also stores to haivemind if enabled. Fire-and-forget.
 */
export async function storeTaskToHaivemind(taskId, userMessage, spokenResult) {
  const ts         = new Date().toISOString().substring(0, 16);
  const userSnip   = (userMessage   || '').substring(0, 120);
  const resultSnip = (spokenResult  || '').substring(0, 200);

  // Always write to local file — no external dependency
  await _appendMemoryFile(ts, taskId, userSnip, resultSnip);

  // Also push to haivemind if enabled
  if (HAIVEMIND_ENABLED) {
    const content = `VOICE-TASK ${ts} task=${taskId}: request="${userSnip}" spoken="${resultSnip}"`;
    await _haivemindStore(content, 'voice-session');
  }
}

/**
 * Read the last VOICE_MEMORY_RECALL entries from data/memory.md.
 * Returns a compact string for context injection, or null if file is empty/missing.
 * @param {Array} recentHistory - Option B: local history stash from previous session
 */
export async function getLocalMemoryContext(recentHistory = []) {
  // Option B: use local history if available (exact, chronological, no hallucination)
  if (recentHistory && recentHistory.length > 0) {
    const ctx = _formatHistoryContext(recentHistory);
    if (ctx) {
      logger.info(`[session] Context seeded from local history (${recentHistory.length} turns)`);
      return ctx;
    }
  }

  try {
    const text = await readFile(MEMORY_FILE, 'utf8');
    // Each entry starts with "## " — split on that boundary
    const entries = text.split(/\n(?=## )/).filter(Boolean);
    const recent  = entries.slice(-MEMORY_RECALL_ENTRIES);
    if (!recent.length) return null;
    // Compact: strip markdown headings, collapse whitespace
    return recent
      .map(e => e.replace(/^## /m, '').replace(/\n/g, ' ').trim())
      .join(' | ')
      .substring(0, 800);
  } catch {
    return null; // file doesn't exist yet — silent
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

/**
 * Fetch recent voice session context from haivemind as a compact string.
 * Returns null if nothing found or on error.
 */
export async function getHaivemindContext() {
  if (!HAIVEMIND_ENABLED) return null;
  try {
    // Use semantic=false so haivemind returns results sorted by creation time (most recent first),
    // not by semantic relevance. This prevents old calendar/cron memories from outranking recent tasks.
    const raw = await _haivemindSearch('VOICE-TASK', { limit: 3, semantic: false });
    if (!raw) return null;
    const data = JSON.parse(raw);
    const memories = data?.result?.memories || data?.memories || [];
    // Filter to only genuine VOICE-TASK entries (exact prefix match) to avoid cross-contamination
    const voiceTasks = memories.filter(m => (m.content || '').startsWith('VOICE-TASK '));
    if (!voiceTasks.length) return null;
    return voiceTasks
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

  // Write session boundary to local file
  try {
    await mkdir(dirname(MEMORY_FILE), { recursive: true });
    await appendFile(MEMORY_FILE, `\n## ${ts} [session-end]\n${lines}\n`);
  } catch (e) {
    logger.warn({ err: e.message }, 'memory file session write failed (non-fatal)');
  }

  if (HAIVEMIND_ENABLED) {
    await _haivemindStore(`VOICE-SESSION-END ${ts}: ${lines}`, 'voice-session');
    logger.info('💾 Session summary stored to haivemind');
  }
}

async function _appendMemoryFile(ts, taskId, userSnip, resultSnip) {
  try {
    await mkdir(dirname(MEMORY_FILE), { recursive: true });
    const entry = `\n## ${ts} task=${taskId}\n**User:** ${userSnip}\n**JARVIS:** ${resultSnip}\n`;
    await appendFile(MEMORY_FILE, entry);
  } catch (e) {
    logger.warn({ err: e.message }, 'memory file write failed (non-fatal)');
  }
}

// ── Transport helpers ─────────────────────────────────────────────────────────
// When HAIVEMIND_URL is set, use direct MCP-over-HTTP (SSE response) to haivemind's
// /mcp endpoint. No auth needed for localhost. Otherwise fall back to mcporter CLI.

/**
 * Call a haivemind MCP tool via HTTP. Returns the text content from the tool result.
 * haivemind's remote_mcp_server responds with SSE: "event: message\ndata: {JSON}\n\n"
 */
async function _hmHttpCall(toolName, args) {
  const res = await fetch(`${HAIVEMIND_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
    signal: AbortSignal.timeout(HAIVEMIND_TIMEOUT_MS),
  });
  const text = await res.text();
  const dataLine = text.split('\n').find(l => l.startsWith('data:'));
  if (!dataLine) return null;
  const envelope = JSON.parse(dataLine.slice(5).trim());
  return envelope?.result?.content?.[0]?.text ?? null;
}

async function _haivemindStore(content, category = 'voice-session') {
  if (_hmBreaker.isOpen()) return;
  try {
    if (HAIVEMIND_URL) {
      await _hmHttpCall('store_memory', { content, category });
    } else {
      await mcpCall('haivemind', 'store_memory', { content, category });
    }
    _hmBreaker.recordSuccess();
  } catch (e) {
    _hmBreaker.recordFailure();
    logger.warn({ err: e.message }, 'haivemind store failed (non-fatal)');
  }
}

async function _haivemindSearch(query, { limit = 5, semantic = true } = {}) {
  if (_hmBreaker.isOpen()) throw new Error('haivemind circuit open');
  try {
    let result;
    if (HAIVEMIND_URL) {
      result = await _hmHttpCall('search_memories', { query, limit, semantic });
    } else {
      result = await mcpCall('haivemind', 'search_memories', { query, limit, semantic });
    }
    _hmBreaker.recordSuccess();
    return result;
  } catch (e) {
    _hmBreaker.recordFailure();
    throw e;
  }
}

async function _haivemindGetRecent(category, { hours = 2, limit = 5 } = {}) {
  if (_hmBreaker.isOpen()) return null;
  try {
    let result;
    if (HAIVEMIND_URL) {
      result = await _hmHttpCall('get_recent_memories', { category, hours, limit });
    } else {
      result = await mcpCall('haivemind', 'get_recent_memories', { category, hours, limit });
    }
    _hmBreaker.recordSuccess();
    return result;
  } catch (e) {
    _hmBreaker.recordFailure();
    logger.warn({ err: e.message }, 'haivemind get_recent_memories failed (non-fatal)');
    return null;
  }
}

/**
 * Fetch recent memories for a specific channel (temporal, not semantic).
 * Returns compact string for context injection, or null.
 */
export async function getChannelContext(channelId) {
  if (!HAIVEMIND_ENABLED || !channelId) return null;
  try {
    const raw = await _haivemindGetRecent(`channel:${channelId}`, { hours: 2, limit: 5 });
    if (!raw) return null;
    const data = JSON.parse(raw);
    const memories = data?.result?.memories || data?.memories || [];
    if (!memories.length) return null;
    return memories
      .map(m => m.content || String(m))
      .join(' | ')
      .substring(0, 600);
  } catch (e) {
    logger.warn({ err: e.message }, 'getChannelContext failed (non-fatal)');
    return null;
  }
}

/**
 * Store a completed interaction for a channel (temporal, fire-and-forget).
 */
export async function storeChannelMemory(channelId, userMessage, response) {
  if (!HAIVEMIND_ENABLED || !channelId) return;
  const ts       = new Date().toISOString().substring(0, 16);
  const userSnip = (userMessage || '').substring(0, 120);
  const respSnip = (response   || '').substring(0, 200);
  const content  = `[${ts}] user: "${userSnip}" | response: "${respSnip}"`;
  await _haivemindStore(content, `channel:${channelId}`);
}

/**
 * Semantic search across all haivemind memories for a query.
 * Used to proactively inject relevant context before Claude processes a message.
 * Returns a compact string of matching memory content, or null.
 */
export async function searchHaivemind(query, { limit = 4 } = {}) {
  if (!HAIVEMIND_ENABLED || !query) return null;
  try {
    const raw = await _haivemindSearch(query.substring(0, 100), { limit, semantic: true });
    if (!raw) return null;
    const data = JSON.parse(raw);
    const memories = data?.memories || data?.result?.memories || [];
    if (!memories.length) return null;
    return memories
      .map(m => (m.content || '').substring(0, 300))
      .join('\n---\n')
      .substring(0, 1200);
  } catch (e) {
    logger.warn({ err: e.message }, '[haivemind] searchHaivemind failed (non-fatal)');
    return null;
  }
}
