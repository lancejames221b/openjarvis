/**
 * Join Briefing — Proactive spoken briefing when Lance joins voice channel.
 *
 * On voice join, gathers:
 *   1. Calendar events (next 2 hours) via OpenClaw gateway
 *   2. Active tasks from task ledger
 *   3. Current focus channel
 *   4. Pending alerts
 *
 * Synthesizes a 15-second spoken briefing and plays it after the "online" greeting.
 */

import logger from './logger.js';
import { getActiveTasks, getLedgerStats } from './task-ledger.js';
import { getFocus } from './focus-state.js';

const GATEWAY_URL = process.env.CLAWDBOT_GATEWAY_URL || 'http://127.0.0.1:22100';
const HOOKS_TOKEN = process.env.CLAWDBOT_HOOKS_TOKEN || '';
const BRIEFING_ENABLED = process.env.JOIN_BRIEFING_ENABLED !== 'false'; // on by default
const BRIEFING_HOURS_AHEAD = parseInt(process.env.JOIN_BRIEFING_HOURS ?? '2');
const BRIEFING_COOLDOWN_MS = parseInt(process.env.JOIN_BRIEFING_COOLDOWN_MS ?? '300000'); // 5 min

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
 * Returns a string suitable for TTS, or null if nothing to report.
 */
export async function generateBriefing() {
  const parts = [];

  // 1. Calendar — ask the gateway to check
  try {
    const calendarSummary = await _fetchCalendar();
    if (calendarSummary) parts.push(calendarSummary);
  } catch (err) {
    logger.warn(`[briefing] Calendar fetch failed: ${err.message}`);
  }

  // 2. Active tasks from ledger
  const activeTasks = getActiveTasks();
  if (activeTasks.length > 0) {
    const taskDescriptions = activeTasks
      .slice(0, 3) // max 3 for brevity
      .map(t => `"${_truncate(t.transcript, 40)}" — ${t.state}`)
      .join('. ');
    parts.push(`${activeTasks.length} active task${activeTasks.length > 1 ? 's' : ''}: ${taskDescriptions}`);
  }

  // 3. Current focus
  const focus = getFocus();
  if (focus) {
    parts.push(`Focused on ${focus.channelName}`);
  }

  if (parts.length === 0) {
    return null; // Nothing to report
  }

  // Build the briefing text — keep it tight for voice
  const briefing = parts.join('. ') + '.';

  // Trim to ~300 chars max for a ~20 second spoken briefing
  return _truncate(briefing, 350);
}

/**
 * Fetch upcoming calendar events via OpenClaw gateway.
 * Uses a lightweight /hooks/agent call asking for calendar summary.
 */
async function _fetchCalendar() {
  if (!HOOKS_TOKEN) {
    logger.warn('[briefing] No CLAWDBOT_HOOKS_TOKEN — skipping calendar');
    return null;
  }

  const now = new Date();
  const hoursAhead = BRIEFING_HOURS_AHEAD;

  const prompt = `Check my calendar for the next ${hoursAhead} hours (from now: ${now.toLocaleString('en-US', { timeZone: 'America/New_York' })}). Return ONLY a brief spoken summary of upcoming events — no markdown, no formatting. If no events, say "Calendar is clear." Keep it under 3 sentences. Use 12-hour time format.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

    const res = await fetch(`${GATEWAY_URL}/hooks/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HOOKS_TOKEN}`,
        'x-openclaw-scopes': 'operator.write',
      },
      body: JSON.stringify({
        message: prompt,
        model: 'unit/claude-haiku-4-5',
        options: { maxTokens: 200 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      logger.warn(`[briefing] Gateway returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = data?.response?.trim() || data?.message?.trim();
    if (text && text.length > 5 && !text.toLowerCase().includes('calendar is clear')) {
      return text;
    }
    return null;
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn('[briefing] Calendar request timed out');
    } else {
      throw err;
    }
    return null;
  }
}

function _truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.substring(0, max - 3) + '...';
}
