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
import { getActiveTasks, getLedgerStats, getTask } from './task-ledger.js';
import { getFocus } from './focus-state.js';
import { getState } from './bot-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const HUD_STATE_PATH = join(DATA_DIR, 'hud-state.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const HUD_ENABLED = process.env.HUD_ENABLED !== 'false'; // on by default
const HUD_CHANNEL_ID = process.env.HUD_CHANNEL_ID || process.env.VOICE_REPORT_CHANNEL_ID || '1482037873426567229';
const UPDATE_DEBOUNCE_MS = parseInt(process.env.HUD_DEBOUNCE_MS ?? '2000'); // 2s debounce

// Emoji state indicators
const STATE_EMOJI = {
  ACTIVE: '🟢',
  IDLE: '🟡',
  SLEEP: '⚫',
  LISTENING: '🎙️',
};

let _client = null; // Discord client ref
let _hudMessageId = _loadHudState();
let _updateTimer = null;
let _startedAt = Date.now();
let _lastCompletedTask = null;
let _currentTaskId = null;
let _queueDepth = 0;

// ── State persistence ─────────────────────────────────────────────────

function _loadHudState() {
  try {
    if (existsSync(HUD_STATE_PATH)) {
      const data = JSON.parse(readFileSync(HUD_STATE_PATH, 'utf8'));
      return data.messageId || null;
    }
  } catch {}
  return null;
}

function _saveHudState() {
  try {
    writeFileSync(HUD_STATE_PATH, JSON.stringify({
      messageId: _hudMessageId,
      channelId: HUD_CHANNEL_ID,
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
  if (state === 'completed' || state === 'failed') {
    _lastCompletedTask = { taskId, state, completedAt: Date.now(), ...extra };
    _currentTaskId = null;
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

  // Current state
  fields.push({
    name: 'State',
    value: `${stateEmoji} **${botState}**`,
    inline: true,
  });

  // Uptime
  fields.push({
    name: 'Uptime',
    value: uptimeStr,
    inline: true,
  });

  // Focus
  fields.push({
    name: 'Focus',
    value: focus ? `#${focus.channelName}` : 'None',
    inline: true,
  });

  // Active task
  if (activeTasks.length > 0) {
    const current = _currentTaskId ? getTask(_currentTaskId) : activeTasks[0];
    if (current) {
      const elapsed = _formatUptime(Date.now() - new Date(current.createdAt).getTime());
      fields.push({
        name: '▶ Active Task',
        value: `\`#${current.taskId}\` ${_truncate(current.transcript, 60)}\n*${current.state}* — ${elapsed}`,
        inline: false,
      });
    }
  }

  // Queue
  if (_queueDepth > 0 || activeTasks.length > 1) {
    fields.push({
      name: 'Queue',
      value: `${_queueDepth} audio queued · ${activeTasks.length} task${activeTasks.length !== 1 ? 's' : ''} active`,
      inline: true,
    });
  }

  // Last completed
  if (_lastCompletedTask) {
    const ago = _formatUptime(Date.now() - _lastCompletedTask.completedAt);
    fields.push({
      name: '✓ Last Completed',
      value: `\`#${_lastCompletedTask.taskId}\` — ${_lastCompletedTask.state} · ${ago} ago`,
      inline: false,
    });
  }

  // Ledger stats
  fields.push({
    name: 'Session Stats',
    value: `${stats.total} total · ${stats.completed || 0} completed · ${stats.failed || 0} failed · ${stats.orphaned || 0} orphaned`,
    inline: false,
  });

  return {
    title: '🎙️ Jarvis Voice HUD',
    color: _stateColor(botState),
    fields,
    footer: { text: `Last updated` },
    timestamp: new Date().toISOString(),
  };
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
