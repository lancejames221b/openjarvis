/**
 * channel-models — per-channel / per-thread model override.
 *
 * Pattern matches verbose-mode's thread overrides: a Map keyed by channelId
 * (or threadId). When set, wins over the global brain.js voiceModel/textModel
 * for LLM dispatch to that channel/thread.
 *
 * Set by the handoff flow when the user passes `--model` (or natural language
 * "hand off using opus"). Persisted to disk so it survives restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

const STATE_DIR  = process.env.JARVIS_STATE_DIR || `${process.env.HOME}/.local/state/jarvis-voice`;
const STATE_FILE = join(STATE_DIR, 'channel-models.json');

try { mkdirSync(STATE_DIR, { recursive: true }); } catch {}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (err) { logger.warn(`[channel-models] state write failed: ${err.message}`); }
}

let _cache = loadState();

/** Get override model for a channel/thread, or null if none. */
export function getChannelModel(id) {
  if (!id) return null;
  return _cache[String(id)] || null;
}

/** Set override model for a channel/thread. */
export function setChannelModel(id, model) {
  if (!id || !model) return;
  _cache[String(id)] = model;
  saveState(_cache);
  logger.info(`[channel-models] ${id} → ${model}`);
}

/** Remove override. */
export function clearChannelModel(id) {
  if (!id) return;
  if (_cache[String(id)] !== undefined) {
    delete _cache[String(id)];
    saveState(_cache);
    logger.info(`[channel-models] ${id} cleared`);
  }
}

/** List all overrides (for debug/admin). */
export function listChannelModels() {
  return { ..._cache };
}
