/**
 * live-stream.js — Pinned-message live updater for in-flight cursor-agent runs.
 *
 * Creates a message in a Discord thread, pins it, and edits it every 2 s as
 * new NDJSON deltas arrive. Hash-diff prevents redundant API calls. Truncates
 * to 1900 chars from the end so the most recent output is always visible.
 *
 * Usage:
 *   const ls = await createLiveStream(threadId, botToken);
 *   ls.update(textDelta);   // called per NDJSON delta
 *   await ls.finish(full);  // final text; unpins + posts clean summary
 *   ls.stop();              // emergency stop without finish
 */

import logger from './logger.js';

const TICK_MS = 2_000;
const MAX_LEN  = 1_900;

/**
 * @param {string} channelId   Discord channel or thread ID to post into
 * @param {string} botToken    Discord bot token
 * @returns {{ update(delta: string): void, finish(finalText: string): Promise<void>, stop(): void }}
 */
export async function createLiveStream(channelId, botToken) {
  const headers = {
    Authorization: `Bot ${botToken}`,
    'Content-Type': 'application/json',
  };
  const api = (path, method = 'GET', body) =>
    fetch(`https://discord.com/api/v10${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8_000),
    });

  // Create the initial placeholder message
  let msgId;
  try {
    const res = await api(`/channels/${channelId}/messages`, 'POST', {
      content: '```\nAgent starting...\n```',
    });
    const data = await res.json();
    msgId = data.id;
  } catch (err) {
    logger.warn(`[live-stream] Failed to create live message: ${err.message}`);
    return _noop();
  }

  // Pin it
  try {
    await api(`/channels/${channelId}/pins/${msgId}`, 'PUT');
  } catch { /* non-fatal — still update even if pin fails */ }

  let buf = '';
  let lastHash = '';
  let done = false;

  function _hash(s) {
    // djb2 — fast enough, no deps
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
    return (h >>> 0).toString(16);
  }

  async function _edit(content) {
    try {
      await api(`/channels/${channelId}/messages/${msgId}`, 'PATCH', { content });
    } catch (err) {
      logger.warn(`[live-stream] edit failed: ${err.message}`);
    }
  }

  // 2 s ticker — only edits when content has changed
  const ticker = setInterval(async () => {
    if (done) return;
    const display = _truncate(buf);
    const h = _hash(display);
    if (h === lastHash) return;
    lastHash = h;
    await _edit('```\n' + display + '\n```');
  }, TICK_MS);

  function update(delta) {
    if (done) return;
    buf += delta;
  }

  async function finish(finalText) {
    done = true;
    clearInterval(ticker);

    // Unpin the live message
    try {
      await api(`/channels/${channelId}/pins/${msgId}`, 'DELETE');
    } catch { /* non-fatal */ }

    // Replace live message with "done" marker
    await _edit('```\n[done]\n```');

    // Post final result as a new message (chunked if needed)
    const text = (finalText || '').trim() || '(no output)';
    const chunks = _chunkText(text, 1_900);
    for (const chunk of chunks) {
      try {
        await api(`/channels/${channelId}/messages`, 'POST', { content: chunk });
      } catch (err) {
        logger.warn(`[live-stream] failed to post final chunk: ${err.message}`);
      }
    }
  }

  function stop() {
    done = true;
    clearInterval(ticker);
  }

  return { update, finish, stop };
}

function _truncate(s) {
  if (s.length <= MAX_LEN) return s;
  return '…' + s.slice(-(MAX_LEN - 1));
}

function _chunkText(text, max) {
  const out = [];
  while (text.length > 0) {
    out.push(text.slice(0, max));
    text = text.slice(max);
  }
  return out;
}

function _noop() {
  return {
    update() {},
    async finish() {},
    stop() {},
  };
}
