/**
 * Visual / Screen Mode
 *
 * When active: all TTS responses are suppressed and routed to a Discord text
 * channel instead. Voice input still works — you can ask questions, give
 * commands, trigger sub-agents — but Jarvis answers on screen like The Expanse's
 * ship AI display rather than speaking aloud.
 *
 * Enable:  "visual mode on" / "screen mode" / "text only" / "display mode" / "expanse mode"
 * Disable: "visual mode off" / "voice mode" / "talk to me" / "speak to me"
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = `${__dirname}/../.env`;

const VISUAL_ON_PATTERNS = [
  /\bvisual\s+mode\s+on\b/i,
  /\bturn\s+on\s+visual\s+mode\b/i,
  /\bvisual\s+mode\b/i,
  /\bscreen\s+mode\s+on\b/i,
  /\bscreen\s+mode\b/i,
  /\btext\s+only\s+mode\b/i,
  /\btext\s+only\b/i,
  /\bdisplay\s+mode\b/i,
  /\btext\s+mode\b/i,
  /\bgo\s+visual\b/i,
  /\bexpanse\s+mode\b/i,
];

const VISUAL_OFF_PATTERNS = [
  /\bvisual\s+mode\s+off\b/i,
  /\bturn\s+off\s+visual\s+mode\b/i,
  /\bscreen\s+mode\s+off\b/i,
  /\bvoice\s+mode\s+on\b/i,
  /\bvoice\s+mode\b/i,
  /\btalk\s+to\s+me\b/i,
  /\bspeak\s+to\s+me\b/i,
  /\baudio\s+mode\b/i,
];

/**
 * Check if transcript is a visual mode toggle command.
 * Checks OFF patterns first so "visual mode off" is not caught by the ON "visual mode" pattern.
 * @param {string} transcript
 * @returns {true|false|null} true=enable, false=disable, null=not a toggle
 */
export function isVisualModeToggle(transcript) {
  const clean = transcript.trim();
  if (VISUAL_OFF_PATTERNS.some(p => p.test(clean))) return false;
  if (VISUAL_ON_PATTERNS.some(p => p.test(clean))) return true;
  return null;
}

/**
 * Read current visual mode state from .env
 */
export function isVisualModeEnabled() {
  try {
    const envContent = readFileSync(ENV_FILE, 'utf-8');
    const match = envContent.match(/^VOICE_VISUAL_MODE=(true|false)$/m);
    return match ? match[1] === 'true' : false;
  } catch {
    return false;
  }
}

/**
 * Persist visual mode state to .env
 */
export function setVisualMode(enabled) {
  try {
    let envContent = readFileSync(ENV_FILE, 'utf-8');
    const pattern = /^VOICE_VISUAL_MODE=.*/m;
    const newLine = `VOICE_VISUAL_MODE=${enabled}`;
    if (envContent.match(pattern)) {
      envContent = envContent.replace(pattern, newLine);
    } else {
      envContent += `\n${newLine}`;
    }
    writeFileSync(ENV_FILE, envContent, 'utf-8');
    logger.info(`[visual-mode] VOICE_VISUAL_MODE set to ${enabled}`);
    return true;
  } catch (err) {
    logger.error('Failed to update VOICE_VISUAL_MODE in .env:', err.message);
    return false;
  }
}

/**
 * Read the visual mode target channel ID from .env.
 * When set, all visual-mode responses go to this channel.
 * Falls back to the current focus channel or VOICE_REPORT_CHANNEL_ID in index.js.
 */
export function getVisualTargetChannel() {
  try {
    const envContent = readFileSync(ENV_FILE, 'utf-8');
    const match = envContent.match(/^VOICE_VISUAL_CHANNEL=(.+)$/m);
    const val = match ? match[1].trim() : '';
    return val || null;
  } catch {
    return null;
  }
}

/**
 * Persist the visual mode target channel ID to .env
 */
export function setVisualTargetChannel(channelId) {
  try {
    let envContent = readFileSync(ENV_FILE, 'utf-8');
    const pattern = /^VOICE_VISUAL_CHANNEL=.*/m;
    const newLine = `VOICE_VISUAL_CHANNEL=${channelId || ''}`;
    if (envContent.match(pattern)) {
      envContent = envContent.replace(pattern, newLine);
    } else {
      envContent += `\n${newLine}`;
    }
    writeFileSync(ENV_FILE, envContent, 'utf-8');
    logger.info(`[visual-mode] VOICE_VISUAL_CHANNEL set to ${channelId || '(cleared)'}`);
    return true;
  } catch (err) {
    logger.error('Failed to update VOICE_VISUAL_CHANNEL in .env:', err.message);
    return false;
  }
}
