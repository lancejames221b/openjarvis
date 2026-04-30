import logger from '../logger.js';
/**
 * Self-Mute TTS Queue
 *
 * When the owner self-mutes on Discord, TTS output is queued here
 * instead of being spoken. On unmute, a smart debrief is offered.
 *
 * Entries are in-memory. The hAIveMind persistence path is future work.
 */

const MUTE_QUEUE_MAX = parseInt(process.env.MUTE_QUEUE_MAX || '20');
const MUTE_QUEUE_TTL_MS = parseInt(process.env.MUTE_QUEUE_TTL_MS || '3600000'); // 1 hour

let _active = false;
let _activeSince = null;
const _entries = [];

// ── Activation ───────────────────────────────────────────────────────

/** Activate the mute queue (owner self-muted). */
export function activate() {
  if (_active) return;
  _active = true;
  _activeSince = Date.now();
  logger.info('🔇 Mute queue activated — TTS output will be queued');
}

/** Deactivate (owner unmuted). Does NOT clear — caller debriefs first. */
export function deactivate() {
  if (!_active) return;
  _active = false;
  const duration = _activeSince ? Date.now() - _activeSince : 0;
  logger.info(`🔊 Mute queue deactivated after ${Math.round(duration / 1000)}s — ${_entries.length} entries queued`);
  _activeSince = null;
}

export function isActive() {
  return _active;
}

// ── Entry Management ─────────────────────────────────────────────────

/**
 * Add a text entry to the mute queue.
 * @param {string} text    — text that would have been spoken
 * @param {string} source  — origin: 'task', 'speak', 'alert', 'reminder'
 * @param {number} priority — 1-5 (lower = more important)
 */
export function addEntry(text, source = 'update', priority = 3) {
  if (!text || text.trim().length < 2) return;
  pruneExpired();

  _entries.push({
    text: text.trim(),
    source,
    priority,
    timestamp: Date.now(),
  });

  // Cap at max — drop lowest-priority (highest number) first
  while (_entries.length > MUTE_QUEUE_MAX) {
    const maxPri = Math.max(..._entries.map(e => e.priority));
    const idx = _entries.findIndex(e => e.priority === maxPri);
    _entries.splice(idx >= 0 ? idx : 0, 1);
  }

  logger.info(`🔇 Mute queue: +1 (${source}) — ${_entries.length} total`);
}

export function getEntries() {
  pruneExpired();
  return [..._entries];
}

export function getCount() {
  pruneExpired();
  return _entries.length;
}

export function hasEntries() {
  pruneExpired();
  return _entries.length > 0;
}

// ── Smart Summary & Debrief ──────────────────────────────────────────

const SOURCE_LABELS = {
  task: 'task completion',
  speak: 'update',
  alert: 'alert',
  reminder: 'reminder',
  update: 'update',
};

/**
 * One-liner summary for the unmute prompt.
 * e.g. "I have 3 updates while you were muted — 2 task completions, 1 alert.
 *        Shall I brief you?"
 */
export function getSummary() {
  pruneExpired();
  if (_entries.length === 0) return null;

  const counts = {};
  for (const e of _entries) {
    const key = e.source || 'update';
    counts[key] = (counts[key] || 0) + 1;
  }

  const parts = [];
  for (const [src, n] of Object.entries(counts)) {
    const label = SOURCE_LABELS[src] || src;
    parts.push(`${n} ${label}${n > 1 ? 's' : ''}`);
  }

  const total = _entries.length;
  if (total === 1) {
    return `I have one update while you were muted. Shall I brief you?`;
  }
  return `I have ${total} updates while you were muted — ${parts.join(', ')}. Shall I brief you?`;
}

/**
 * Full debrief text for voice delivery.
 * Sorted by priority then time, each entry trimmed to 2 sentences for voice.
 */
export function getDebriefText() {
  pruneExpired();
  if (_entries.length === 0) return null;

  const sorted = [..._entries].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.timestamp - b.timestamp;
  });

  if (sorted.length === 1) return sorted[0].text;

  // Smart collapse: trim each entry to first 2 sentences
  const parts = sorted.map((entry, i) => {
    const sentences = entry.text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
    return sentences;
  });

  return parts.join('. Next: ');
}

/**
 * Build conversation-history context block so the AI can answer
 * follow-up questions about the queued updates.
 */
export function getContextBlock() {
  pruneExpired();
  if (_entries.length === 0) return null;

  let ctx = `[SYSTEM] The following ${_entries.length} update(s) were queued while the user was self-muted:\n`;
  for (const e of _entries) {
    const ago = Math.round((Date.now() - e.timestamp) / 1000);
    ctx += `- [${e.source}] (${ago}s ago): ${e.text}\n`;
  }
  ctx += `User was offered a debrief on unmute. If they say "yes", "brief me", or similar, provide the full details above.`;
  return ctx;
}

export function clear() {
  const count = _entries.length;
  _entries.length = 0;
  if (count > 0) logger.info(`🗑️  Mute queue cleared (${count} entries)`);
  return count;
}

// ── Internal ─────────────────────────────────────────────────────────

function pruneExpired() {
  const now = Date.now();
  for (let i = _entries.length - 1; i >= 0; i--) {
    if (now - _entries[i].timestamp > MUTE_QUEUE_TTL_MS) {
      _entries.splice(i, 1);
    }
  }
}
