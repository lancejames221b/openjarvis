/**
 * /skill — Invoke a Claude Code skill as a Discord agent task.
 *
 * Reads skill markdown from SKILLS_DIR (env, default ~/.claude/skills),
 * injects the skill content + user args into a spawn thread.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { createLiveStream } from '../live-stream.js';
import logger from '../logger.js';

const GATEWAY_URL     = process.env.JARVIS_GATEWAY_URL || 'http://127.0.0.1:22100';
const COMPLETIONS_URL = `${GATEWAY_URL}/v1/chat/completions`;
const GATEWAY_TOKEN   = process.env.JARVIS_GATEWAY_TOKEN || '';
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN || '';
const MODEL_DEFAULT   = process.env.DEFAULT_MODEL || 'claude';

// Skills directory — configurable via env, defaults to ~/.claude/skills
const SKILLS_DIR = process.env.SKILLS_DIR
  ? resolve(process.env.SKILLS_DIR)
  : join(homedir(), '.claude', 'skills');

// Active skill sessions keyed by threadId
const _activeSessions = new Map();

/** Return list of available skill names (directories containing SKILL.md). */
export function listSkills() {
  try {
    if (!existsSync(SKILLS_DIR)) return [];
    return readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(SKILLS_DIR, d.name, 'SKILL.md')))
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Read a skill's SKILL.md content. Returns null if not found. */
function _readSkill(name) {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '');
  const skillFile = join(SKILLS_DIR, safe, 'SKILL.md');
  try {
    return existsSync(skillFile) ? readFileSync(skillFile, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

/**
 * Handle /skill interaction.
 */
export async function handleSkillCommand(interaction) {
  const skillName = interaction.options.getString('name');
  const args = interaction.options.getString('args') || '';

  const content = _readSkill(skillName);
  if (!content) {
    const available = listSkills();
    const hint = available.length
      ? `Available: ${available.join(', ')}`
      : `No skills found in ${SKILLS_DIR}`;
    await interaction.reply({ content: `Skill \`${skillName}\` not found. ${hint}`, ephemeral: true });
    return;
  }

  await interaction.deferReply();

  const parentId = interaction.channelId;
  const threadName = args
    ? `${skillName}: ${args}`.slice(0, 48)
    : skillName.slice(0, 48);

  // Create thread
  let threadId;
  try {
    const res = await _discordApi(`/channels/${parentId}/threads`, 'POST', {
      name: threadName,
      auto_archive_duration: 1440,
      type: 11,
    });
    const data = await res.json();
    if (!data.id) throw new Error(JSON.stringify(data));
    threadId = data.id;
  } catch (err) {
    logger.error(`[skill] thread creation failed: ${err.message}`);
    await interaction.editReply(`Failed to create thread: ${err.message}`);
    return;
  }

  if (_activeSessions.has(threadId)) {
    await interaction.editReply(`Agent already running in <#${threadId}>.`);
    return;
  }

  await interaction.editReply(`Skill \`${skillName}\` running in <#${threadId}>`);

  let ls;
  try {
    ls = await createLiveStream(threadId, DISCORD_TOKEN);
  } catch (err) {
    logger.error(`[skill] live-stream init failed: ${err.message}`);
    await interaction.editReply(`Failed to start live stream: ${err.message}`);
    return;
  }

  const ac = new AbortController();
  _activeSessions.set(threadId, { ac, ls });

  const prompt = args
    ? `${content}\n\n---\nArguments: ${args}`
    : content;

  _runSkillAgent(prompt, skillName, threadId, ls, ac).finally(() => {
    _activeSessions.delete(threadId);
  });
}

async function _runSkillAgent(prompt, skillName, threadId, ls, ac) {
  logger.info(`[skill] running skill=${skillName} thread=${threadId}`);
  let finalText = '';

  try {
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: MODEL_DEFAULT,
        stream: true,
        user: `skill:${threadId}`,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ac.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gateway ${res.status}: ${body}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let partial = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      partial += decoder.decode(value, { stream: true });
      const lines = partial.split('\n');
      partial = lines.pop();
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
        } catch { /* skip malformed SSE */ }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.info(`[skill] session ${threadId} aborted`);
      return;
    }
    logger.error(`[skill] stream error: ${err.message}`);
    await ls.finish(`Error: ${err.message}`);
    return;
  }

  await ls.finish(finalText);
}

function _discordApi(path, method = 'GET', body) {
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
