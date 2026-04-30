/**
 * dedup.js — Content deduplication and transcript similarity.
 *
 * Extracted from src/index.js. Prevents duplicate responses from being
 * spoken multiple times via message ID dedup, content hash dedup, and
 * bigram-based transcript similarity.
 */

import logger from '../logger.js';

// ── Message ID Cache ──────────────────────────────────────────────────
export const _processedMsgIds = new Set();
const DEDUP_MSG_ID_MAX = 500;

// Periodic cleanup of message ID cache
setInterval(() => {
  if (_processedMsgIds.size > DEDUP_MSG_ID_MAX) {
    _processedMsgIds.clear();
    logger.info('🧹 Cleared message ID dedup cache');
  }
}, 5 * 60 * 1000);

// ── Content Hash Dedup ────────────────────────────────────────────────
const _recentContentHashes = new Map(); // hash -> timestamp
const DEDUP_CONTENT_TTL_MS = 90_000; // 90s window

function _contentHash(text) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  return `${normalized.substring(0, 100)}__${normalized.split(/\s+/).length}`;
}

function _isDuplicateContent(text) {
  const hash = _contentHash(text);
  const now = Date.now();
  const lastSeen = _recentContentHashes.get(hash);
  if (lastSeen && now - lastSeen < DEDUP_CONTENT_TTL_MS) {
    return true;
  }
  _recentContentHashes.set(hash, now);
  if (_recentContentHashes.size > 200) {
    for (const [h, t] of _recentContentHashes) {
      if (now - t > DEDUP_CONTENT_TTL_MS * 2) _recentContentHashes.delete(h);
    }
  }
  return false;
}

export function isDuplicateContent(text) { return _isDuplicateContent(text); }

// ── Transcript Bigram Similarity ──────────────────────────────────────

function _normTokens(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
}

function _bigrams(tokens) {
  const bg = new Set();
  for (let i = 0; i < tokens.length - 1; i++) bg.add(`${tokens[i]}_${tokens[i+1]}`);
  if (tokens.length < 4) tokens.forEach(t => bg.add(t));
  return bg;
}

function _jaccardSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) { if (b.has(item)) intersection++; }
  return intersection / (a.size + b.size - intersection);
}

export function transcriptSimilarity(t1, t2) {
  const bg1 = _bigrams(_normTokens(t1));
  const bg2 = _bigrams(_normTokens(t2));
  return _jaccardSimilarity(bg1, bg2);
}

// ── Task Spoke Inline Tracker ─────────────────────────────────────────
const _taskSpokeInline = new Map(); // taskId -> timestamp
const TASK_SPOKE_TTL_MS = 60_000;

export function markTaskSpokeInline(taskId) {
  _taskSpokeInline.set(taskId, Date.now());
}

export function didTaskSpeakInline(taskId) {
  const now = Date.now();
  if (taskId) {
    const ts = _taskSpokeInline.get(taskId);
    if (ts && (now - ts) < TASK_SPOKE_TTL_MS) return true;
  }
  return false;
}
