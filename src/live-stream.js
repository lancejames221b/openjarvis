/**
 * live-stream.js — Pinned status-header + streaming body for in-flight agent runs.
 *
 * Creates a PINNED message in a Discord thread that renders a status header
 * (state · elapsed · tokens · model) above the most recent N chars of output.
 * Header stays visible and evolves through states: thinking → streaming → done.
 * On finish, header becomes a permanent summary stamp and the full text posts
 * as chunked replies below. The pin stays — so the top of the thread is always
 * a legible "what happened here" marker.
 *
 * Usage:
 *   const ls = await createLiveStream(threadId, botToken, { model });
 *   ls.update(textDelta);       // per streaming token/chunk
 *   await ls.finish(fullText);  // finalize (or ls.finishEmpty('no_response') if empty)
 *   ls.stop();                  // emergency stop (no cleanup)
 */

import logger from './logger.js';

const TICK_MS       = 2_000;
const MAX_BODY_LEN  = 1_700;  // leave headroom for header
const THINK_DOTS    = ['', '.', '..', '...'];

/**
 * @param {string} channelId    Discord channel or thread ID to post into
 * @param {string} botToken     Discord bot token
 * @param {object} [opts]
 * @param {string} [opts.model] Model label for the status header
 * @returns {{ update(delta: string): void, replace(text: string): void, finish(finalText: string): Promise<void>, finishEmpty(reason: string): Promise<void>, stop(): void }}
 */
export async function createLiveStream(channelId, botToken, opts = {}) {
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

  const startedAt = Date.now();
  const model = opts.model || 'claude';
  let state = 'thinking';   // thinking → streaming → done | empty | error
  let errorMsg = null;
  let emptyReason = null;

  // Create the initial pinned header message.
  let msgId;
  try {
    const res = await api(`/channels/${channelId}/messages`, 'POST', {
      content: _renderHeader({ state, startedAt, model, tokens: 0, body: '' }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Discord ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data?.id) throw new Error(`Discord returned no message id: ${JSON.stringify(data).slice(0, 200)}`);
    msgId = data.id;
  } catch (err) {
    logger.warn(`[live-stream] Failed to create live message: ${err.message}`);
    throw err;
  }

  // Pin — best-effort
  try {
    await api(`/channels/${channelId}/pins/${msgId}`, 'PUT');
  } catch { /* non-fatal — still update even if pin fails */ }

  let buf = '';
  let lastHash = '';
  let done = false;
  let tokens = 0;  // rough: chunks received

  function _hash(s) {
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

  // Ticker: re-render every 2s when visible state changed
  const ticker = setInterval(async () => {
    if (done) return;
    const rendered = _renderHeader({ state, startedAt, model, tokens, body: buf });
    const h = _hash(rendered);
    if (h === lastHash) return;
    lastHash = h;
    await _edit(rendered);
  }, TICK_MS);

  function update(delta) {
    if (done) return;
    if (state === 'thinking') state = 'streaming';
    buf += delta;
    tokens += 1;  // approximate: one delta = one "token"
  }

  function replace(text) {
    if (done) return;
    buf = text;
    if (state === 'thinking' && text) state = 'streaming';
  }

  async function finish(finalText) {
    done = true;
    clearInterval(ticker);
    state = 'done';

    const text = _dedupSentences((finalText || '').trim());
    if (!text || text.length < 2) {
      return finishEmpty('no_output');
    }

    // Render final header as a permanent summary — keeps the pin
    const header = _renderHeader({ state, startedAt, model, tokens, body: '', final: true });
    await _edit(header);

    // Post full text below as chunked replies (pin stays on header)
    const chunks = _chunkText(text, 1_900);
    for (const chunk of chunks) {
      try {
        await api(`/channels/${channelId}/messages`, 'POST', { content: chunk });
      } catch (err) {
        logger.warn(`[live-stream] failed to post final chunk: ${err.message}`);
      }
    }
  }

  async function finishEmpty(reason) {
    done = true;
    clearInterval(ticker);
    state = 'empty';
    emptyReason = reason || 'empty';
    const header = _renderHeader({ state, startedAt, model, tokens, body: '', emptyReason, final: true });
    await _edit(header);
  }

  async function finishError(err) {
    done = true;
    clearInterval(ticker);
    state = 'error';
    errorMsg = String(err?.message || err);
    const header = _renderHeader({ state, startedAt, model, tokens, body: '', errorMsg, final: true });
    await _edit(header);
  }

  function stop() {
    done = true;
    clearInterval(ticker);
  }

  return { update, replace, finish, finishEmpty, finishError, stop };
}

function _renderHeader({ state, startedAt, model, tokens, body, final = false, emptyReason = null, errorMsg = null }) {
  const elapsed = _fmtElapsed(Date.now() - startedAt);
  let statusLine;
  if (state === 'thinking') {
    const dots = THINK_DOTS[Math.floor((Date.now() / 600) % THINK_DOTS.length)];
    statusLine = `⏳ thinking${dots}  ·  ${elapsed}  ·  ${model}`;
  } else if (state === 'streaming') {
    statusLine = `▸ streaming  ·  ${elapsed}  ·  ${tokens} chunks  ·  ${model}`;
  } else if (state === 'done') {
    statusLine = `✓ done  ·  ${elapsed}  ·  ${tokens} chunks  ·  ${model}`;
  } else if (state === 'empty') {
    statusLine = `∅ no response  ·  ${elapsed}  ·  ${model}  ·  reason: ${emptyReason || 'unknown'}`;
  } else if (state === 'error') {
    statusLine = `⚠ error  ·  ${elapsed}  ·  ${model}  ·  ${(errorMsg || '').slice(0, 80)}`;
  } else {
    statusLine = `${state}  ·  ${elapsed}  ·  ${model}`;
  }

  if (final) {
    // Summary pin — no body block
    return `**${statusLine}**`;
  }

  const display = _truncate(body);
  return `**${statusLine}**\n\`\`\`\n${display || '(awaiting first output…)'}\n\`\`\``;
}

function _fmtElapsed(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

// Remove consecutively repeated sentences (model stutter artifact).
// Splits on sentence boundaries, drops exact consecutive duplicates.
function _dedupSentences(text) {
  const parts = text.split(/(?<=[.!?])\s+/);
  const out = [];
  for (const p of parts) {
    if (out.length === 0 || p !== out[out.length - 1]) out.push(p);
  }
  return out.join(' ');
}

function _truncate(s) {
  if (s.length <= MAX_BODY_LEN) return s;
  return '…' + s.slice(-(MAX_BODY_LEN - 1));
}

function _chunkText(text, max) {
  const out = [];
  while (text.length > 0) {
    out.push(text.slice(0, max));
    text = text.slice(max);
  }
  return out;
}
