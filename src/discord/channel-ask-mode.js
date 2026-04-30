/**
 * channel-ask-mode — per-channel / per-thread "ask only" flag.
 *
 * When set, the gateway spawns claude with `--permission-mode plan` instead
 * of `--dangerously-skip-permissions`. Plan mode lets Claude read, think, and
 * discuss, but refuses Bash / Edit / Write / NotebookEdit. Useful for
 * conversational channels where you don't want Jarvis making changes — just
 * answering questions.
 *
 * Persisted to disk so it survives restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import logger from '../logger.js';

const STATE_DIR  = process.env.JARVIS_STATE_DIR || `${process.env.HOME}/.local/state/jarvis-voice`;
const STATE_FILE = join(STATE_DIR, 'channel-ask-mode.json');

try { mkdirSync(STATE_DIR, { recursive: true }); } catch {}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (err) { logger.warn(`[channel-ask-mode] state write failed: ${err.message}`); }
}

let _cache = loadState();

/** Is this channel/thread in ask-only mode? Checks exact id, no fallback. */
export function isAskModeEnabled(id) {
  if (!id) return false;
  return _cache[String(id)] === true;
}

/** Enable ask mode for a channel/thread. */
export function setAskMode(id, enabled = true) {
  if (!id) return;
  _cache[String(id)] = enabled;
  saveState(_cache);
  logger.info(`[channel-ask-mode] ${id} → ${enabled ? 'ON' : 'OFF'}`);
}

/** Remove an override entirely. */
export function clearAskMode(id) {
  if (!id) return;
  if (_cache[String(id)] !== undefined) {
    delete _cache[String(id)];
    saveState(_cache);
  }
}

/** List current overrides (for debug). */
export function listAskMode() {
  return { ..._cache };
}
