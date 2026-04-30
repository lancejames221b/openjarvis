/**
 * Durable Discord channel transcript for large-context LLM prompts.
 *
 * SECURITY / PRIVACY: When enabled, full message text for allowlisted channels is
 * stored on disk on this machine (SQLite). Use DISCORD_MEMORY_CHANNEL_ALLOWLIST —
 * do not enable without an explicit channel list.
 *
 * Uses Node.js built-in node:sqlite (DatabaseSync). Requires Node 22.5+.
 */

import { mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import logger from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ENABLED = process.env.DISCORD_MEMORY_ENABLED === 'true';
const DEFAULT_DB = join(__dirname, '..', 'data', 'discord-memory.sqlite');
const DB_PATH = process.env.DISCORD_MEMORY_DB_PATH || DEFAULT_DB;
const INPUT_TOKEN_BUDGET = Math.max(
  10_000,
  parseInt(process.env.DISCORD_MEMORY_INPUT_TOKEN_BUDGET || '900000', 10) || 900_000,
);
const BACKFILL_LIMIT = Math.max(
  50,
  parseInt(process.env.DISCORD_MEMORY_BACKFILL_LIMIT || '5000', 10) || 5000,
);
const MAX_STORED_CHARS = Math.max(
  500,
  parseInt(process.env.DISCORD_MEMORY_MAX_CHARS_PER_MESSAGE || '12000', 10) || 12_000,
);
const PER_MESSAGE_OVERHEAD_TOKENS = 6;
const IGNORE_OTHER_BOTS = process.env.DISCORD_MEMORY_IGNORE_OTHER_BOTS === 'true';

const allowList = new Set(
  (process.env.DISCORD_MEMORY_CHANNEL_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const denyList = new Set(
  (process.env.DISCORD_MEMORY_CHANNEL_DENYLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** @type {DatabaseSync | null} */
let db = null;

/**
 * True when memory subsystem is active (enabled, allowlist non-empty, DB open).
 */
export function isDiscordMemoryReady() {
  return Boolean(db && ENABLED && allowList.size > 0);
}

/**
 * Channel or thread is indexed when its effective id or parent is allowlisted and not denied.
 * @param {import('discord.js').Message | import('discord.js').PartialMessage} message
 */
export function shouldIndexDiscordMessage(message) {
  if (!ENABLED || allowList.size === 0) return false;
  const ch = message.channel;
  if (!ch || ch.isDMBased?.()) return false;
  const id = ch.id;
  const parentId = ch.isThread?.() ? ch.parentId : null;
  if (denyList.has(id) || (parentId && denyList.has(parentId))) {
    return false;
  }
  if (allowList.has(id)) {
    return true;
  }
  if (parentId && allowList.has(parentId)) {
    return true;
  }
  return false;
}

export function shouldServeDiscordMemoryForMessage(message) {
  return shouldIndexDiscordMessage(message);
}

function resolveScope(message) {
  const ch = message.channel;
  const isThread = Boolean(ch?.isThread?.());
  const rootChannelId = isThread ? ch.parentId : ch.id;
  const threadId = isThread ? ch.id : '';
  return { rootChannelId, threadId, isThread };
}

function estimateTokens(text) {
  if (!text) {
    return PER_MESSAGE_OVERHEAD_TOKENS;
  }
  return Math.ceil(text.length / 4) + PER_MESSAGE_OVERHEAD_TOKENS;
}

function extractBody(message) {
  let body = message.content || '';
  if (message.attachments?.size) {
    const names = [...message.attachments.values()]
      .map((a) => a.name || 'file')
      .join(', ');
    body = body ? `${body}\n[attachments: ${names}]` : `[attachments: ${names}]`;
  }
  if (body.length > MAX_STORED_CHARS) {
    body = `${body.slice(0, MAX_STORED_CHARS)}\n…[truncated]`;
  }
  return body;
}

export function initDiscordMemory() {
  if (!ENABLED) {
    logger.info('[discord-memory] Disabled (DISCORD_MEMORY_ENABLED != true)');
    return;
  }
  if (allowList.size === 0) {
    logger.warn('[discord-memory] Enabled but DISCORD_MEMORY_CHANNEL_ALLOWLIST is empty — refusing to start');
    return;
  }
  try {
    const dir = dirname(DB_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS discord_messages (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        root_channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        is_self_bot INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_discord_msgs_scope
        ON discord_messages(guild_id, root_channel_id, thread_id, id);
    `);
    logger.info(
      `[discord-memory] Initialized (${allowList.size} allowlisted channel(s), budget≈${INPUT_TOKEN_BUDGET} tok, db=${DB_PATH})`,
    );
  } catch (err) {
    logger.error(`[discord-memory] Failed to open DB: ${err.message}`);
    db = null;
  }
}

/**
 * @param {import('discord.js').Message} message
 * @param {string} botUserId
 */
export function recordDiscordMessage(message, botUserId) {
  if (!db || !shouldIndexDiscordMessage(message)) {
    return;
  }
  if (!message.guildId) {
    return;
  }
  if (IGNORE_OTHER_BOTS && message.author?.bot && message.author.id !== botUserId) {
    return;
  }
  try {
    const { rootChannelId, threadId } = resolveScope(message);
    const author = message.author;
    if (!author) {
      return;
    }
    const isSelf = author.id === botUserId ? 1 : 0;
    const body = extractBody(message);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO discord_messages
        (id, guild_id, root_channel_id, thread_id, author_id, author_name, is_self_bot, content)
      VALUES (@id, @guild_id, @root_channel_id, @thread_id, @author_id, @author_name, @is_self_bot, @content)
    `);
    stmt.run({
      id: message.id,
      guild_id: message.guildId,
      root_channel_id: rootChannelId,
      thread_id: threadId || '',
      author_id: author.id,
      author_name: author.username || author.id,
      is_self_bot: isSelf,
      content: body,
    });
  } catch (err) {
    logger.warn(`[discord-memory] record failed: ${err.message}`);
  }
}

/**
 * @param {import('discord.js').Message} message
 */
export function updateDiscordMessageContent(message, botUserId) {
  if (!db || !shouldIndexDiscordMessage(message)) {
    return;
  }
  try {
    recordDiscordMessage(message, botUserId);
  } catch (err) {
    logger.warn(`[discord-memory] update failed: ${err.message}`);
  }
}

function countMessages(guildId, rootChannelId, threadId) {
  if (!db) {
    return 0;
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM discord_messages
       WHERE guild_id = ? AND root_channel_id = ? AND thread_id = ?`,
    )
    .get(guildId, rootChannelId, threadId || '');
  return row?.c ?? 0;
}

/**
 * Backfill SQLite from Discord REST before the triggering message.
 * @param {import('discord.js').Message} message
 * @param {string} botUserId
 */
export async function backfillDiscordChannelBefore(message, botUserId) {
  if (!db || !shouldIndexDiscordMessage(message)) {
    return;
  }
  const ch = message.channel;
  if (!ch || !ch.messages?.fetch) {
    return;
  }
  let before = message.id;
  let total = 0;
  try {
    while (total < BACKFILL_LIMIT) {
      const batchSize = Math.min(100, BACKFILL_LIMIT - total);
      const batch = await ch.messages.fetch({ limit: batchSize, before });
      if (batch.size === 0) {
        break;
      }
      const sorted = [...batch.values()].sort((a, b) => a.id.localeCompare(b.id));
      for (const m of sorted) {
        if (m.partial) {
          continue;
        }
        recordDiscordMessage(m, botUserId);
      }
      total += batch.size;
      const sortedIds = [...batch.values()].map((m) => m.id).sort();
      const oldestId = sortedIds[0];
      if (!oldestId || oldestId === before) {
        break;
      }
      before = oldestId;
      if (batch.size < batchSize) {
        break;
      }
    }
    logger.info(`[discord-memory] Backfilled ${total} message(s) for ${ch.id}`);
  } catch (err) {
    logger.warn(`[discord-memory] Backfill failed: ${err.message}`);
  }
}

/**
 * Load prior turns as OpenAI-style messages (excludes current message id), newest tail within token budget.
 * @returns {{ history: { role: string, content: string }[], usedTokens: number }}
 */
export function loadDiscordChatCompletionHistory(message, botUserId) {
  const empty = { history: [], usedTokens: 0 };
  if (!db || !message.guildId || !shouldServeDiscordMemoryForMessage(message)) {
    return empty;
  }
  const { rootChannelId, threadId } = resolveScope(message);
  const guildId = message.guildId;
  const beforeId = message.id;

  const rows = db
    .prepare(
      `SELECT author_name, is_self_bot, content FROM discord_messages
       WHERE guild_id = ? AND root_channel_id = ? AND thread_id = ?
         AND id < ?
       ORDER BY id DESC
       LIMIT 20000`,
    )
    .all(guildId, rootChannelId, threadId || '', beforeId);

  const picked = [];
  let used = 0;
  for (const row of rows) {
    const role = row.is_self_bot ? 'assistant' : 'user';
    const content = row.is_self_bot
      ? String(row.content || '').replace(/\n/g, ' ').trim()
      : `${row.author_name}: ${String(row.content || '').replace(/\n/g, ' ').trim()}`;
    const addTokens = estimateTokens(content);
    if (used + addTokens > INPUT_TOKEN_BUDGET) {
      break;
    }
    picked.push({ role, content });
    used += addTokens;
  }
  picked.reverse();

  const merged = [];
  for (const turn of picked) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === turn.role) {
      prev.content = `${prev.content}\n\n${turn.content}`;
    } else {
      merged.push({ role: turn.role, content: turn.content });
    }
  }

  return { history: merged, usedTokens: used };
}

/**
 * Fire-and-forget indexer for messageCreate.
 * @param {import('discord.js').Message} message
 */
export function maybeRecordDiscordMessage(message) {
  if (!db || message.partial || !message.guild) {
    return;
  }
  const botId = message.client?.user?.id;
  if (!botId) {
    return;
  }
  try {
    recordDiscordMessage(message, botId);
  } catch (err) {
    logger.warn(`[discord-memory] maybeRecord: ${err.message}`);
  }
}

/**
 * Backfill when empty, then return chat-completion history for this message (excludes current id).
 * @returns {Promise<{ history: { role: string, content: string }[], usedTokens: number }>}
 */
export async function ensureDiscordHistoryLoaded(message, botUserId) {
  if (!db || !message.guildId || !shouldServeDiscordMemoryForMessage(message)) {
    return { history: [], usedTokens: 0 };
  }
  const { rootChannelId, threadId } = resolveScope(message);
  if (countMessages(message.guildId, rootChannelId, threadId) === 0) {
    await backfillDiscordChannelBefore(message, botUserId);
  }
  return loadDiscordChatCompletionHistory(message, botUserId);
}
