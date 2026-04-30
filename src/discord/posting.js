/**
 * posting.js — Discord channel posting helpers.
 *
 * Extracted from src/index.js. Handles all outbound Discord message delivery:
 * - postToCC, postToTextChannel, postToChannel, postActivity
 * - sendDM, formatForDiscord, postTranscriptThread
 * - resolveVisualChannel, truncate, _buildAttachmentContext
 */

import logger from '../logger.js';
import { getVisualTargetChannel } from '../visual-mode.js';
import { discordRef } from '../state/runtime.js';

// Env-based channel IDs — read at call time so they pick up env correctly
function _textChannelId() { return process.env.DISCORD_TEXT_CHANNEL_ID; }
function _ccChannelId() { return process.env.DISCORD_CC_CHANNEL_ID; }
function _activityChannelId() { return process.env.DISCORD_ACTIVITY_CHANNEL_ID || process.env.DISCORD_TEXT_CHANNEL_ID; }
function _voiceReportChannelId() { return process.env.VOICE_REPORT_CHANNEL_ID || process.env.DISCORD_TEXT_CHANNEL_ID; }
function _activityFeedEnabled() { return process.env.ACTIVITY_FEED_ENABLED !== 'false'; }

// ── Helpers ───────────────────────────────────────────────────────────

export function truncate(str, len = 80) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '...' : str;
}

// ── Closed Captions ───────────────────────────────────────────────────

export async function postToCC(prefix, text) {
  const CC_CHANNEL_ID = _ccChannelId();
  if (!CC_CHANNEL_ID) return;
  const client = discordRef.client;
  if (!client) return;
  try {
    const channel = client.channels.cache.get(CC_CHANNEL_ID);
    if (!channel) return;
    const msg = `${prefix} ${text}`.substring(0, 2000);
    await channel.send(msg);
  } catch (err) {
    logger.warn(`CC post failed: ${err.message}`);
  }
}

// ── Text Channel ──────────────────────────────────────────────────────

export async function postToTextChannel(message, options = {}) {
  const client = discordRef.client;
  let targetId = options.forceChannelId;

  if (!targetId) {
    try {
      const { getFocus } = await import('../state/focus-state.js');
      const focus = getFocus();
      if (focus && focus.channelId) targetId = focus.channelId;
    } catch (e) {}
  }

  if (!targetId) targetId = _textChannelId();

  if (!targetId) {
    logger.warn('⚠️  No text channel configured, skipping channel post');
    return false;
  }

  try {
    const channel = client?.channels?.cache?.get(targetId);
    if (!channel) {
      logger.error(`❌ Channel ${targetId} not found in cache`);
      return false;
    }
    logger.info(`📤 Posting to ${channel.name} (${targetId})...`);
    await channel.send(message);
    logger.info(`✅ Posted to ${channel.name} successfully`);
    return true;
  } catch (err) {
    logger.error(`❌ Failed to post to channel: ${err.message}`);
    return false;
  }
}

// ── Generic Channel ───────────────────────────────────────────────────

export async function postToChannel(channelId, message) {
  const client = discordRef.client;
  try {
    const channel = client?.channels?.cache?.get(channelId);
    if (!channel) {
      logger.warn(`[visual-mode] Channel ${channelId} not in cache, attempting fetch`);
      const fetched = await client?.channels?.fetch(channelId).catch(() => null);
      if (!fetched) {
        logger.error(`[visual-mode] Channel ${channelId} not found`);
        return null;
      }
      return await fetched.send(typeof message === 'string' ? { content: message.substring(0, 2000) } : message);
    }
    return await channel.send(typeof message === 'string' ? { content: message.substring(0, 2000) } : message);
  } catch (err) {
    logger.error(`[visual-mode] Failed to post to ${channelId}: ${err.message}`);
    return null;
  }
}

// ── Activity Feed ─────────────────────────────────────────────────────

export async function postActivity(message) {
  const ACTIVITY_CHANNEL_ID = _activityChannelId();
  const ACTIVITY_FEED_ENABLED = _activityFeedEnabled();
  const client = discordRef.client;
  if (!ACTIVITY_FEED_ENABLED || !ACTIVITY_CHANNEL_ID || !client?.isReady()) return;
  try {
    const channel = client.channels.cache.get(ACTIVITY_CHANNEL_ID);
    if (channel) return await channel.send(message);
  } catch (err) {
    logger.error('Activity post failed:', err.message);
  }
  return null;
}

// ── Direct Message ────────────────────────────────────────────────────

export async function sendDM(userId, message) {
  const client = discordRef.client;
  try {
    const user = await client.users.fetch(userId);
    logger.info(`📤 Sending DM to user ${userId}...`);
    await user.send(message);
    logger.info(`✅ DM sent successfully`);
    return true;
  } catch (err) {
    logger.error(`❌ Failed to send DM: ${err.message}`);
    return false;
  }
}

// ── Format For Discord ────────────────────────────────────────────────

export function formatForDiscord(text) {
  if (!text) return '';
  let formatted = text
    .replace(/<p>/g, '\n\n')
    .replace(/<\/p>/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\[tts:[^\]]*\]\]/g, '')
    .replace(/\[\[\/tts:[^\]]*\]\]/g, '')
    .replace(/\[\[reply_to[^\]]*\]\]/g, '')
    .replace(/\[\[(?:tts|reply_to)[^\]]*$/g, '')
    .replace(/^\]\]/g, '')
    .replace(/\]\]\s*/g, '')
    .replace(/(?:^|\s)_?NO_?REPLY(?:\s|[.!?]|$)/gi, ' ')
    .replace(/(?:^|\s)HEARTBEAT_?OK(?:\s|[.!?]|$)/gi, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return formatted;
}

// ── Transcript Thread ─────────────────────────────────────────────────

export async function postTranscriptThread(taskId, userTranscript, jarvisResponse, duration) {
  const VOICE_REPORT_CHANNEL_ID = _voiceReportChannelId();
  const TEXT_CHANNEL_ID = _textChannelId();
  const targetChannelId = VOICE_REPORT_CHANNEL_ID || TEXT_CHANNEL_ID;
  const client = discordRef.client;
  if (!targetChannelId) {
    logger.warn('⚠️  No text channel configured, skipping transcript thread');
    return false;
  }

  try {
    const channel = client?.channels?.cache?.get(targetChannelId);
    if (!channel) {
      logger.error(`❌ Channel ${targetChannelId} not found in cache`);
      return false;
    }

    logger.info(`📤 Posting voice transcript thread (task #${taskId}) to ${channel.name} (#hud)...`);
    const initialMsg = await channel.send(`🎙️ **Task #${taskId}** | You: ${userTranscript}`);

    const thread = await initialMsg.startThread({
      name: `Task #${taskId}: ${userTranscript.substring(0, 40)}${userTranscript.length > 40 ? '...' : ''}`,
      autoArchiveDuration: 1440,
    });

    await thread.send(`**Jarvis Response:**\n${jarvisResponse}\n\n_Task completed in ${duration}s_`);

    logger.info(`✅ Posted voice transcript thread (task #${taskId}) to ${channel.name}`);
    return true;
  } catch (err) {
    logger.error(`❌ Failed to post transcript thread: ${err.message}`);
    return false;
  }
}

// ── Visual Channel Resolution ─────────────────────────────────────────

export async function resolveVisualChannel() {
  const explicit = getVisualTargetChannel();
  if (explicit) return explicit;
  try {
    const { getFocus } = await import('../state/focus-state.js');
    const focus = getFocus();
    if (focus?.channelId) return focus.channelId;
  } catch {}
  return process.env.VOICE_REPORT_CHANNEL_ID || process.env.DISCORD_TEXT_CHANNEL_ID;
}

// ── Attachment Context Builder ────────────────────────────────────────

const _TEXT_EXTS = new Set([
  'txt','md','js','mjs','cjs','ts','tsx','jsx','json','jsonc','yaml','yml',
  'sh','bash','zsh','py','rb','go','rs','java','c','cpp','h','hpp','cs','php',
  'html','css','scss','sql','toml','ini','cfg','conf','env','log','csv',
]);
const _IMAGE_TYPES = new Set(['image/png','image/jpeg','image/gif','image/webp','image/jpg']);
const _MAX_FILE_BYTES = 50_000;

export async function _buildAttachmentContext(attachments) {
  if (!attachments || attachments.size === 0) return '';
  const fetch = (await import('node-fetch')).default;
  let ctx = '';
  for (const a of attachments.values()) {
    if (a.contentType?.includes('audio/ogg') || a.url?.endsWith('.ogg')) continue;
    const ext = a.name?.split('.').pop()?.toLowerCase() || '';
    if (_IMAGE_TYPES.has(a.contentType?.split(';')[0]?.trim()) || ['png','jpg','jpeg','gif','webp'].includes(ext)) {
      ctx += `\n\n[Image attachment: ${a.url}]`;
    } else if (_TEXT_EXTS.has(ext)) {
      try {
        const res = await fetch(a.url, { signal: AbortSignal.timeout(8_000) });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (buf.byteLength <= _MAX_FILE_BYTES) {
            const text = Buffer.from(buf).toString('utf8');
            ctx += `\n\n[File: ${a.name}]\n\`\`\`\n${text}\n\`\`\``;
          } else {
            ctx += `\n\n[File too large to inline: ${a.name} — ${a.url}]`;
          }
        }
      } catch { ctx += `\n\n[Attached file: ${a.name} — ${a.url}]`; }
    } else {
      ctx += `\n\n[Attached file: ${a.name} — ${a.url}]`;
    }
  }
  return ctx;
}
