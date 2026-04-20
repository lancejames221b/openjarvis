/**
 * session-setup.js — NL session hand-off handler.
 *
 * Intercepts owner messages BEFORE the LLM gateway for phrases like:
 *   "create a channel called openjarvis on gamez in Dev/openjarvis and start a claude session"
 *   "resume openjarvis on gamez"
 *   "map openjarvis to gamez"
 *
 * Flow for CREATE+MAP+START:
 *   1. Create Discord text channel
 *   2. Persist channel → {box, cwd} in data/project-map.json
 *   3. Start a tmux session (claude --continue) in that channel via startSessionDirect
 *
 * Flow for RESUME:
 *   1. Look up channel by name in project-map.json
 *   2. Start a new tmux session in that channel
 *
 * SECURITY: Owner-only (isOwner check). Requires SESSION_SHELL_ENABLED=true.
 */

import { getBox, getBoxByName, getCwd } from './slash/box-state.js';
import { isOwner } from './channel-access.js';
import { setProjectMap, deleteProjectMap, findProjectMapByName } from './slash/project-map.js';
import { startSessionDirect, buildResumeCommand } from './slash/session.js';
import logger from './logger.js';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const GUILD_ID      = process.env.DISCORD_GUILD_ID || '';
const ENABLED       = process.env.SESSION_SHELL_ENABLED === 'true';

// ── Regex patterns ────────────────────────────────────────────────────────────

const CREATE_RE = /\b(?:create|make|set up)\s+(?:a\s+)?channel\s+(?:called|named|for)?\s*[#]?(\w[\w-]*)\s+(?:on|for|mapped?\s*to|using)\s+(\w+)/i;
const RESUME_RE = /\b(?:resume|continue|pick up|open|start)\s+(?:a\s+|my\s+|the\s+)?(?:session\s+(?:for|on|in)\s+)?[#]?(\w[\w-]*)\s+(?:on\s+)?(\w+)?/i;
const MAP_RE    = /\b(?:map|link|connect)\s+[#]?(\w[\w-]*)\s+(?:channel\s+)?to\s+(\w+)/i;
const PATH_RE   = /\b(?:in|at|under)\s+(~?\/[\w/.-]+|~\/[\w/.-]+|[\w]+\/[\w][\w/.-]*)/i;

// Stop RESUME_RE from matching generic "start <anything>" that isn't a project name
// by requiring either an explicit box name or a known project-map entry.
const RESUME_STOP = /\b(?:a|the)\s+(?:new\s+)?(?:session|meeting|timer|task|reminder)\b/i;

// Bare "continue" — no project name needed, picks up latest session in active cwd
const CONTINUE_RE = /^\s*(?:continue|keep going|pick up where (?:we|i) left off)\s*\.?\s*$/i;

// UUID resume — paste a session ID directly
const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

// Lightweight chat mode — "chat openjarvis", "chat", "quick chat about X"
const CHAT_RE = /^\s*(?:chat|quick chat|just chat)(?:\s+(?:about\s+)?(\w[\w-]*))?/i;

// ── Discord API helpers ───────────────────────────────────────────────────────

async function _createDiscordChannel(name, guildId) {
  const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    method: 'POST',
    headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type: 0 }), // type 0 = GUILD_TEXT
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (!data.id) throw new Error(`Channel creation failed: ${JSON.stringify(data).slice(0, 200)}`);
  return data.id;
}

async function _reply(message, text) {
  await fetch(`https://discord.com/api/v10/channels/${message.channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text, message_reference: { message_id: message.id } }),
    signal: AbortSignal.timeout(8_000),
  }).catch(err => logger.warn(`[session-setup] reply failed: ${err.message}`));
}

// ── Path resolution ───────────────────────────────────────────────────────────

function _resolvePath(box, hint) {
  if (!hint) return null;
  if (hint.startsWith('/') || hint.startsWith('~')) return hint;
  const home = box?.isLocal ? (process.env.HOME || '~') : '~';
  return `${home}/${hint}`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

/**
 * Called from messageCreate before the LLM gateway.
 * @returns {boolean|{handled: boolean, workspaceContext: string}}
 *   true  = consumed (skip further processing)
 *   false = not handled
 *   {handled:false, workspaceContext} = fall through to LLM with extra context
 */
export async function handleSessionSetup(message) {
  if (!isOwner(message.author.id)) return false;

  const text = message.content?.trim() || '';
  if (!text) return false;

  // ── BARE CONTINUE ────────────────────────────────────────────────────────
  if (ENABLED && CONTINUE_RE.test(text)) {
    const box = getBox();
    const cwd = getCwd();
    const command = buildResumeCommand(null);
    try {
      const status = await startSessionDirect({ channelId: message.channelId, command, boxName: box?.name, cwd, label: 'continue' });
      await _reply(message, status);
    } catch (err) {
      await _reply(message, `Failed: \`${err.message}\``);
    }
    return true;
  }

  // ── UUID RESUME ──────────────────────────────────────────────────────────
  if (ENABLED) {
    const uuidMatch = text.match(UUID_RE);
    if (uuidMatch) {
      const uuid = uuidMatch[1];
      const command = buildResumeCommand(uuid);
      const box = getBox();
      const cwd = getCwd();
      try {
        const status = await startSessionDirect({ channelId: message.channelId, command, boxName: box?.name, cwd, label: `resume-${uuid.slice(0, 8)}` });
        await _reply(message, status);
      } catch (err) {
        await _reply(message, `Failed: \`${err.message}\``);
      }
      return true;
    }
  }

  // ── CHAT MODE ────────────────────────────────────────────────────────────
  {
    const chatMatch = text.match(CHAT_RE);
    if (chatMatch) {
      const projectHint = chatMatch[1] || null;
      let cwd = null;
      if (projectHint) {
        const entry = findProjectMapByName(projectHint);
        if (entry?.cwd) cwd = entry.cwd;
      }
      if (!cwd) cwd = getCwd() || null;
      const workspaceContext = cwd ? `[WORKSPACE: ${cwd}]` : null;
      logger.info(`[session-setup] chat mode: project=${projectHint}, cwd=${cwd}`);
      return { handled: false, workspaceContext };
    }
  }

  if (!ENABLED) return false;

  // ── CREATE + MAP + START ─────────────────────────────────────────────────
  let m = text.match(CREATE_RE);
  if (m) {
    if (!GUILD_ID) {
      await _reply(message, '`DISCORD_GUILD_ID` is not configured — cannot create channels.');
      return true;
    }

    const [, name, boxName] = m;
    const box = getBoxByName(boxName);
    if (!box) {
      await _reply(message, `Unknown box: \`${boxName}\`. Available: gamez, generic, mac.`);
      return true;
    }

    const pathHint = text.match(PATH_RE)?.[1] || null;
    const cwd = _resolvePath(box, pathHint) || getCwd();

    let channelId = null;
    let mapWritten = false;
    try {
      channelId = await _createDiscordChannel(name, GUILD_ID);
      setProjectMap(channelId, name, box.name, cwd);
      mapWritten = true;

      const status = await startSessionDirect({
        channelId,
        boxName: box.name,
        cwd,
        label: name,
      });

      // startSessionDirect returns an error string on failure rather than throwing
      if (/^(Failed|Max |`|Session already)/.test(status)) {
        throw new Error(status);
      }

      await _reply(message, `Created <#${channelId}> → \`${box.name}:${cwd}\`\n${status}`);
      logger.info(`[session-setup] created #${name} → ${box.name}:${cwd}`);
    } catch (err) {
      logger.error(`[session-setup] create+start failed: ${err.message}`);
      if (mapWritten && channelId) deleteProjectMap(channelId);
      await _reply(message, `Failed: \`${err.message}\``);
    }
    return true;
  }

  // ── MAP ONLY ─────────────────────────────────────────────────────────────
  m = text.match(MAP_RE);
  if (m && !CREATE_RE.test(text)) {
    const [, name, boxName] = m;
    const box = getBoxByName(boxName);
    if (!box) {
      await _reply(message, `Unknown box: \`${boxName}\`.`);
      return true;
    }
    const pathHint = text.match(PATH_RE)?.[1] || null;
    const cwd = _resolvePath(box, pathHint) || getCwd();

    // Map uses current channel as the anchor
    setProjectMap(message.channelId, name, box.name, cwd);
    await _reply(message, `Mapped \`#${name}\` → \`${box.name}:${cwd}\` (this channel).`);
    logger.info(`[session-setup] mapped ${message.channelId} → ${box.name}:${cwd}`);
    return true;
  }

  // ── RESUME ───────────────────────────────────────────────────────────────
  m = text.match(RESUME_RE);
  if (m && !RESUME_STOP.test(text)) {
    const [, projectName, boxNameHint] = m;

    const entry = findProjectMapByName(projectName);
    if (!entry) {
      // Not a known project — let the LLM handle it
      return false;
    }

    const boxName = boxNameHint || entry.box;
    const box = getBoxByName(boxName) || getBoxByName(entry.box) || getBox();
    if (!box) {
      await _reply(message, `Box \`${entry.box}\` no longer exists in the box registry.`);
      return true;
    }
    const cwd = entry.cwd;

    try {
      const status = await startSessionDirect({
        channelId: entry.channelId,
        boxName: box.name,
        cwd,
        label: projectName,
      });
      await _reply(message, `Resuming \`${projectName}\` in <#${entry.channelId}>:\n${status}`);
      logger.info(`[session-setup] resumed ${projectName} → ${box.name}:${cwd}`);
    } catch (err) {
      logger.error(`[session-setup] resume failed: ${err.message}`);
      await _reply(message, `Failed to resume: \`${err.message}\``);
    }
    return true;
  }

  return false;
}
