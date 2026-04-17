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

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import logger from './logger.js';
import { getNextMeeting, getCacheAgeMinutes } from './calendar-cache.js';
import { openOnMac } from './mac-open.js';
import { resolveProject, listProjects } from './cursor-projects.js';
import { isVisualModeEnabled } from './visual-mode.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAC_SSH_HOST = process.env.MAC_SSH_HOST || '';

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

/**
 * Open a project in Cursor on Mac.
 * Extracts project name from the transcript and resolves via cursor-projects registry.
 */
async function cursorOpenHandler(transcript) {
  // Extract project name from various phrasings
  const projectMatch = transcript.match(
    /(?:bring up|open|pull up|show|launch|load)\s+(?:the\s+)?(?:code\s+(?:for|in|of)\s+)?(.+?)(?:\s+(?:in|on|with)\s+cursor)?$/i
  ) || transcript.match(
    /(?:cursor|code)\s+(?:for|in)\s+(.+)/i
  ) || transcript.match(
    /(?:bring up|open|pull up|show)\s+(?:the\s+)?(.+?)\s+(?:code|project|repo)/i
  );

  // "bring up the code" with no project name → try to infer from recent context
  const isGenericCodeRequest = /^(?:bring up|open|pull up|show me)\s+(?:the\s+)?code$/i.test(transcript.trim());

  let projectName = projectMatch ? projectMatch[1].trim() : null;

  // Strip trailing noise words
  if (projectName) {
    projectName = projectName.replace(/\s+(code|project|repo|repository|codebase|source)$/i, '').trim();
  }

  if (!projectName && !isGenericCodeRequest) {
    return { handled: false };
  }

  // For generic "bring up the code" — fall through to LLM which has conversation context
  if (isGenericCodeRequest) {
    logger.info('⚡ shortcut: "bring up the code" without project name — falling through to LLM for context');
    return { handled: false };
  }

  const result = resolveProject(projectName);
  if (!result) {
    logger.info({ projectName }, '⚡ shortcut: project not found in Cursor registry — falling through to LLM');
    return { handled: false };
  }

  const { project, cmd } = result;
  logger.info({ project: project.aliases[0], cmd }, '⚡ shortcut: opening project in Cursor');

  try {
    execSync(`ssh ${MAC_SSH_HOST} '${cmd}'`, { timeout: 10000, stdio: 'pipe' });
  } catch (err) {
    logger.warn({ err: err.message, project: project.aliases[0] }, '⚡ shortcut: Cursor open via SSH failed');
    // Try via openOnMac as fallback for local paths
    if (!project.host) {
      const opened = await openOnMac(project.path);
      if (!opened) return { handled: false };
    } else {
      return { handled: false };
    }
  }

  const speech = `Opening ${project.description} in Cursor`;

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
  {
    id: 'cursor_open_project',
    intents: ['ACTION', null],
    patterns: [
      /(?:bring up|open|pull up|show|launch|load)\s+(?:the\s+)?(?:code|project|repo)/i,
      /(?:bring up|open|pull up|show|launch|load)\s+.+?\s+(?:in|with)\s+cursor/i,
      /cursor\s+(?:for|open|launch)\s+/i,
      /open\s+(?:in\s+)?cursor/i,
      /(?:bring up|open|pull up|show)\s+.+?\s+(?:code|codebase|source)/i,
    ],
    handler: cursorOpenHandler,
  },
];

// ── Voice-defined shortcuts ───────────────────────────────────────────

const SHORTCUTS_PATH = join(__dirname, '..', 'data', 'shortcuts.json');
let _voiceShortcuts = [];

function loadVoiceShortcuts() {
  try {
    const raw = readFileSync(SHORTCUTS_PATH, 'utf8');
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

// ── Action handlers for voice-defined shortcuts ───────────────────────

/**
 * Handle url_open shortcuts — open a URL on Mac.
 */
async function handleUrlOpen(shortcut, _transcript) {
  const { url, speech } = shortcut.actionData;
  if (!url) return { handled: false };
  const opened = await openOnMac(url);
  if (!opened) return { handled: false };
  return {
    handled: true,
    speech: speech || null,
    silent: !speech,
  };
}

/**
 * Handle team_calendar shortcuts — fetch a teammate's calendar via mcporter.
 */
async function handleTeamCalendar(shortcut, _transcript) {
  const { email, name } = shortcut.actionData;
  if (!email) return { handled: false };

  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  // Use -05:00 Nov-Mar, -04:00 Mar-Nov (rough EDT approximation)
  const tzOffset = today.getTimezoneOffset() === 300 ? '-05:00' : '-04:00';
  const timeMin = `${dateStr}T00:00:00${tzOffset}`;
  const timeMax = `${dateStr}T23:59:59${tzOffset}`;

  try {
    const result = execSync(
      `mcporter call google-workspace.get_events ` +
      `'user_google_email=${process.env.GOOGLE_CALENDAR_EMAIL || ''}' ` +
      `'calendar_id=${email}' ` +
      `'time_min=${timeMin}' ` +
      `'time_max=${timeMax}' ` +
      `'detailed=true'`,
      { encoding: 'utf8', timeout: 15000 }
    );

    // Parse events from the text output
    const lines = result.split('\n').filter(l => l.includes('"') || l.startsWith('-'));
    const eventTitles = [];
    for (const line of lines) {
      const m = line.match(/^- "([^"]+)" \(Starts: [^,]+, Ends: ([^)]+)\)/);
      if (m) {
        const startMatch = line.match(/Starts: [\d-]+T([\d:]+)/);
        const time = startMatch ? startMatch[1].slice(0, 5) : '';
        eventTitles.push(time ? `${time} ${m[1]}` : m[1]);
      }
    }

    const displayName = name || email.split('@')[0];
    if (eventTitles.length === 0) {
      return {
        handled: true,
        speech: `${displayName}'s calendar is clear today.`,
      };
    }

    const summary = eventTitles.slice(0, 3).join(', ');
    const more = eventTitles.length > 3 ? ` and ${eventTitles.length - 3} more` : '';
    return {
      handled: true,
      speech: `${displayName} has ${eventTitles.length} event${eventTitles.length > 1 ? 's' : ''} today: ${summary}${more}.`,
    };
  } catch (err) {
    logger.warn({ err: err.message, email }, '⚡ shortcut: team_calendar mcporter call failed');
    return { handled: false };
  }
}

const ACTION_HANDLERS = {
  url_open: handleUrlOpen,
  team_calendar: handleTeamCalendar,
};

/**
 * Register a voice-defined shortcut — persists to shortcuts.json and hot-reloads.
 * 
 * @param {string} trigger - Trigger phrase (e.g. "what's junho's calendar look like today")
 * @param {'url_open'|'team_calendar'} actionType - Action type
 * @param {object} actionData - Action data
 *   - url_open: { url: string, speech?: string }
 *   - team_calendar: { email: string, name?: string }
 */
export function addVoiceShortcut(trigger, actionType, actionData) {
  if (!ACTION_HANDLERS[actionType]) {
    logger.warn({ actionType }, '⚡ shortcut-engine: unknown action type');
    return { ok: false, reason: `Unknown action type: ${actionType}` };
  }

  // Dedup by trigger (case-insensitive)
  const triggerLower = trigger.toLowerCase().trim();
  _voiceShortcuts = _voiceShortcuts.filter(s => s.trigger.toLowerCase() !== triggerLower);

  const entry = { id: `voice_${Date.now()}`, trigger: triggerLower, actionType, actionData };
  _voiceShortcuts.push(entry);

  try {
    const raw = readFileSync(SHORTCUTS_PATH, 'utf8');
    const data = JSON.parse(raw);
    data.shortcuts = _voiceShortcuts;
    writeFileSync(SHORTCUTS_PATH, JSON.stringify(data, null, 2), 'utf8');
    logger.info({ trigger, actionType }, '⚡ shortcut-engine: shortcut registered and persisted');
    return { ok: true, id: entry.id };
  } catch (err) {
    logger.warn({ err: err.message }, '⚡ shortcut-engine: failed to persist shortcut');
    return { ok: false, reason: err.message };
  }
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

  // Fall through to voice-defined shortcuts
  return tryVoiceShortcuts(transcript);
}

// ── Voice-shortcut dispatch (after built-ins) ─────────────────────────

async function tryVoiceShortcuts(transcript) {
  const lower = transcript.toLowerCase().trim();

  for (const shortcut of _voiceShortcuts) {
    // Simple substring / fuzzy match on trigger phrase
    if (!lower.includes(shortcut.trigger) && !shortcut.trigger.includes(lower)) continue;

    const handler = ACTION_HANDLERS[shortcut.actionType];
    if (!handler) continue;

    logger.info({ id: shortcut.id, trigger: shortcut.trigger }, '⚡ voice shortcut matched');
    try {
      const result = await handler(shortcut, transcript);
      if (result.handled) return result;
    } catch (err) {
      logger.warn({ id: shortcut.id, err: err.message }, '⚡ voice shortcut handler threw');
    }
  }

  return { handled: false };
}
