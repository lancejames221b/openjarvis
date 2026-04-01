/**
 * shortcut-engine.js — Fast-path voice command dispatcher
 * 
 * Intercepts known voice commands BEFORE they hit the LLM gateway.
 * Each shortcut handler executes directly in Node.js — no AI round-trips.
 * 
 * Performance:
 *   Pattern match:  <5ms
 *   Cache read:     <50ms
 *   SSH open:       <3s
 *   Total:          ~3s  (vs. ~5 min via LLM)
 * 
 * Fallback: any failure returns { handled: false } → LLM path unchanged.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import { getNextMeeting, getCacheAgeMinutes } from './calendar-cache.js';
import { openOnMac } from './mac-open.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ON_SCREEN mode — mirrors brain.js behaviour
// no_ack: silent after open
// ack_post: speak after opening
// ack_pre: speak before opening
// ack_both: speak before and after
const ON_SCREEN = process.env.ON_SCREEN || 'no_ack';

// ── Handlers ──────────────────────────────────────────────────────────

/**
 * Open the next calendar meeting on Mac.
 */
async function calendarOpenNextHandler(_transcript) {
  const meeting = getNextMeeting();

  if (!meeting) {
    logger.info('⚡ shortcut: no upcoming meeting found — falling through to LLM');
    return { handled: false };
  }

  if (!meeting.bestUrl) {
    logger.info({ title: meeting.title }, '⚡ shortcut: meeting has no URL — falling through to LLM');
    return { handled: false };
  }

  const cacheAge = getCacheAgeMinutes();
  if (cacheAge > 180) {
    logger.warn({ cacheAge: Math.round(cacheAge) }, '⚡ shortcut: calendar cache is stale (>3h) — using anyway, async refresh recommended');
  }

  const opened = await openOnMac(meeting.bestUrl);
  if (!opened) {
    logger.info({ title: meeting.title }, '⚡ shortcut: mac-open failed — falling through to LLM');
    return { handled: false };
  }

  // Format time for speech
  const timeStr = meeting.start.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  });

  const speech = `Opening ${meeting.title} at ${timeStr}`;

  logger.info({ title: meeting.title, url: meeting.bestUrl, cacheAgeMin: Math.round(cacheAge) }, '⚡ shortcut: calendar open handled in fast path');

  return {
    handled: true,
    speech: ON_SCREEN === 'no_ack' ? null : speech,
    silent: ON_SCREEN === 'no_ack',
  };
}

// ── Shortcut Registry ─────────────────────────────────────────────────

const BUILTIN_SHORTCUTS = [
  {
    id: 'calendar_next_meeting',
    // Intents that can trigger this (null = any intent)
    intents: ['CALENDAR', 'ACTION', 'CALENDAR_ACTION', null],
    patterns: [
      /next meeting/i,
      /open.*(?:calendar|meeting).*(?:screen|mac)/i,
      /(?:pull up|show|open).*(?:next\s+)?meeting/i,
      /meeting.*on\s*(?:screen|mac)/i,
      /calendar.*on\s*(?:screen|mac)/i,
      /open.*calendar.*next/i,
    ],
    handler: calendarOpenNextHandler,
  },
];

// ── Voice-defined shortcuts ───────────────────────────────────────────

let _voiceShortcuts = [];

function loadVoiceShortcuts() {
  try {
    const raw = readFileSync(join(__dirname, '..', 'data', 'shortcuts.json'), 'utf8');
    const data = JSON.parse(raw);
    _voiceShortcuts = data.shortcuts || [];
    logger.info({ count: _voiceShortcuts.length }, '⚡ shortcut-engine: loaded voice shortcuts');
  } catch (err) {
    logger.warn({ err: err.message }, '⚡ shortcut-engine: could not load shortcuts.json');
    _voiceShortcuts = [];
  }
}

// Load on module init
loadVoiceShortcuts();

/**
 * Register a voice-defined shortcut (Phase 4 stub — stores to shortcuts.json).
 * Currently supports URL-open shortcuts only.
 * 
 * @param {string} trigger - Trigger phrase (e.g. "open my email")
 * @param {'url_open'} actionType - Action type
 * @param {object} actionData - Action data (e.g. { url: 'https://...' })
 */
export function addVoiceShortcut(trigger, actionType, actionData) {
  logger.info({ trigger, actionType, actionData }, '⚡ shortcut-engine: registering voice shortcut (stub)');
  // Full implementation in Phase 4
  // Will: validate, write to shortcuts.json, reload, confirm with speech
}

// ── Main entry point ──────────────────────────────────────────────────

/**
 * Try to handle a transcript via shortcut fast-path.
 * Returns immediately with { handled: false } if no shortcut matches.
 * 
 * @param {string} transcript - Cleaned (wake-word-stripped) transcript
 * @param {string|null} intentType - Intent classification (e.g. 'CALENDAR', 'ACTION')
 * @returns {Promise<{handled: boolean, speech?: string|null, silent?: boolean}>}
 */
export async function tryShortcut(transcript, intentType) {
  if (!transcript) return { handled: false };

  const lower = transcript.toLowerCase().trim();

  for (const shortcut of BUILTIN_SHORTCUTS) {
    // Intent gate — if intents array is set and doesn't include this intent, skip
    // (null in array = any intent allowed)
    const intentOk = !shortcut.intents
      || shortcut.intents.includes(null)
      || shortcut.intents.includes(intentType);

    if (!intentOk) continue;

    const patternMatch = shortcut.patterns.some(p => p.test(lower));
    if (!patternMatch) continue;

    logger.info({ shortcutId: shortcut.id, intentType, transcript }, '⚡ shortcut matched — bypassing LLM');

    try {
      const result = await shortcut.handler(transcript);
      if (result.handled) {
        logger.info({ shortcutId: shortcut.id }, '⚡ shortcut handled successfully');
        return result;
      }
      logger.info({ shortcutId: shortcut.id }, '⚡ shortcut fell through — routing to LLM');
    } catch (err) {
      logger.warn({ shortcutId: shortcut.id, err: err.message }, '⚡ shortcut handler threw — routing to LLM');
    }

    // Only try the first matching shortcut
    return { handled: false };
  }

  return { handled: false };
}
