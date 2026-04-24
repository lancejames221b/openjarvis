/**
 * channel-mcp-mode — per-channel/thread MCP capability flag.
 *
 * When set, the gateway spawns Claude with a curated MCP config
 * (`/home/generic/.config/jarvis-voice/jarvis-mcp.json`) so the subprocess
 * can natively call notion/gcal/slack/etc. When unset, the gateway spawns
 * with an empty MCP config for speed (the original design — ~2-4s saved
 * per voice turn).
 *
 * Persisted to disk so it survives restarts. Same pattern and storage dir
 * as `channel-ask-mode.js`. Thread-scope wins over channel-scope.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

const STATE_DIR  = process.env.JARVIS_STATE_DIR || `${process.env.HOME}/.local/state/jarvis-voice`;
const STATE_FILE = join(STATE_DIR, 'channel-mcp-mode.json');

try { mkdirSync(STATE_DIR, { recursive: true }); } catch {}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (err) { logger.warn(`[channel-mcp-mode] state write failed: ${err.message}`); }
}

let _cache = loadState();

/**
 * Stored values per channel/thread id:
 *   "full"                 — load the curated jarvis-mcp.json
 *   ["notion","slack",...] — load a subset (array of server names)
 *   "off" / absent         — empty MCP config (current fast default)
 */

export function getMcpMode(id) {
  if (!id) return null;
  return _cache[String(id)] ?? null;
}

/**
 * Set mode. Accepts:
 *   mode = 'full'       → full curated config
 *   mode = 'off'        → explicit off (distinguishes from "never set")
 *   mode = ['a','b']    → subset
 */
export function setMcpMode(id, mode) {
  if (!id) return;
  _cache[String(id)] = mode;
  saveState(_cache);
  const summary = Array.isArray(mode) ? `subset[${mode.join(',')}]` : mode;
  logger.info(`[channel-mcp-mode] ${id} → ${summary}`);
}

export function clearMcpMode(id) {
  if (!id) return;
  if (_cache[String(id)] !== undefined) {
    delete _cache[String(id)];
    saveState(_cache);
    logger.info(`[channel-mcp-mode] ${id} cleared`);
  }
}

export function listMcpMode() {
  return { ..._cache };
}

/**
 * Resolve the effective MCP mode for a channelKey in the gateway's format.
 * Matches `_channelIsInAskMode` resolution: thread-scope wins over channel-scope.
 *
 * @param {string} channelKey  "agent:main:discord:channel:<id>[:thread:<tid>]"
 * @returns {{mode: 'off'|'full'|'subset', servers?: string[]}}
 */
export function resolveMcpModeForChannelKey(channelKey) {
  if (!channelKey) return { mode: 'off' };
  const m = channelKey.match(/discord:channel:(\d+)(?::thread:(\d+))?/);
  if (!m) return { mode: 'off' };
  const [, channelId, threadId] = m;

  // Thread override wins
  if (threadId && _cache[threadId] !== undefined) {
    return _normalize(_cache[threadId]);
  }
  if (channelId && _cache[channelId] !== undefined) {
    return _normalize(_cache[channelId]);
  }
  return { mode: 'off' };
}

function _normalize(raw) {
  if (raw === 'full') return { mode: 'full' };
  if (raw === 'off')  return { mode: 'off' };
  if (Array.isArray(raw) && raw.length) return { mode: 'subset', servers: raw };
  return { mode: 'off' };
}

/**
 * Reload state from disk. Used if another process has updated the file
 * (e.g. admin-api) and we want the gateway to pick it up without restart.
 */
export function reloadState() {
  _cache = loadState();
  logger.info(`[channel-mcp-mode] state reloaded (${Object.keys(_cache).length} entries)`);
}
