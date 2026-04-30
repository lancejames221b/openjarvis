/**
 * Join Briefing — Proactive spoken briefing when the owner joins voice channel.
 *
 * On voice join, gathers:
 *   1. Trello: "3 Commits" cards + current task
 *   2. Calendar events (next 2 hours) via Jarvis gateway
 *   3. Current focus channel
 *
 * Synthesizes a ~20-second spoken briefing and plays it after the "online" greeting.
 *
 * ENV:
 *   JOIN_BRIEFING_ENABLED=true|false (default: true)
 *   JOIN_BRIEFING_TRELLO=true|false (default: true)
 *   JOIN_BRIEFING_CALENDAR=true|false (default: true)
 *   JOIN_BRIEFING_HOURS=2
 *   JOIN_BRIEFING_COOLDOWN_MS=300000
 *   TRELLO_BOARD_ID=your-board-id
 *   TRELLO_COMMITS_LIST_ID=your-commits-list-id
 *   TRELLO_CURRENT_LIST_ID=your-current-list-id
 */

import logger from './logger.js';
import { getFocus, isFocusFresh } from './state/focus-state.js';
import { getTodayEvents } from './calendar-cache.js';

// Master toggle
const BRIEFING_ENABLED = process.env.JOIN_BRIEFING_ENABLED !== 'false';
// Feature toggles
const TRELLO_ENABLED = process.env.JOIN_BRIEFING_TRELLO !== 'false';
const CALENDAR_ENABLED = process.env.JOIN_BRIEFING_CALENDAR !== 'false';

const BRIEFING_HOURS_AHEAD = parseInt(process.env.JOIN_BRIEFING_HOURS ?? '2');
const BRIEFING_COOLDOWN_MS = parseInt(process.env.JOIN_BRIEFING_COOLDOWN_MS ?? '300000'); // 5 min

// Trello config — "Commit to 3" board
const TRELLO_API_KEY = process.env.TRELLO_API_KEY || '';
const TRELLO_TOKEN = process.env.TRELLO_TOKEN || '';
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID || '';
const TRELLO_COMMITS_LIST_ID = process.env.TRELLO_COMMITS_LIST_ID || '';   // "3 Commits"
const TRELLO_CURRENT_LIST_ID = process.env.TRELLO_CURRENT_LIST_ID || '';   // "⚡ Current Task"

// Mac silent-open config
const MAC_OPEN_ENABLED = process.env.JOIN_BRIEFING_MAC_OPEN !== 'false';  // on by default
const MAC_SSH_HOST = process.env.MAC_SSH_HOST || '';
const MAC_SSH_KEY = process.env.MAC_SSH_KEY || '~/.ssh/id_rsa';
const MAC_SSH_OPTS = `-o IdentitiesOnly=yes -i ${MAC_SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=5`;

// What to open on join (URLs resolved at runtime)
const TRELLO_BOARD_URL = `https://trello.com/b/${TRELLO_BOARD_ID}`;

let _lastBriefingAt = 0;

/**
 * Check if briefing should fire (cooldown guard)
 */
export function shouldBrief() {
  if (!BRIEFING_ENABLED) return false;
  const now = Date.now();
  if (now - _lastBriefingAt < BRIEFING_COOLDOWN_MS) {
    logger.info(`[briefing] Cooldown active (${Math.round((BRIEFING_COOLDOWN_MS - (now - _lastBriefingAt)) / 1000)}s remaining) — skipping`);
    return false;
  }
  return true;
}

/**
 * Mark briefing as delivered
 */
export function markBriefingDelivered() {
  _lastBriefingAt = Date.now();
}

/**
 * Gather briefing data and generate a spoken summary.
 * Also silently opens relevant surfaces on Mac.
 * Returns a string suitable for TTS, or null if nothing to report.
 */
export async function generateBriefing() {
  const parts = [];

  // ── Silent opens: fire-and-forget on Mac ──
  // Open surfaces while we gather data — no narration, no waiting
  if (MAC_OPEN_ENABLED) {
    _silentOpenSurfaces().catch(err =>
      logger.warn(`[briefing] Silent open failed: ${err.message}`)
    );
  }

  // 1. Trello — "3 Commits" + current task
  if (TRELLO_ENABLED) {
    try {
      const trelloSummary = await _fetchTrello();
      if (trelloSummary) parts.push(trelloSummary);
    } catch (err) {
      logger.warn(`[briefing] Trello fetch failed: ${err.message}`);
    }
  }

  // 2. Calendar — ask the gateway to check
  if (CALENDAR_ENABLED) {
    try {
      const calendarSummary = await _fetchCalendar();
      if (calendarSummary) parts.push(calendarSummary);
    } catch (err) {
      logger.warn(`[briefing] Calendar fetch failed: ${err.message}`);
    }
  }

  // 3. Current focus — only announce if set within the last 4 hours.
  // Stale focus (e.g. "plex" from days ago) is restored silently for context
  // injection but not spoken on join. "Focus follows last task" — if focus is
  // old, it's no longer the active context and shouldn't be announced.
  const focus = getFocus();
  if (focus && isFocusFresh(4)) {
    const focusLabel = focus.threadName
      ? `${focus.channelName}, ${focus.threadName} thread`
      : focus.channelName;
    parts.push(`Currently focused on ${focusLabel}`);
  }

  if (parts.length === 0) {
    return null;
  }

  const briefing = parts.join('. ') + '.';
  return _truncate(briefing, 450);
}

// ── Silent Mac Opens ──────────────────────────────────────────────────

/**
 * Open relevant surfaces on Mac screen — fire and forget, no speech.
 * Opens in parallel: Trello board + Google Calendar.
 * If a focus channel has a URL, opens that too.
 */
async function _silentOpenSurfaces() {
  const urls = [];

  // Trello board
  if (TRELLO_ENABLED && TRELLO_BOARD_URL) {
    urls.push(TRELLO_BOARD_URL);
  }

  // Google Calendar (today view)
  if (CALENDAR_ENABLED) {
    urls.push('https://calendar.google.com/calendar/u/0/r/day');
  }

  // Focus channel — if it has a known URL, open it
  const focus = getFocus();
  if (focus && focus.channelId) {
    // Discord channel URL
    const guildId = process.env.GUILD_ID || '';
    urls.push(`https://discord.com/channels/${guildId}/${focus.channelId}`);
  }

  if (urls.length === 0) return;

  // Open all URLs in one SSH call (batched)
  const openCmds = urls.map(u => `open "${u}"`).join(' && sleep 0.3 && ');
  const cmd = `ssh ${MAC_SSH_OPTS} ${MAC_SSH_HOST} '${openCmds}'`;

  try {
    await execAsync(cmd, { timeout: 10000 });
    logger.info(`[briefing] Silently opened ${urls.length} surface(s) on Mac`);
  } catch (err) {
    // Non-fatal — Mac might be asleep or SSH might timeout
    logger.warn(`[briefing] Mac open failed (non-fatal): ${err.message}`);
  }
}

// ── Trello ────────────────────────────────────────────────────────────

async function _fetchTrello() {
  if (!TRELLO_API_KEY || !TRELLO_TOKEN) {
    logger.warn('[briefing] No TRELLO_API_KEY/TRELLO_TOKEN — skipping Trello');
    return null;
  }

  const [commits, current] = await Promise.all([
    _fetchTrelloList(TRELLO_COMMITS_LIST_ID),
    _fetchTrelloList(TRELLO_CURRENT_LIST_ID),
  ]);

  const parts = [];

  // Current task first — it's the most important
  if (current.length > 0) {
    const taskNames = current.map(c => c.name).join(', ');
    parts.push(`Current task: ${taskNames}`);
  }

  // 3 Commits
  if (commits.length > 0) {
    const commitNames = commits.map(c => c.name).join(', ');
    parts.push(`Your 3 commits: ${commitNames}`);
  }

  if (parts.length === 0) return null;
  return parts.join('. ');
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

    if (!res.ok) {
      logger.warn(`[briefing] Trello list ${listId} returned ${res.status}`);
      return [];
    }

    const cards = await res.json();
    // Sort by position (Trello's natural ordering)
    return cards.sort((a, b) => a.pos - b.pos);
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn(`[briefing] Trello list ${listId} request timed out`);
    } else {
      logger.warn(`[briefing] Trello list ${listId} error: ${err.message}`);
    }
    return [];
  }
}

// ── Calendar ──────────────────────────────────────────────────────────

async function _fetchCalendar() {
  const now = new Date();
  const cutoff = new Date(now.getTime() + BRIEFING_HOURS_AHEAD * 3_600_000);
  const events = getTodayEvents().filter(e => e.start >= now && e.start <= cutoff);
  if (!events.length) return null;
  return 'Coming up: ' + events
    .map(e => `${e.title} at ${e.start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })}`)
    .join(', then ');
}

function _truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.substring(0, max - 3) + '...';
}
