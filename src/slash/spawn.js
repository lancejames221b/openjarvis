/**
 * /spawn — Dedicated agent session in a Discord thread.
 *
 * Creates a thread from the interaction's channel, pins a live view message,
 * streams agent output to it every 2 s, posts final result when done.
 * Model is chosen by the `model` option or auto-selected from the prompt keywords.
 *
 * Thread lifetime = session lifetime. The thread persists as history.
 */

import { createLiveStream } from '../live-stream.js';
import { setMcpMode } from '../channel-mcp-mode.js';
import { verboseSessions } from '../verbose-sessions.js';
import { abortAllVoiceTasks } from '../voice-tasks.js';
import logger from '../logger.js';

const GATEWAY_URL      = process.env.JARVIS_GATEWAY_URL || 'http://127.0.0.1:22100';
const COMPLETIONS_URL  = `${GATEWAY_URL}/v1/chat/completions`;
const GATEWAY_TOKEN    = process.env.JARVIS_GATEWAY_TOKEN || '';
const DISCORD_TOKEN    = process.env.DISCORD_TOKEN || '';
const MODEL_DEFAULT    = process.env.DISPATCH_MODEL || process.env.DEFAULT_MODEL || 'claude';
const MODEL_DEEP       = process.env.DISPATCH_MODEL_DEEP || MODEL_DEFAULT;

// Prompts matching these keywords get the deep/opus model; others get the default.
const DEEP_INTENT_RE = /\b(analyz|audit|research|investigat|deep\s+dive|review|explain|compare|architect|design|refactor|debug|diagnos|secur|vulnerab|threaten?|incident|forensic)\b/i;

function _selectModel(prompt) {
  return DEEP_INTENT_RE.test(prompt) ? MODEL_DEEP : MODEL_DEFAULT;
}

// Active spawns keyed by threadId → AbortController, so /stop can cancel
const _activeSessions = new Map();

const _TEXT_EXTS = new Set(['txt','md','js','ts','py','sh','json','yaml','yml','toml','env','log','csv','html','css','xml','sql','rs','go','java','c','cpp','h']);
const _MAX_ATTACH_BYTES = 200_000;

async function _attachmentSuffix(attachment) {
  const ext = attachment.name?.split('.').pop()?.toLowerCase() || '';
  const ct = attachment.contentType?.split(';')[0]?.trim() || '';
  if (['image/png','image/jpeg','image/gif','image/webp'].includes(ct) || ['png','jpg','jpeg','gif','webp'].includes(ext)) {
    return `\n\n[Attached image: ${attachment.url}]`;
  }
  if (_TEXT_EXTS.has(ext) || ct.startsWith('text/')) {
    try {
      const res = await fetch(attachment.url, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        if (buf.byteLength <= _MAX_ATTACH_BYTES) {
          const text = Buffer.from(buf).toString('utf8');
          return `\n\n[File: ${attachment.name}]\n\`\`\`\n${text}\n\`\`\``;
        }
      }
    } catch { /* fall through to URL */ }
  }
  return `\n\n[Attached file: ${attachment.name} — ${attachment.url}]`;
}

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
  const explicitModel = interaction.options.getString('model') || null;
  const attachment = interaction.options.getAttachment('file') || null;
  const fullPrompt = attachment ? prompt + await _attachmentSuffix(attachment) : prompt;

  // Defer immediately — thread creation + agent startup can take a few seconds
  await interaction.deferReply();

  const parentId = interaction.channelId;
  const taskSlug = fullPrompt.slice(0, 48).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'agent session';

  // Resolve where to stream: create a thread if the channel supports it,
  // otherwise stream directly into the current channel/thread.
  const THREAD_TYPES     = new Set([10, 11, 12]); // already a thread — use as-is
  const THREADABLE_TYPES = new Set([0, 5]);        // text / announcement — can create threads

  let threadId;
  let newThread = false;
  try {
    const chanRes  = await discordApi(`/channels/${parentId}`);
    const chanData = await chanRes.json();
    const chanType = chanData.type;

    if (THREAD_TYPES.has(chanType)) {
      // Already inside a thread — stream here directly
      threadId = parentId;
    } else if (THREADABLE_TYPES.has(chanType)) {
      const res = await discordApi(`/channels/${parentId}/threads`, 'POST', {
        name: taskSlug,
        auto_archive_duration: 1440,
        type: 11, // GUILD_PUBLIC_THREAD
      });
      const data = await res.json();
      if (!data.id) throw new Error(JSON.stringify(data));
      threadId = data.id;
      newThread = true;
    } else {
      // Voice, DM, stage, etc. — fall back to current channel
      threadId = parentId;
    }
  } catch (err) {
    logger.error(`[spawn] channel setup failed: ${err.message}`);
    await interaction.editReply(`Failed to set up agent channel: ${err.message}`);
    return;
  }

  // B7 guard: refuse to double-spawn into a thread that already has an active session
  if (_activeSessions.has(threadId)) {
    await interaction.editReply(`Agent already running in <#${threadId}>. Use /stop first.`);
    return;
  }

  // Dedicated agent threads get full MCP — this is where the user explicitly
  // asked for agent power. The normal voice back-and-forth (#jarvis-voice) stays
  // on the fast empty-MCP path; heavy tool work routes through /spawn threads.
  if (newThread) {
    try { setMcpMode(threadId, 'full'); } catch (err) { logger.warn(`[spawn] setMcpMode failed: ${err.message}`); }
  }

  await interaction.editReply(
    newThread ? `Agent spawned in <#${threadId}>` : 'Agent running in this thread...'
  );

  // Start live stream in the new thread. Throws if Discord rejects the pin-message
  // create call — surface the error rather than running agent against a no-op sink.
  let ls;
  try {
    ls = await createLiveStream(threadId, DISCORD_TOKEN);
  } catch (err) {
    logger.error(`[spawn] live-stream init failed: ${err.message}`);
    await interaction.editReply(`Failed to start live stream: ${err.message}`);
    return;
  }

  const ac = new AbortController();
  _activeSessions.set(threadId, { ac, ls });

  // Fire off streaming call — don't await, runs in background
  _runStreamingAgent(fullPrompt, threadId, ls, ac, explicitModel).finally(() => {
    _activeSessions.delete(threadId);
  });
}

/**
 * Handle /stop — cancels active spawn in the current thread.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function handleStopCommand(interaction) {
  const channelId = interaction.channelId;

  // Check spawn session (thread-based agent)
  const spawnSession = _activeSessions.get(channelId);
  if (spawnSession) {
    spawnSession.ac.abort();
    spawnSession.ls.stop();
    _activeSessions.delete(channelId);
    await interaction.reply({ content: 'Agent stopped.', ephemeral: false });
    return;
  }

  // Check verbose text-channel stream
  const verboseSession = verboseSessions.get(channelId);
  if (verboseSession) {
    verboseSession.ac.abort();
    verboseSession.ls.stop();
    verboseSessions.delete(channelId);
    await interaction.reply({ content: 'Response stopped.', ephemeral: false });
    return;
  }

  // Fall back to aborting voice tasks (microphone-triggered tasks in index.js)
  const aborted = abortAllVoiceTasks();
  if (aborted > 0) {
    await interaction.reply({ content: `Stopped ${aborted} active voice task${aborted > 1 ? 's' : ''}.`, ephemeral: false });
    return;
  }

  await interaction.reply({ content: 'No active agent or response in this channel.', ephemeral: true });
}

async function _runStreamingAgent(prompt, threadId, ls, ac, explicitModel = null) {
  const channelKey = `spawn:${threadId}`;
  const model = explicitModel || _selectModel(prompt);
  let finalText = '';
  logger.info(`[spawn] model=${model} thread=${threadId}`);

  try {
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model,
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

/**
 * Voice-triggered spawn: create a thread in textChannelId, stream agent, post result.
 * Returns the threadId so the caller can mention it in a voice ack.
 * @param {string} task           - the task/prompt from voice transcript
 * @param {string} textChannelId  - Discord text channel to create the thread in
 * @param {string} botToken       - Discord bot token
 * @returns {Promise<string>}     - threadId of the created thread
 */
export async function runVoiceSpawn(task, textChannelId, botToken, model = null) {
  const taskSlug = task.slice(0, 48).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'agent session';

  // Create thread
  const res = await fetch(`https://discord.com/api/v10/channels/${textChannelId}/threads`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: taskSlug, auto_archive_duration: 1440, type: 11 }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (!data.id) throw new Error(`Thread creation failed: ${JSON.stringify(data)}`);
  const threadId = data.id;

  // B7 guard: fresh thread can't already have an active session, but be defensive
  // in case the caller retries with the same threadId on transient errors.
  if (_activeSessions.has(threadId)) {
    logger.warn(`[spawn] runVoiceSpawn: thread ${threadId} already active, skipping duplicate`);
    return threadId;
  }

  // Same rule as the slash path above — agent threads get full MCP.
  try { setMcpMode(threadId, 'full'); } catch (err) { logger.warn(`[spawn] setMcpMode failed: ${err.message}`); }

  // Start live stream and fire off agent (background — does not block caller).
  // createLiveStream throws if Discord rejects the pin-message create call —
  // let it propagate so the caller can post a plain-text fallback.
  const ls = await createLiveStream(threadId, botToken);
  const ac = new AbortController();
  _activeSessions.set(threadId, { ac, ls });
  _runStreamingAgent(task, threadId, ls, ac, model).finally(() => _activeSessions.delete(threadId));

  return threadId;
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
