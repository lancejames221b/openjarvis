/**
 * Verbose Mode — stream every voice response to a live Discord thread.
 *
 * When active: TTS still plays, AND the full response streams in real-time
 * to a new Discord thread in the text channel (like /spawn, per request).
 *
 * Enable:  /verbose on
 * Disable: /verbose off
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = `${__dirname}/../.env`;

// Per-thread overrides: when a handoff creates a thread, or the user types
// `/verbose on` inside a specific thread, that thread's verbose state is
// decoupled from the global flag. Live-only, does not persist across restarts
// (ephemeral conversation scope is the right default).
const _threadOverrides = new Map(); // threadId → boolean

export function enableVerboseForThread(threadId) {
  if (!threadId) return;
  _threadOverrides.set(String(threadId), true);
  logger.info(`[verbose-mode] thread ${threadId} → ON (override)`);
}

export function disableVerboseForThread(threadId) {
  if (!threadId) return;
  _threadOverrides.set(String(threadId), false);
  logger.info(`[verbose-mode] thread ${threadId} → OFF (override)`);
}

export function clearThreadVerboseOverride(threadId) {
  if (!threadId) return;
  _threadOverrides.delete(String(threadId));
}

// Has the user explicitly set verbose on/off for this thread?
// Used by the "threads are verbose by default" wiring in index.js so we only
// auto-enable when the thread hasn't been manually toggled either direction.
export function hasThreadVerboseOverride(threadId) {
  if (!threadId) return false;
  return _threadOverrides.has(String(threadId));
}

export function isVerboseModeEnabled(threadId) {
  // Thread-level override wins.
  if (threadId && _threadOverrides.has(String(threadId))) {
    return _threadOverrides.get(String(threadId));
  }
  try {
    const env = readFileSync(ENV_FILE, 'utf-8');
    const match = env.match(/^VOICE_VERBOSE_MODE=(true|false)$/m);
    return match ? match[1] === 'true' : true;
  } catch {
    return true;
  }
}

export function setVerboseMode(enabled) {
  try {
    let env = readFileSync(ENV_FILE, 'utf-8');
    const line = `VOICE_VERBOSE_MODE=${enabled}`;
    if (env.match(/^VOICE_VERBOSE_MODE=.*/m)) {
      env = env.replace(/^VOICE_VERBOSE_MODE=.*/m, line);
    } else {
      env += `\n${line}`;
    }
    writeFileSync(ENV_FILE, env, 'utf-8');
    logger.info(`[verbose-mode] VOICE_VERBOSE_MODE set to ${enabled}`);
    return true;
  } catch (err) {
    logger.error(`[verbose-mode] Failed to update .env: ${err.message}`);
    return false;
  }
}
