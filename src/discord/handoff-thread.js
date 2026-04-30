/**
 * handoff-thread — manage a "🔗 Handoff" thread per channel that holds the
 * pinned resume card. Keeps the main channel clean; thread is the persistent
 * dashboard for `handoff <channelId>` pastes.
 *
 * State file: ~/.local/state/jarvis-voice/handoff-pins.json
 *   { "<channelId>": { "threadId": "...", "pinMessageId": "...", "chatId": "..." } }
 */

import { ChannelType } from 'discord.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import logger from '../logger.js';

const THREAD_NAME = '🔗 Handoff';
const STATE_DIR  = process.env.JARVIS_STATE_DIR || `${process.env.HOME}/.local/state/jarvis-voice`;
const STATE_FILE = join(STATE_DIR, 'handoff-pins.json');

try { mkdirSync(STATE_DIR, { recursive: true }); } catch {}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (err) { logger.warn(`[handoff-thread] state write failed: ${err.message}`); }
}

/** Find the existing "🔗 Handoff" thread under a channel, or null. */
async function findExistingThread(channel) {
  try {
    const active = await channel.threads.fetchActive();
    for (const t of active.threads.values()) if (t.name === THREAD_NAME) return t;
    const archived = await channel.threads.fetchArchived({ limit: 50 });
    for (const t of archived.threads.values()) {
      if (t.name === THREAD_NAME) {
        await t.setArchived(false).catch(() => {});
        return t;
      }
    }
  } catch (err) {
    logger.warn(`[handoff-thread] thread lookup failed: ${err.message}`);
  }
  return null;
}

/** Get or create the handoff thread under this channel. */
async function ensureThread(channel) {
  const existing = await findExistingThread(channel);
  if (existing) return existing;
  try {
    return await channel.threads.create({
      name: THREAD_NAME,
      autoArchiveDuration: 10080, // 7 days
      type: ChannelType.PublicThread,
      reason: 'Jarvis handoff thread',
    });
  } catch (err) {
    logger.warn(`[handoff-thread] thread create failed: ${err.message}`);
    return null;
  }
}

/** Compose the resume-card markdown. */
function resumeCard({ channelId, threadId, chatId, model, directory }) {
  const target = threadId ? `${channelId} ${threadId}` : `${channelId}`;
  return [
    '🔗 **Continuing here.**',
    '',
    `**Session:** \`${chatId}\``,
    `**Model:**   \`${model}\``,
    `**Dir:**     \`${directory}\``,
    '',
    'Paste to resume anywhere:',
    '```bash',
    `handoff ${target}`,
    '```',
  ].join('\n');
}

/**
 * Post or update the resume card in the channel's handoff thread.
 * Also posts a single breadcrumb in the parent channel on first creation.
 *
 * @param {import('discord.js').TextChannel} parentChannel
 * @param {{channelId, threadId?, chatId, model, directory}} info
 * @returns {Promise<{thread, pinMessage}|null>}
 */
export async function postResumeCard(parentChannel, info) {
  if (!parentChannel?.threads?.create) {
    logger.warn('[handoff-thread] parent channel does not support threads');
    return null;
  }

  const thread = await ensureThread(parentChannel);
  if (!thread) return null;

  const body = resumeCard(info);
  const state = loadState();
  const prior = state[info.channelId];

  // Edit existing pinned card if we have it; otherwise post new + pin.
  if (prior?.pinMessageId) {
    try {
      const msg = await thread.messages.fetch(prior.pinMessageId);
      await msg.edit(body);
      state[info.channelId] = { ...prior, threadId: thread.id, chatId: info.chatId };
      saveState(state);
      return { thread, pinMessage: msg };
    } catch {
      // pin message deleted or not found — fall through to re-post
    }
  }

  const pinMessage = await thread.send(body);
  try { await pinMessage.pin(); } catch (err) {
    logger.warn(`[handoff-thread] pin failed: ${err.message}`);
  }

  state[info.channelId] = {
    threadId: thread.id,
    pinMessageId: pinMessage.id,
    chatId: info.chatId,
  };
  saveState(state);

  return { thread, pinMessage };
}

/**
 * Called when the gateway rotates a channel's chatId. Edits the pinned card +
 * posts a fresh "Session rotated" notice inside the handoff thread.
 *
 * @param {import('discord.js').Client} client
 * @param {{channelId, newChatId, oldChatId, model?, directory?}} evt
 */
export async function handleRotation(client, evt) {
  const state = loadState();
  const entry = state[evt.channelId];
  if (!entry?.threadId) {
    logger.info(`[handoff-thread] rotation for ${evt.channelId} — no thread yet, skipping`);
    return;
  }

  let thread;
  try {
    thread = await client.channels.fetch(entry.threadId);
  } catch (err) {
    logger.warn(`[handoff-thread] rotation: cannot fetch thread ${entry.threadId}: ${err.message}`);
    return;
  }

  const body = resumeCard({
    channelId: evt.channelId,
    chatId: evt.newChatId,
    model: evt.model || 'claude-sonnet-4-6',
    directory: evt.directory || '~',
  });

  try {
    const msg = await thread.messages.fetch(entry.pinMessageId);
    await msg.edit(body);
  } catch {
    const fresh = await thread.send(body);
    try { await fresh.pin(); } catch {}
    state[evt.channelId] = { ...entry, pinMessageId: fresh.id };
  }

  await thread.send(`⟳ Session rotated → \`${evt.newChatId}\`. Resume command unchanged.`).catch(() => {});

  state[evt.channelId] = { ...(state[evt.channelId] || {}), chatId: evt.newChatId };
  saveState(state);
}
