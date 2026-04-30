/**
 * Voice Session HUD — Live status embed in #hud channel.
 *
 * Maintains a persistent embed message that shows:
 *   - Current state (listening / thinking / speaking / idle / sleeping)
 *   - Active task (transcript + state + elapsed time)
 *   - Queue depth
 *   - Current focus channel
 *   - Last completed task
 *   - Session uptime
 *
 * Updates on every task state transition. Debounced to avoid rate limits.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import { getActiveTasks, getLedgerStats, getTask } from './agent/task-ledger.js';
import { getFocus } from './focus-state.js';
import { isVisualModeEnabled, getVisualTargetChannel } from './visual-mode.js';
import { getState } from './bot-state.js';

// Trello config (same as join-briefing)
const TRELLO_API_KEY = process.env.TRELLO_API_KEY || '';
const TRELLO_TOKEN = process.env.TRELLO_TOKEN || '';
const TRELLO_COMMITS_LIST_ID = process.env.TRELLO_COMMITS_LIST_ID || '';
const TRELLO_CURRENT_LIST_ID = process.env.TRELLO_CURRENT_LIST_ID || '';
const HUD_TRELLO = process.env.HUD_TRELLO !== 'false';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const HUD_STATE_PATH = join(DATA_DIR, 'hud-state.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const HUD_ENABLED = process.env.HUD_ENABLED !== 'false'; // on by default
const HUD_CHANNEL_ID = process.env.HUD_CHANNEL_ID || process.env.VOICE_REPORT_CHANNEL_ID || process.env.DISCORD_TEXT_CHANNEL_ID;
const UPDATE_DEBOUNCE_MS = parseInt(process.env.HUD_DEBOUNCE_MS ?? '2000'); // 2s debounce

// Emoji state indicators
const STATE_EMOJI = {
  ACTIVE: '🟢',
  IDLE: '🟡',
  SLEEP: '⚫',
  LISTENING: '🎙️',
};

let _client = null; // Discord client ref
let _updateTimer = null;
let _startedAt = Date.now();
let _currentTaskId = null;
let _queueDepth = 0;

// Loaded from disk — persists lastCompletedTask and hudMessageId across restarts
const _persistedState = _loadHudState();
let _hudMessageId = _persistedState.messageId || null;
let _lastCompletedTask = _persistedState.lastCompletedTask || null;

// Per-task transcript cache: taskId → { transcript, startTime }
// Populated at dispatch so completion can show what was asked
const _taskTranscripts = new Map();

// Trello cache (refreshed every 5 min)
let _trelloCache = { commits: [], current: [], fetchedAt: 0 };
const TRELLO_CACHE_TTL_MS = 5 * 60 * 1000;

// ── State persistence ─────────────────────────────────────────────────

function _loadHudState() {
  try {
    if (existsSync(HUD_STATE_PATH)) {
      const data = JSON.parse(readFileSync(HUD_STATE_PATH, 'utf8'));
      return {
        messageId: data.messageId || null,
        lastCompletedTask: data.lastCompletedTask || null,
      };
    }
  } catch {}
  return { messageId: null, lastCompletedTask: null };
}

function _saveHudState() {
  try {
    writeFileSync(HUD_STATE_PATH, JSON.stringify({
      messageId: _hudMessageId,
      channelId: HUD_CHANNEL_ID,
      lastCompletedTask: _lastCompletedTask,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    logger.warn(`[hud] Failed to save state: ${err.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Initialize the HUD with a Discord client reference.
 */
export function initHud(client) {
  if (!HUD_ENABLED) return;
  _client = client;
  logger.info(`[hud] Initialized — channel: ${HUD_CHANNEL_ID}, existing message: ${_hudMessageId || 'none'}`);
}

/**
 * Notify the HUD of a task state change. Debounced.
 */
export function hudTaskUpdate(taskId, state, extra = {}) {
  if (!HUD_ENABLED || !_client) return;
  _currentTaskId = taskId;
  if (extra.queueDepth !== undefined) _queueDepth = extra.queueDepth;

  // Cache transcript when task is first dispatched so completion can show it
  if (state === 'dispatched' && extra.transcript) {
    _taskTranscripts.set(taskId, { transcript: extra.transcript, startTime: Date.now() });
  }

  if (state === 'completed' || state === 'failed') {
    const cached = _taskTranscripts.get(taskId);
    _lastCompletedTask = {
      taskId,
      state,
      completedAt: Date.now(),
      transcript: extra.transcript || cached?.transcript || null,
      resultSummary: extra.resultSummary || null,
      ...extra,
    };
    _taskTranscripts.delete(taskId);
    _currentTaskId = null;
    _saveHudState();
  }
  _scheduleUpdate();
}

/**
 * Notify queue depth change.
 */
export function hudQueueUpdate(depth) {
  if (!HUD_ENABLED) return;
  _queueDepth = depth;
  _scheduleUpdate();
}

/**
 * Force an immediate HUD refresh.
 */
export function hudRefresh() {
  if (!HUD_ENABLED || !_client) return;
  _doUpdate();
}

// ── Internal ──────────────────────────────────────────────────────────

function _scheduleUpdate() {
  if (_updateTimer) clearTimeout(_updateTimer);
  _updateTimer = setTimeout(() => _doUpdate(), UPDATE_DEBOUNCE_MS);
}

async function _doUpdate() {
  try {
    const channel = await _client.channels.fetch(HUD_CHANNEL_ID).catch(() => null);
    if (!channel) {
      logger.warn(`[hud] Cannot find channel ${HUD_CHANNEL_ID}`);
      return;
    }

    // Refresh Trello cache if stale (non-blocking on failure)
    if (HUD_TRELLO) {
      await _refreshTrelloCache().catch(err =>
        logger.warn(`[hud] Trello refresh failed: ${err.message}`)
      );
    }

    const embed = _buildEmbed();

    // Try to edit existing message, create new if missing
    if (_hudMessageId) {
      try {
        const msg = await channel.messages.fetch(_hudMessageId);
        await msg.edit({ embeds: [embed] });
        return;
      } catch {
        // Message deleted or not found — create new
        _hudMessageId = null;
      }
    }

    // Create new HUD message
    const msg = await channel.send({ embeds: [embed] });
    _hudMessageId = msg.id;
    _saveHudState();
    logger.info(`[hud] Created HUD message: ${_hudMessageId}`);
  } catch (err) {
    logger.error(`[hud] Update failed: ${err.message}`);
  }
}

function _buildEmbed() {
  const botState = getState();
  const focus = getFocus();
  const activeTasks = getActiveTasks();
  const stats = getLedgerStats();

  const stateEmoji = STATE_EMOJI[botState] || '⚪';
  const uptimeStr = _formatUptime(Date.now() - _startedAt);

  const fields = [];

  // Current state + uptime + focus (top row)
  fields.push({
    name: 'State',
    value: `${stateEmoji} **${botState}**`,
    inline: true,
  });
  fields.push({
    name: 'Uptime',
    value: uptimeStr,
    inline: true,
  });
  fields.push({
    name: 'Focus',
    value: focus ? `#${focus.channelName}` : 'None',
    inline: true,
  });

  // Output mode indicator
  if (isVisualModeEnabled()) {
    const visualTarget = getVisualTargetChannel();
    fields.push({
      name: 'Output',
      value: visualTarget ? `🖥️ Visual → <#${visualTarget}>` : '🖥️ Visual',
      inline: true,
    });
  } else {
    fields.push({
      name: 'Output',
      value: '🔊 Voice',
      inline: true,
    });
  }

  // ── Trello: Current Task ──
  if (HUD_TRELLO && _trelloCache.current.length > 0) {
    const taskNames = _trelloCache.current.map(c => `⚡ ${c.name}`).join('\n');
    fields.push({
      name: 'Current Task',
      value: taskNames,
      inline: false,
    });
  }

  // ── Trello: 3 Commits ──
  if (HUD_TRELLO && _trelloCache.commits.length > 0) {
    const commitLines = _trelloCache.commits.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
    fields.push({
      name: '3 Commits',
      value: commitLines,
      inline: false,
    });
  }

  // ── Active voice task (from internal ledger) ──
  if (activeTasks.length > 0) {
    const current = _currentTaskId ? getTask(_currentTaskId) : activeTasks[0];
    if (current) {
      const elapsed = _formatUptime(Date.now() - new Date(current.createdAt).getTime());
      fields.push({
        name: '🎙️ Voice Task',
        value: `\`#${current.taskId}\` ${_truncate(current.transcript, 60)}\n*${current.state}* — ${elapsed}`,
        inline: false,
      });
    }
  }

  // Queue (only if something pending)
  if (_queueDepth > 0) {
    fields.push({
      name: 'Queue',
      value: `${_queueDepth} audio queued`,
      inline: true,
    });
  }

  // Last completed
  if (_lastCompletedTask) {
    const ago = _formatUptime(Date.now() - _lastCompletedTask.completedAt);
    const taskLabel = _lastCompletedTask.transcript
      ? `\`#${_lastCompletedTask.taskId}\` ${_truncate(_lastCompletedTask.transcript, 55)}`
      : `\`#${_lastCompletedTask.taskId}\``;
    const stateIcon = _lastCompletedTask.state === 'failed' ? '✗' : '✓';
    fields.push({
      name: `${stateIcon} Last Completed`,
      value: `${taskLabel}\n*${ago} ago*`,
      inline: false,
    });
  }

  // Session stats (compact)
  if (stats.total > 0) {
    fields.push({
      name: 'Session',
      value: `${stats.completed || 0} done · ${stats.failed || 0} failed · ${stats.total} total`,
      inline: true,
    });
  }

  return {
    title: '🎙️ Jarvis Voice HUD',
    color: _stateColor(botState),
    fields,
    footer: { text: `Last updated` },
    timestamp: new Date().toISOString(),
  };
}

// ── Trello cache ──────────────────────────────────────────────────────

async function _refreshTrelloCache() {
  if (!TRELLO_API_KEY || !TRELLO_TOKEN) return;
  if (Date.now() - _trelloCache.fetchedAt < TRELLO_CACHE_TTL_MS) return;

  const [commits, current] = await Promise.all([
    _fetchTrelloList(TRELLO_COMMITS_LIST_ID),
    _fetchTrelloList(TRELLO_CURRENT_LIST_ID),
  ]);

  _trelloCache = { commits, current, fetchedAt: Date.now() };
  logger.info(`[hud] Trello refreshed: ${commits.length} commits, ${current.length} current`);
}

async function _fetchTrelloList(listId) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `https://api.trello.com/1/lists/${listId}/cards?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}&fields=name,pos`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) return [];
    const cards = await res.json();
    return cards.sort((a, b) => a.pos - b.pos);
  } catch {
    return [];
  }
}

function _stateColor(state) {
  switch (state) {
    case 'ACTIVE': return 0x2ECC71;    // green
    case 'IDLE': return 0xF1C40F;      // yellow
    case 'SLEEP': return 0x95A5A6;     // grey
    default: return 0x3498DB;          // blue
  }
}

function _formatUptime(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function _truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.substring(0, max - 3) + '...';
}
