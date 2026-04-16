/**
 * /spawn — Dedicated cursor-agent session in a Discord thread.
 *
 * Creates a thread from the interaction's channel, pins a live view message,
 * streams cursor-agent output to it every 2 s, posts final result when done.
 *
 * Thread lifetime = session lifetime. The thread persists as history.
 */

import { createLiveStream } from '../live-stream.js';
import logger from '../logger.js';

const GATEWAY_URL    = process.env.CLAWDBOT_GATEWAY_URL || 'http://127.0.0.1:22100';
const COMPLETIONS_URL = `${GATEWAY_URL}/v1/chat/completions`;
const GATEWAY_TOKEN  = process.env.CLAWDBOT_GATEWAY_TOKEN || '';
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN || '';

// Active spawns keyed by threadId → AbortController, so /stop can cancel
const _activeSessions = new Map();

/**
 * Handle a /spawn interaction.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function handleSpawnCommand(interaction) {
  const prompt = interaction.options.getString('prompt');
  if (!prompt) {
    await interaction.reply({ content: 'Prompt is required.', ephemeral: true });
    return;
  }

  // Defer immediately — thread creation + agent startup can take a few seconds
  await interaction.deferReply();

  const parentId = interaction.channelId;
  const taskSlug = prompt.slice(0, 48).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'agent session';

  // Create a thread in the parent channel
  let threadId;
  try {
    const res = await discordApi(`/channels/${parentId}/threads`, 'POST', {
      name: taskSlug,
      auto_archive_duration: 1440,
      type: 11, // GUILD_PUBLIC_THREAD
    });
    const data = await res.json();
    if (!data.id) throw new Error(JSON.stringify(data));
    threadId = data.id;
  } catch (err) {
    logger.error(`[spawn] thread creation failed: ${err.message}`);
    await interaction.editReply(`Failed to create thread: ${err.message}`);
    return;
  }

  await interaction.editReply(`Agent spawned in <#${threadId}>`);

  // Start live stream in the new thread
  const ls = await createLiveStream(threadId, DISCORD_TOKEN);

  const ac = new AbortController();
  _activeSessions.set(threadId, { ac, ls });

  // Fire off streaming call — don't await, runs in background
  _runStreamingAgent(prompt, threadId, ls, ac).finally(() => {
    _activeSessions.delete(threadId);
  });
}

/**
 * Handle /stop — cancels active spawn in the current thread.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function handleStopCommand(interaction) {
  const threadId = interaction.channelId;
  const session = _activeSessions.get(threadId);
  if (!session) {
    await interaction.reply({ content: 'No active spawn in this thread.', ephemeral: true });
    return;
  }
  session.ac.abort();
  session.ls.stop();
  _activeSessions.delete(threadId);
  await interaction.reply({ content: 'Agent stopped.', ephemeral: false });
}

async function _runStreamingAgent(prompt, threadId, ls, ac) {
  const channelKey = `spawn:${threadId}`;
  let finalText = '';

  try {
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: 'openclaw',
        stream: true,
        user: channelKey,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ac.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gateway ${res.status}: ${body}`);
    }

    // Read SSE stream and forward deltas to live-stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let partial = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      partial += decoder.decode(value, { stream: true });
      const lines = partial.split('\n');
      partial = lines.pop(); // hold last incomplete line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;
        try {
          const chunk = JSON.parse(trimmed.slice(6));
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (delta) {
            ls.update(delta);
            finalText += delta;
          }
        } catch { /* skip malformed SSE line */ }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.info(`[spawn] session ${threadId} aborted`);
      return;
    }
    logger.error(`[spawn] stream error: ${err.message}`);
    await ls.finish(`Error: ${err.message}`);
    return;
  }

  await ls.finish(finalText);
}

function discordApi(path, method = 'GET', body) {
  return fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
}
