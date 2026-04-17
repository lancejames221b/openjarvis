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

export function isVerboseModeEnabled() {
  try {
    const env = readFileSync(ENV_FILE, 'utf-8');
    const match = env.match(/^VOICE_VERBOSE_MODE=(true|false)$/m);
    return match ? match[1] === 'true' : false;
  } catch {
    return false;
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
