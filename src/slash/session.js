/**
 * session.js — Discord-controlled tmux shell sessions (/session command).
 *
 * Spawns a real CLI (default: claude [--mcp-config $CLAUDE_MCP_CONFIG] --dangerously-skip-permissions) in a
 * named tmux session, streams capture-pane every 2s to a pinned Discord
 * message, and forwards messages in the thread as tmux send-keys.
 *
 * SECURITY:
 *   - Requires SESSION_SHELL_ENABLED=true env var (off by default)
 *   - Owner-only — isOwner() check, no delegation
 *   - All tmux session names prefixed jv- to avoid collisions with user sessions
 *   - Max concurrent cap (SESSION_MAX, default 3)
 *   - Inactivity timeout (SESSION_TIMEOUT_MS, default 30 min)
 *   - All args JSON.stringify-escaped before passing to tmux
 */

import { execSync } from 'child_process';
import { getBox, getBoxByName, getCwd } from './box-state.js';
import { createLiveStream } from '../live-stream.js';
import { isOwner } from '../channel-access.js';
import logger from '../logger.js';

const ENABLED        = process.env.SESSION_SHELL_ENABLED === 'true';
const MAX_SESSIONS   = parseInt(process.env.SESSION_MAX ?? '3');
const INACTIVITY_MS  = parseInt(process.env.SESSION_TIMEOUT_MS ?? String(30 * 60_000));
const POLL_MS        = 2_000;
const PREFIX         = 'jv-';
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN || '';

const _MCP_CONFIG    = process.env.CLAUDE_MCP_CONFIG || '';
const _DEFAULT_CMD   = _MCP_CONFIG
  ? `claude --mcp-config ${_MCP_CONFIG} --dangerously-skip-permissions`
  : 'claude --dangerously-skip-permissions';

// Map channelId → { sessionName, interval, lastActivity, ls, box }
const _active = new Map();

// ── tmux helpers ──────────────────────────────────────────────────────────────

function _run(box, cmd) {
  if (box.isLocal) {
    return execSync(cmd, { encoding: 'utf8', timeout: 10_000, shell: '/bin/bash' }).trim();
  }
  return execSync(
    `ssh -o ConnectTimeout=15 -o BatchMode=yes ${box.ssh} ${JSON.stringify(cmd)}`,
    { encoding: 'utf8', timeout: 15_000 }
  ).trim();
}

function _capturePane(box, name, lines = 40) {
  try { return _run(box, `tmux capture-pane -t ${JSON.stringify(name)} -p -S -${lines}`); }
  catch { return '(no output)'; }
}

function _spawnSession(box, name, command) {
  _run(box, `tmux new-session -d -s ${JSON.stringify(name)} ${JSON.stringify(command)}`);
}

function _killSession(box, name) {
  try { _run(box, `tmux kill-session -t ${JSON.stringify(name)}`); } catch { /* already dead */ }
}

const _SPECIAL_KEYS = {
  '!enter':  'Enter',  '!esc':    'Escape', '!tab':    'Tab',
  '!up':     'Up',     '!down':   'Down',   '!left':   'Left',   '!right': 'Right',
  '!ctrl-c': 'C-c',   '!ctrl-d': 'C-d',   '!ctrl-z': 'C-z',   '!ctrl-l': 'C-l',
  '!y':      'y',      '!n':      'n',      '!space':  'Space',
};

function _sendKeys(box, name, text) {
  const key = _SPECIAL_KEYS[text.trim().toLowerCase()];
  if (key) {
    _run(box, `tmux send-keys -t ${JSON.stringify(name)} ${key}`);
    return;
  }
  const escaped = text.replace(/'/g, "'\\''");
  _run(box, `tmux send-keys -t ${JSON.stringify(name)} '${escaped}' Enter`);
}

// ── teardown ──────────────────────────────────────────────────────────────────

async function _teardown(channelId, finalMsg) {
  const sess = _active.get(channelId);
  if (!sess) return;
  clearInterval(sess.interval);
  _killSession(sess.box, sess.sessionName);
  await sess.ls.finish(finalMsg).catch(() => {});
  _active.delete(channelId);
  logger.info(`[session] teardown: ${sess.sessionName}`);
}

// ── sub-command handlers ──────────────────────────────────────────────────────

async function _handleStart(interaction) {
  if (_active.size >= MAX_SESSIONS) {
    await interaction.reply({ content: `Max ${MAX_SESSIONS} sessions already running. Stop one first.`, ephemeral: true });
    return;
  }

  const command = interaction.options.getString('command') || _DEFAULT_CMD;
  const boxName = interaction.options.getString('box') || null;
  const box = boxName ? (getBoxByName(boxName) ?? getBox()) : getBox();
  const cwd = getCwd();

  // Wrap command to cd into the current /dir setting before launching
  const fullCommand = (cwd && cwd !== '~')
    ? `bash -c "cd ${JSON.stringify(cwd)} && ${command}"`
    : command;

  await interaction.deferReply();

  const slug = command.slice(0, 20).replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
  const sessionName = `${PREFIX}${slug}-${Date.now().toString(36)}`;

  // Resolve channel to stream into — prefer a new thread, fall back to current channel
  const THREAD_TYPES     = new Set([10, 11, 12]);
  const THREADABLE_TYPES = new Set([0, 5]);
  let threadId;
  try {
    const res  = await fetch(`https://discord.com/api/v10/channels/${interaction.channelId}`, {
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` }, signal: AbortSignal.timeout(8_000) });
    const chan = await res.json();
    if (THREAD_TYPES.has(chan.type)) {
      threadId = interaction.channelId; // already in a thread
    } else if (THREADABLE_TYPES.has(chan.type)) {
      const tres = await fetch(`https://discord.com/api/v10/channels/${interaction.channelId}/threads`, {
        method: 'POST',
        headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: sessionName, auto_archive_duration: 1440, type: 11 }),
        signal: AbortSignal.timeout(8_000),
      });
      const tdata = await tres.json();
      if (!tdata.id) throw new Error(`Thread creation failed: ${JSON.stringify(tdata).slice(0, 200)}`);
      threadId = tdata.id;
    } else {
      threadId = interaction.channelId; // DM, voice, etc — use channel directly
    }
  } catch (err) {
    await interaction.editReply(`Failed to create thread: \`${err.message}\``);
    return;
  }

  if (_active.has(threadId)) {
    await interaction.editReply(`Session already running in <#${threadId}>. Use \`/session stop\` there first.`);
    return;
  }

  try {
    _spawnSession(box, sessionName, fullCommand);
  } catch (err) {
    logger.error(`[session] spawn failed: ${err.message}`);
    await interaction.editReply(`Failed to start tmux session: \`${err.message}\``);
    return;
  }

  logger.info(`[session] spawned ${sessionName} on ${box.name}: ${command} (cwd: ${cwd})`);

  let ls;
  try {
    ls = await createLiveStream(threadId, DISCORD_TOKEN);
  } catch (err) {
    _killSession(box, sessionName);
    await interaction.editReply(`Failed to create live stream: \`${err.message}\``);
    return;
  }

  const interval = setInterval(() => {
    const sess = _active.get(threadId);
    if (!sess) return;

    // Inactivity timeout
    if (Date.now() - sess.lastActivity > INACTIVITY_MS) {
      logger.info(`[session] inactivity timeout: ${sessionName}`);
      _teardown(threadId, 'Session timed out due to inactivity.');
      return;
    }

    // Update pinned message with latest pane content (full replace, not delta)
    const output = _capturePane(box, sessionName);
    if (output.trim()) sess.ls.replace(output);
  }, POLL_MS);

  _active.set(threadId, { sessionName, interval, lastActivity: Date.now(), ls, box });

  await interaction.editReply(
    `**Session \`${sessionName}\`** started on \`${box.name}\` → <#${threadId}>\n` +
    `Command: \`${command}\`  •  cwd: \`${cwd}\`\n` +
    `Type in that thread to send keystrokes. Special keys: \`!enter\` \`!ctrl-c\` \`!ctrl-d\` \`!y\` \`!n\`\n` +
    `Stop with \`/session stop\` inside the thread.`
  );
}

async function _handleStop(interaction) {
  const channelId = interaction.channelId;
  if (!_active.has(channelId)) {
    await interaction.reply({ content: 'No session running in this channel.', ephemeral: true });
    return;
  }
  await interaction.deferReply();
  await _teardown(channelId, 'Session stopped by owner.');
  await interaction.editReply('Session stopped and tmux session killed.');
}

async function _handleList(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const box = getBox();
  const lines = [];

  // Active (currently streaming to Discord)
  if (_active.size > 0) {
    lines.push('**Streaming now:**');
    for (const [cid, s] of _active.entries()) {
      lines.push(`  <#${cid}> → \`${s.sessionName}\` on \`${s.box.name}\``);
    }
  }

  // Orphaned jv-* tmux sessions on the active box (running but not streaming)
  try {
    const raw = _run(box, `tmux list-sessions -F '#{session_name}' 2>/dev/null || true`);
    const allSessions = raw.split('\n').filter(n => n.startsWith(PREFIX));
    const streaming = new Set([..._active.values()].map(s => s.sessionName));
    const orphans = allSessions.filter(n => !streaming.has(n));
    if (orphans.length > 0) {
      lines.push('');
      lines.push(`**Detached on \`${box.name}\`** (use \`/session attach\` to reattach):`);
      orphans.forEach(n => lines.push(`  \`${n}\``));
    }
  } catch { /* tmux not available or no sessions */ }

  if (lines.length === 0) {
    await interaction.editReply('No active or detached sessions.');
    return;
  }
  await interaction.editReply(lines.join('\n'));
}

async function _handleSend(interaction) {
  const channelId = interaction.channelId;
  const sess = _active.get(channelId);
  if (!sess) {
    await interaction.reply({ content: 'No session running here.', ephemeral: true });
    return;
  }
  const text = interaction.options.getString('text') || '';
  try {
    _sendKeys(sess.box, sess.sessionName, text);
    sess.lastActivity = Date.now();
    await interaction.reply({ content: `Sent: \`${text}\``, ephemeral: true });
  } catch (err) {
    await interaction.reply({ content: `Send failed: \`${err.message}\``, ephemeral: true });
  }
}

async function _handleAttach(interaction) {
  const sessionName = interaction.options.getString('name');
  if (!sessionName) {
    await interaction.reply({ content: 'Specify the session name (from `/session list`).', ephemeral: true });
    return;
  }
  if (_active.size >= MAX_SESSIONS) {
    await interaction.reply({ content: `Max ${MAX_SESSIONS} sessions already running.`, ephemeral: true });
    return;
  }

  const boxName = interaction.options.getString('box') || null;
  const box = boxName ? (getBoxByName(boxName) ?? getBox()) : getBox();

  // Verify the tmux session actually exists
  try { _run(box, `tmux has-session -t ${JSON.stringify(sessionName)}`); }
  catch {
    await interaction.reply({ content: `Session \`${sessionName}\` not found on \`${box.name}\`.`, ephemeral: true });
    return;
  }

  await interaction.deferReply();

  // Stream into current channel/thread — no new thread needed for reattach
  const threadId = interaction.channelId;
  if (_active.has(threadId)) {
    await interaction.editReply(`Already streaming a session here. Use \`/session stop\` first.`);
    return;
  }

  let ls;
  try { ls = await createLiveStream(threadId, DISCORD_TOKEN); }
  catch (err) {
    await interaction.editReply(`Failed to create live stream: \`${err.message}\``);
    return;
  }

  const interval = setInterval(() => {
    const sess = _active.get(threadId);
    if (!sess) return;
    if (Date.now() - sess.lastActivity > INACTIVITY_MS) {
      _teardown(threadId, 'Session timed out due to inactivity.');
      return;
    }
    const output = _capturePane(box, sessionName);
    if (output.trim()) sess.ls.replace(output);
  }, POLL_MS);

  _active.set(threadId, { sessionName, interval, lastActivity: Date.now(), ls, box });
  logger.info(`[session] attached ${sessionName} on ${box.name} → ${threadId}`);

  await interaction.editReply(
    `**Attached to \`${sessionName}\`** on \`${box.name}\`\n` +
    `Live terminal streaming here. Type to send keystrokes. \`/session stop\` to detach.`
  );
}

async function _handleResume(interaction) {
  if (_active.size >= MAX_SESSIONS) {
    await interaction.reply({ content: `Max ${MAX_SESSIONS} sessions already running.`, ephemeral: true });
    return;
  }

  const thread = interaction.options.getChannel('thread');
  if (!thread) {
    await interaction.reply({ content: 'No thread specified.', ephemeral: true });
    return;
  }

  const threadId = thread.id;
  if (_active.has(threadId)) {
    await interaction.reply({ content: `Session already active in <#${threadId}>. Use \`/session stop\` there first.`, ephemeral: true });
    return;
  }

  const command = interaction.options.getString('command') || _DEFAULT_CMD;
  const boxName = interaction.options.getString('box') || null;
  const box = boxName ? (getBoxByName(boxName) ?? getBox()) : getBox();

  await interaction.deferReply();

  // Scrape thread messages to build transcript
  let transcript = '';
  try {
    const msgs = [];
    let before = null;
    // Fetch up to 200 messages (2 pages of 100)
    for (let page = 0; page < 2; page++) {
      const url = `https://discord.com/api/v10/channels/${threadId}/messages?limit=100` + (before ? `&before=${before}` : '');
      const res = await fetch(url, {
        headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) break;
      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      msgs.unshift(...batch.reverse()); // oldest first
      before = batch[batch.length - 1].id;
      if (batch.length < 100) break;
    }

    const lines = ['# Session resume transcript', `## Thread: <#${threadId}>`, ''];
    for (const m of msgs) {
      const author = m.author?.username || '?';
      const content = (m.content || '').trim();
      const ts = m.timestamp?.slice(0, 19).replace('T', ' ') || '';
      // Include terminal snapshots (code blocks) and user keystrokes, skip bot acks
      if (content && !content.startsWith('**Session') && content !== '⌨️') {
        lines.push(`[${ts}] ${author}: ${content.slice(0, 800)}`);
      }
    }
    lines.push('', '---', 'Continue from where this left off.');
    transcript = lines.join('\n');
  } catch (err) {
    logger.warn(`[session] transcript fetch failed: ${err.message}`);
    transcript = '# Session resume\n(Could not fetch prior transcript)\nContinue from prior context if available.';
  }

  // Write transcript to a temp file on the target box, then start session
  const slug = 'resume';
  const sessionName = `${PREFIX}${slug}-${Date.now().toString(36)}`;
  const tmpFile = `/tmp/${sessionName}.md`;

  try {
    // Write transcript file via ssh/local then spawn session
    const escaped = transcript.replace(/'/g, "'\\''");
    _run(box, `printf '%s' '${escaped}' > ${tmpFile}`);
    _spawnSession(box, sessionName, command);
    // Give Claude a moment to start, then send the transcript as the opening prompt
    await new Promise(r => setTimeout(r, 3_000));
    _sendKeys(box, sessionName, `cat ${tmpFile}`);
  } catch (err) {
    logger.error(`[session] resume spawn failed: ${err.message}`);
    await interaction.editReply(`Failed to start resume session: \`${err.message}\``);
    return;
  }

  logger.info(`[session] resume ${sessionName} on ${box.name} from thread ${threadId}`);

  let ls;
  try {
    ls = await createLiveStream(threadId, DISCORD_TOKEN);
  } catch (err) {
    _killSession(box, sessionName);
    await interaction.editReply(`Failed to create live stream: \`${err.message}\``);
    return;
  }

  const interval = setInterval(() => {
    const sess = _active.get(threadId);
    if (!sess) return;
    if (Date.now() - sess.lastActivity > INACTIVITY_MS) {
      _teardown(threadId, 'Session timed out due to inactivity.');
      return;
    }
    const output = _capturePane(box, sessionName);
    if (output.trim()) sess.ls.replace(output);
  }, POLL_MS);

  _active.set(threadId, { sessionName, interval, lastActivity: Date.now(), ls, box });

  await interaction.editReply(
    `**Resumed in <#${threadId}>** — session \`${sessionName}\` on \`${box.name}\`\n` +
    `Transcript injected. Claude is reading prior context now.\n` +
    `Type in that thread to continue. \`/session stop\` to end.`
  );
}

// ── public API ────────────────────────────────────────────────────────────────

export async function handleSessionCommand(interaction) {
  if (!ENABLED) {
    await interaction.reply({ content: 'Shell sessions are disabled. Set `SESSION_SHELL_ENABLED=true` to enable.', ephemeral: true });
    return;
  }
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand(false); // false = don't throw if none
  if (!sub || sub === 'start') return _handleStart(interaction);
  if (sub === 'stop')   return _handleStop(interaction);
  if (sub === 'list')   return _handleList(interaction);
  if (sub === 'send')   return _handleSend(interaction);
  if (sub === 'resume') return _handleResume(interaction);
  if (sub === 'attach') return _handleAttach(interaction);
}

/**
 * Called from index.js messageCreate — forwards plain messages in session
 * channels as tmux keystrokes. Owner-only.
 * @returns {boolean} true if the message was consumed by a session
 */
export function handleSessionMessage(message) {
  const sess = _active.get(message.channelId);
  if (!sess) return false;
  if (!isOwner(message.author.id)) return false;
  sess.lastActivity = Date.now();
  try {
    _sendKeys(sess.box, sess.sessionName, message.content);
    message.react('⌨️').catch(() => {});
  } catch (err) {
    logger.warn(`[session] send-keys failed: ${err.message}`);
    message.react('❌').catch(() => {});
  }
  return true;
}

/** Returns true if channelId has an active session (used to short-circuit messageCreate) */
export function isSessionChannel(channelId) { return _active.has(channelId); }

/**
 * Start a session programmatically without a Discord slash interaction.
 * Used by session-setup.js for NL-triggered "create channel + start session" flows.
 *
 * @param {{ channelId: string, command?: string, boxName?: string, cwd?: string, label?: string }} params
 * @returns {Promise<string>} status message to send back to Discord
 */
export async function startSessionDirect({ channelId, command, boxName, cwd, label }) {
  if (!ENABLED) return '`SESSION_SHELL_ENABLED` is not set — sessions are disabled.';
  if (_active.size >= MAX_SESSIONS) return `Max ${MAX_SESSIONS} sessions already running. Stop one first.`;
  if (_active.has(channelId)) return 'Session already active in this channel.';

  const box = boxName ? (getBoxByName(boxName) ?? getBox()) : getBox();
  const workDir = cwd || getCwd();
  const cmd = command || _DEFAULT_CMD;

  const fullCommand = (workDir && workDir !== '~')
    ? `bash -c "cd ${JSON.stringify(workDir)} && ${cmd}"`
    : cmd;

  const slug = (label || cmd).slice(0, 20).replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
  const sessionName = `${PREFIX}${slug}-${Date.now().toString(36)}`;

  try {
    _spawnSession(box, sessionName, fullCommand);
  } catch (err) {
    logger.error(`[session] direct-start spawn failed: ${err.message}`);
    return `Failed to start tmux session: \`${err.message}\``;
  }

  logger.info(`[session] direct-start ${sessionName} on ${box.name} in ${workDir}`);

  let ls;
  try {
    ls = await createLiveStream(channelId, DISCORD_TOKEN);
  } catch (err) {
    _killSession(box, sessionName);
    return `Failed to create live stream: \`${err.message}\``;
  }

  const interval = setInterval(() => {
    const sess = _active.get(channelId);
    if (!sess) return;
    if (Date.now() - sess.lastActivity > INACTIVITY_MS) {
      _teardown(channelId, 'Session timed out due to inactivity.');
      return;
    }
    const output = _capturePane(box, sessionName);
    if (output.trim()) sess.ls.replace(output);
  }, POLL_MS);

  _active.set(channelId, { sessionName, interval, lastActivity: Date.now(), ls, box });

  return `Session **\`${sessionName}\`** started on \`${box.name}\` in \`${workDir}\`.\nType in this channel to send keystrokes. \`/session stop\` to end.`;
}
