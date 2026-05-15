/**
 * channel-dispatch.js — natural-language Discord channel registration router.
 *
 * Intercepts utterances like:
 *   "register a channel called demos under engineering"
 *   "create a channel named foo in the reverse-engineering category"
 *   "new channel: bar under internal-tools"
 *
 * …and handles them by calling the Discord REST API directly (bot token from
 * env) plus writing an entry into channel-registry.json. This bypasses the
 * brain so Jarvis stops trying to grep credentials, write helper scripts, or
 * edit admin-api.js to figure out how to do it (which gets blocked by the
 * permission hooks). Mirrors src/kanban-dispatch.js in shape.
 *
 * Returns `{ handled: false }` when no pattern matches so the caller falls
 * through to the brain.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname } from 'path';
import logger from '../logger.js';

const REGISTRY_PATH =
  process.env.CHANNEL_REGISTRY_PATH ||
  process.env.JARVIS_CHANNEL_REGISTRY ||
  `${process.env.HOME || '/tmp'}/dev/contexts/channel-registry.json`;

const DISCORD_API = 'https://discord.com/api/v10';

// Discord channel name rules: lowercase letters, digits, dashes, underscores;
// 2..100 chars. We auto-slugify spaces to dashes.
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;

// Optional leading wake-word + punctuation; trailing period tolerated.
const LEAD = /^(?:jarvis\s*[,.]?\s*)?/i;
const TAIL = /\s*\.?\s*$/;

// Patterns capture: 1 = channel name (raw), 2 = category name (raw)
//   "register a channel called <name> under <cat> [category] [in discord]"
//   "create a channel named <name> in (the) <cat> category"
//   "new channel <name> under <cat>"
//   "register channel: <name> under <cat>"
// Category capture is *non-greedy* and explicitly stops at the optional
// trailing " category" word and the trailing "in Discord" filler so
// "Engineering category in Discord" extracts just "Engineering".
const _CAT_TAIL = '(?:\\s+category)?(?:\\s+in\\s+discord)?';
const PATTERNS = [
  new RegExp(
    LEAD.source +
      /(?:register|create|add|make|new)\s+(?:a\s+)?(?:new\s+)?(?:discord\s+)?channel(?:\s+(?:called|named))?\s*[:\s]\s*["“'`]?([\w\s_-]+?)["”'`]?\s+(?:under|in|inside|within)\s+(?:the\s+)?["“'`]?([\w][\w\s_-]*?)["”'`]?/i
        .source +
      _CAT_TAIL +
      TAIL.source,
    'i',
  ),
  new RegExp(
    LEAD.source +
      /(?:register|create|add|make|new)\s+(?:a\s+)?(?:new\s+)?(?:discord\s+)?channel(?:\s+(?:called|named))?\s*[:\s]\s*["“'`]?([\w\s_-]+?)["”'`]?\s+(?:to|on)\s+(?:the\s+)?["“'`]?([\w][\w\s_-]*?)["”'`]?\s+category/i
        .source +
      TAIL.source,
    'i',
  ),
];

function _slugify(raw) {
  if (!raw) return '';
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}

function _normalizeCategory(raw) {
  if (!raw) return '';
  return String(raw).toLowerCase().trim().replace(/\s+/g, '-');
}

function _matchPattern(transcript) {
  const text = String(transcript || '').trim();
  if (!text) return null;
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (m) {
      const rawName = m[1]?.trim();
      const rawCategory = m[2]?.trim();
      if (!rawName || !rawCategory) continue;
      return { rawName, rawCategory };
    }
  }
  return null;
}

function _loadRegistry() {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function _saveRegistryAtomic(reg) {
  const tmp = `${REGISTRY_PATH}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, REGISTRY_PATH);
}

function _registryEntryExists(channelId) {
  const reg = _loadRegistry();
  return !!reg[channelId];
}

function _writeRegistryEntry(channelId, { name, categoryName, categoryId }) {
  const reg = _loadRegistry();
  reg[channelId] = {
    ...(reg[channelId] || {}),
    name,
    category: categoryName,
    categoryId,
    createdAt: new Date().toISOString(),
  };
  _saveRegistryAtomic(reg);
  return reg[channelId];
}

async function _discordFetch(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Resolve a category name to its Discord ID by listing guild channels.
 * Matches case-insensitively, allowing spaces or hyphens in the user's
 * spoken form to map to either form in Discord ("reverse engineering" ↔
 * "reverse-engineering" ↔ "Reverse Engineering").
 *
 * @param {string} guildId
 * @param {string} categoryName  human form, e.g. "engineering"
 * @param {string} token         Discord bot token
 * @returns {Promise<{ id: string, name: string } | null>}
 */
export async function resolveCategory(guildId, categoryName, token) {
  if (!guildId || !categoryName || !token) return null;
  const channels = await _discordFetch(`/guilds/${guildId}/channels`, { token });
  const wanted = _normalizeCategory(categoryName);
  // Discord category channels have type 4 (GUILD_CATEGORY)
  const categories = channels.filter(c => c.type === 4);
  for (const c of categories) {
    const norm = _normalizeCategory(c.name);
    if (norm === wanted) return { id: c.id, name: c.name };
  }
  // Fallback: substring match (e.g. "engineering" matches "Engineering Team")
  for (const c of categories) {
    const norm = _normalizeCategory(c.name);
    if (norm.includes(wanted) || wanted.includes(norm)) return { id: c.id, name: c.name };
  }
  return null;
}

/**
 * Create a text channel under a parent category and write a registry entry.
 *
 * @param {object} args
 * @param {string} args.guildId
 * @param {string} args.name         slugified channel name
 * @param {string} args.categoryId
 * @param {string} args.categoryName
 * @param {string} args.token        bot token
 * @returns {Promise<{ channelId: string, name: string }>}
 */
export async function createAndRegisterChannel({ guildId, name, categoryId, categoryName, token }) {
  if (!CHANNEL_NAME_RE.test(name)) {
    throw new Error(`channel name "${name}" is not Discord-safe (lowercase letters, digits, hyphens, underscores)`);
  }
  // type 0 = GUILD_TEXT
  const created = await _discordFetch(`/guilds/${guildId}/channels`, {
    method: 'POST',
    token,
    body: { name, type: 0, parent_id: categoryId },
  });
  if (!created?.id) {
    throw new Error(`Discord returned no channel id: ${JSON.stringify(created).slice(0, 200)}`);
  }

  try {
    if (!existsSync(dirname(REGISTRY_PATH))) {
      logger.warn(`[channel-dispatch] registry dir missing: ${dirname(REGISTRY_PATH)} — channel created but not registered`);
    } else {
      _writeRegistryEntry(created.id, { name, categoryName, categoryId });
    }
  } catch (err) {
    logger.error(`[channel-dispatch] registry write failed: ${err.message}`);
    // Channel was created — don't undo. Surface the warning.
  }

  return { channelId: created.id, name: created.name || name };
}

/**
 * Try to handle a transcript as a channel-registration intent.
 *
 * @param {string} transcript
 * @param {object} [options]
 * @param {string} [options.guildId] - override DISCORD_GUILD_ID
 * @param {string} [options.token]   - override DISCORD_TOKEN
 * @returns {Promise<{handled: boolean, result?: string, voice?: string}>}
 */
export async function tryChannelDispatch(transcript, options = {}) {
  const matched = _matchPattern(transcript);
  if (!matched) return { handled: false };

  const token = options.token || process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
  const guildId = options.guildId || process.env.DISCORD_GUILD_ID;
  if (!token || !guildId) {
    logger.warn('[channel-dispatch] missing DISCORD_TOKEN or DISCORD_GUILD_ID');
    return {
      handled: true,
      result: '❌ Cannot register channel: DISCORD_TOKEN or DISCORD_GUILD_ID not set.',
      voice: 'Discord credentials are not configured.',
    };
  }

  const name = _slugify(matched.rawName);
  if (!name) {
    return {
      handled: true,
      result: `❌ Could not parse channel name from "${matched.rawName}".`,
      voice: 'I could not parse that channel name.',
    };
  }

  let cat;
  try {
    cat = await resolveCategory(guildId, matched.rawCategory, token);
  } catch (err) {
    logger.error(`[channel-dispatch] resolveCategory failed: ${err.message}`);
    return {
      handled: true,
      result: `❌ Failed to list guild categories: ${err.message}`,
      voice: 'I could not reach Discord to find the category.',
    };
  }
  if (!cat) {
    return {
      handled: true,
      result: `❌ No category matching "${matched.rawCategory}" found in this guild.`,
      voice: `I could not find a category named ${matched.rawCategory}.`,
    };
  }

  let created;
  try {
    created = await createAndRegisterChannel({
      guildId,
      name,
      categoryId: cat.id,
      categoryName: cat.name,
      token,
    });
  } catch (err) {
    logger.error(`[channel-dispatch] createAndRegisterChannel failed: ${err.message}`);
    return {
      handled: true,
      result: `❌ Failed to create channel: ${err.message}`,
      voice: 'I could not create the channel.',
    };
  }

  const registered = _registryEntryExists(created.channelId);
  const status = registered
    ? `Registered in \`${REGISTRY_PATH}\`.`
    : `⚠️ Channel created but registry write was skipped (directory missing).`;

  return {
    handled: true,
    result: `✅ Created <#${created.channelId}> under **${cat.name}**. ${status}`,
    voice: `Channel ${created.name} created under ${cat.name}.`,
  };
}

// Test-only export for unit tests
export const _internal = { _slugify, _normalizeCategory, _matchPattern };
