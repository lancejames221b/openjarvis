/**
 * channel-topic — read/write a Jarvis metadata block into a Discord channel's
 * topic field. Acts as a durable backup/mirror of the channel-registry entry
 * so if the local registry is wiped, the topic recovers it.
 *
 * Format (trailing block, one line, single delimiter):
 *
 *   <user's existing topic>
 *
 *   [jarvis] dir=$HOME/Dev/ewitness | model=claude-opus-4-7 | session=9c9d...
 *
 * Parser is tolerant — extra pipes and equals inside the dir path are fine
 * because we split on ' | ' and 'key=' prefix.
 */

import { readFileSync, writeFileSync } from 'fs';
import logger from './logger.js';

const MARKER = '[jarvis]';
const TOPIC_MAX = 1024;
const REGISTRY = process.env.JARVIS_CHANNEL_REGISTRY || `${process.env.HOME}/dev/contexts/channel-registry.json`;

// ── Registry helpers ──────────────────────────────────────────────────

export function loadRegistry() {
  try { return JSON.parse(readFileSync(REGISTRY, 'utf8')); } catch { return {}; }
}

export function saveRegistry(reg) {
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
}

// ── Topic parse / serialize ───────────────────────────────────────────

/**
 * Parse a topic string. Returns { prefix, meta } where meta is the k/v block
 * as an object (possibly empty). Prefix is the original topic with the jarvis
 * block stripped.
 */
export function parseTopic(topic) {
  if (!topic) return { prefix: '', meta: {} };
  const idx = topic.lastIndexOf(MARKER);
  if (idx < 0) return { prefix: topic.trim(), meta: {} };
  const prefix = topic.slice(0, idx).trim();
  const block = topic.slice(idx + MARKER.length).trim();
  const meta = {};
  for (const part of block.split('|').map(s => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const key = part.slice(0, eq).trim();
      const val = part.slice(eq + 1).trim();
      if (key) meta[key] = val;
    }
  }
  return { prefix, meta };
}

/** Serialize a topic with an embedded jarvis meta block. */
export function formatTopic(prefix, meta) {
  const pairs = Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`);
  const block = pairs.length ? `${MARKER} ${pairs.join(' | ')}` : '';
  const combined = prefix ? `${prefix}\n\n${block}` : block;
  // Topics capped at 1024 — trim prefix if needed
  if (combined.length <= TOPIC_MAX) return combined;
  const overrun = combined.length - TOPIC_MAX;
  const trimmedPrefix = prefix.slice(0, Math.max(0, prefix.length - overrun - 4)) + '...';
  return `${trimmedPrefix}\n\n${block}`;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Write jarvis metadata to a channel's topic, preserving whatever prefix text
 * was there. Also upserts the registry entry for this channel.
 */
export async function setChannelMeta(channel, meta) {
  if (!channel?.setTopic) throw new Error('channel does not support topics (is this a thread?)');

  const existing = channel.topic || '';
  const { prefix } = parseTopic(existing);
  const nextTopic = formatTopic(prefix, meta);
  await channel.setTopic(nextTopic, 'jarvis /init');

  // Registry mirror
  const reg = loadRegistry();
  const id = channel.id;
  reg[id] = { ...(reg[id] || {}), ...meta };
  if (!reg[id].name && channel.name) reg[id].name = channel.name;
  saveRegistry(reg);

  logger.info(`[channel-topic] ${channel.name || id} updated: ${Object.keys(meta).join(', ')}`);
  return nextTopic;
}

/**
 * Read a channel's topic and return the parsed jarvis metadata block.
 */
export function getChannelMeta(channel) {
  const topic = channel?.topic || '';
  return parseTopic(topic).meta;
}

/**
 * Hydrate the registry from channel topics. Intended to run at bot startup —
 * if a channel has a [jarvis] block in its topic but no local registry entry,
 * pull it back in. Returns the count of hydrated entries.
 */
export async function hydrateRegistryFromTopics(client, guildId) {
  const reg = loadRegistry();
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return 0;
  const channels = await guild.channels.fetch();
  let hydrated = 0;
  for (const c of channels.values()) {
    if (!c || !c.topic) continue;
    const { meta } = parseTopic(c.topic);
    if (!Object.keys(meta).length) continue;
    const existing = reg[c.id] || {};
    const merged = { ...meta, ...existing }; // existing local fields win
    const added = Object.keys(meta).filter(k => !(k in existing));
    if (added.length) {
      reg[c.id] = merged;
      if (!reg[c.id].name) reg[c.id].name = c.name;
      hydrated++;
    }
  }
  if (hydrated) saveRegistry(reg);
  logger.info(`[channel-topic] hydrated ${hydrated} registry entries from channel topics`);
  return hydrated;
}
