/**
 * Thread Router — Smart Discord thread management for voice task output
 *
 * Groups voice task results into persistent threads by intent category.
 * Same category within TTL window → continue existing thread.
 * New category or TTL expired → archive stale thread, create fresh one.
 *
 * Registry persists to data/thread-registry.json across restarts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const REGISTRY_PATH = join(DATA_DIR, 'thread-registry.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// TTL: 2 hours of inactivity before opening a fresh thread
const THREAD_TTL_MS = parseInt(process.env.VOICE_THREAD_TTL_MS ?? String(2 * 60 * 60 * 1000));

// ── Category → bucket mapping ────────────────────────────────────────────────
// Multiple intent types collapse to a single thread bucket so related tasks
// share a thread (e.g. EMAIL_SUMMARY + EMAIL_ACTION → 'email').
function getThreadKey(intentCategory) {
  const key = (intentCategory || 'ACTION').toUpperCase();
  if (key.startsWith('EMAIL')) return 'email';
  if (key === 'CALENDAR') return 'calendar';
  if (key === 'PLAN_CMD') return 'planning';
  if (key === 'MEMORY_CMD') return 'memory';
  if (key === 'ADMIN_CMD') return 'admin';
  if (key === 'CHAT' || key === 'FOLLOW_UP') return 'chat';
  if (['QUERY', 'DEEP_DIVE', 'LIST_QUERY', 'STUDY_CMD'].includes(key)) return 'research';
  return 'tasks'; // ACTION, unknown
}

// ── Category → display label ─────────────────────────────────────────────────
const BUCKET_DISPLAY = {
  email:    { name: 'Email',    emoji: '📧' },
  calendar: { name: 'Calendar', emoji: '📅' },
  research: { name: 'Research', emoji: '🔍' },
  tasks:    { name: 'Tasks',    emoji: '⚡' },
  planning: { name: 'Planning', emoji: '📋' },
  memory:   { name: 'Memory',   emoji: '🧠' },
  admin:    { name: 'Admin',    emoji: '⚙️' },
  chat:     { name: 'Chat',     emoji: '💬' },
};

function getDisplay(bucket) {
  return BUCKET_DISPLAY[bucket] || { name: 'Tasks', emoji: '⚡' };
}

// ── Registry persistence ─────────────────────────────────────────────────────
let _registry = loadRegistry();

function loadRegistry() {
  try {
    if (existsSync(REGISTRY_PATH)) {
      return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    }
  } catch (err) {
    logger.error('[ThreadRouter] Failed to load registry:', err.message);
  }
  return {};
}

let _saveTimer = null;
function saveRegistry() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      writeFileSync(REGISTRY_PATH, JSON.stringify(_registry, null, 2));
    } catch (err) {
      logger.error('[ThreadRouter] Failed to save registry:', err.message);
    }
  }, 500);
}

// ── Mutex: prevent race on simultaneous task completions for same bucket ─────
const _locks = new Map();
async function withLock(key, fn) {
  while (_locks.get(key)) {
    await new Promise(r => setTimeout(r, 50));
  }
  _locks.set(key, true);
  try {
    return await fn();
  } finally {
    _locks.delete(key);
  }
}

// ── Core: get or create thread ───────────────────────────────────────────────

/**
 * Get or create a Discord thread for the given intent category.
 *
 * @param {import('discord.js').Client} client
 * @param {string} channelId - Target channel (e.g. #hud: 1482037873426567229)
 * @param {string} intentCategory - From classifyIntent() (e.g. 'CALENDAR', 'ACTION')
 * @returns {Promise<import('discord.js').ThreadChannel>}
 */
export async function getOrCreateThread(client, channelId, intentCategory) {
  const bucket = getThreadKey(intentCategory);
  return withLock(bucket, async () => {
    const channel = client.channels.cache.get(channelId);
    if (!channel) throw new Error(`[ThreadRouter] Channel ${channelId} not found in cache`);

    const existing = _registry[bucket];
    const now = Date.now();

    // ── Try to reuse an existing thread within TTL ────────────────────────
    if (existing && (now - existing.lastUsed) < THREAD_TTL_MS) {
      try {
        // threads.fetch() works for both active and archived threads
        const thread = await channel.threads.fetch(existing.threadId);
        if (thread) {
          if (thread.archived) {
            await thread.setArchived(false);
            logger.info(`[ThreadRouter] Unarchived thread "${thread.name}" (${existing.threadId})`);
          }
          existing.lastUsed = now;
          saveRegistry();
          logger.info(`[ThreadRouter] Reusing "${thread.name}" (${existing.threadId}) bucket=${bucket}`);
          return thread;
        }
      } catch (err) {
        // Thread gone (deleted, permissions changed, etc.) — fall through to create new
        logger.warn(`[ThreadRouter] Thread ${existing?.threadId} inaccessible (${err.message}) — creating new`);
      }
    }

    // ── Archive stale thread if TTL expired ───────────────────────────────
    if (existing?.threadId) {
      try {
        const oldThread = await channel.threads.fetch(existing.threadId).catch(() => null);
        if (oldThread && !oldThread.archived) {
          await oldThread.setArchived(true);
          logger.info(`[ThreadRouter] Archived stale thread "${oldThread.name}"`);
        }
      } catch (_) {}
    }

    // ── Create new thread ─────────────────────────────────────────────────
    const display = getDisplay(bucket);
    const threadName = `${display.emoji} ${display.name}`;

    const starterMsg = await channel.send(`🎙️ **Jarvis Voice** — ${display.emoji} ${display.name}`);
    const thread = await starterMsg.startThread({
      name: threadName,
      autoArchiveDuration: 1440, // 24 hours
    });

    _registry[bucket] = {
      threadId: thread.id,
      channelId,
      lastUsed: now,
      name: threadName,
      createdAt: now,
    };
    saveRegistry();

    logger.info(`[ThreadRouter] Created thread "${threadName}" (${thread.id}) bucket=${bucket}`);
    return thread;
  });
}

// ── Post a completed task result ─────────────────────────────────────────────

/**
 * Post a voice task Q&A pair to the appropriate thread in #hud.
 *
 * @param {import('discord.js').Client} client
 * @param {string} channelId - #hud channel ID
 * @param {string} intentCategory - Intent from classifyIntent()
 * @param {number} taskId
 * @param {string} userTranscript - What the user said
 * @param {string} jarvisResponse - Full written Jarvis response
 * @param {string} duration - Duration string e.g. "2.3"
 * @returns {Promise<{threadId: string|null, success: boolean}>}
 */
export async function postTaskToThread(client, channelId, intentCategory, taskId, userTranscript, jarvisResponse, duration) {
  try {
    const thread = await getOrCreateThread(client, channelId, intentCategory);

    // User question header
    await thread.send(`🎙️ **Task #${taskId}:** ${userTranscript}`);

    // Jarvis response — split at 1900 chars if needed
    const response = jarvisResponse.trim();
    const chunks = [];
    for (let i = 0; i < response.length; i += 1900) {
      chunks.push(response.substring(i, i + 1900));
    }
    for (let i = 0; i < chunks.length; i++) {
      const prefix = i === 0 ? '**Jarvis:** ' : '';
      const suffix = i === chunks.length - 1 ? `\n_${duration}s_` : '';
      await thread.send(`${prefix}${chunks[i]}${suffix}`);
    }

    logger.info(`[ThreadRouter] Task #${taskId} posted to thread "${thread.name}" (${thread.id})`);
    return { threadId: thread.id, success: true };
  } catch (err) {
    logger.error(`[ThreadRouter] Failed to post task #${taskId}: ${err.message}`);
    return { threadId: null, success: false };
  }
}

// ── Read active thread ID for a category ────────────────────────────────────

/**
 * Return the current thread ID for an intent category, or null if none/expired.
 * Used by brain.js to tell sub-agents where to post their output.
 */
export function getActiveThreadId(intentCategory) {
  const bucket = getThreadKey(intentCategory);
  const entry = _registry[bucket];
  if (!entry) return null;
  if (Date.now() - entry.lastUsed > THREAD_TTL_MS) return null;
  return entry.threadId;
}
