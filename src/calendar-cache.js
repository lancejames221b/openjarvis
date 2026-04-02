/**
 * calendar-cache.js — Fast calendar cache reader
 * 
 * Reads ~/dev/cache/calendar.json (raw text format, not JSON)
 * and parses event data without any LLM or API call.
 * 
 * Cache format example:
 *   Successfully retrieved 49 events...
 *   - "Daily Standup" (Starts: 2026-04-01T10:00:00-04:00, Ends: 2026-04-01T10:30:00-04:00) Meeting: https://meet.google.com/abc-xyz ID: ... | Link: https://...
 */

import { readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../cache/calendar.json');

// Regex to parse each event line
// Handles: - "Title" (Starts: ISO, Ends: ISO) [Meeting: URL] ID: ... [| Link: URL]
const EVENT_LINE_RE = /^- "(.+?)"\s+\(Starts:\s*([^,]+),\s*Ends:\s*([^)]+)\)(?:.*?Meeting:\s*(https?:\/\/\S+?))?(?:.*?Link:\s*(https?:\/\/\S+))?/;

/**
 * Parse raw cache text into event objects.
 * @returns {Array<{title, start, end, meetUrl, calLink, bestUrl}>}
 */
function parseEvents() {
  let rawText;
  try {
    rawText = readFileSync(CACHE_PATH, 'utf8');
  } catch (err) {
    logger.warn({ err: err.message }, '⚡ calendar-cache: failed to read cache file');
    return [];
  }

  const events = [];
  for (const line of rawText.split('\n')) {
    const m = line.trim().match(EVENT_LINE_RE);
    if (!m) continue;

    const [, title, startStr, endStr, meetUrl, calLink] = m;
    let start, end;
    try {
      start = new Date(startStr.trim());
      end = new Date(endStr.trim());
    } catch {
      continue;
    }

    if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;

    // Clean up URLs — strip trailing punctuation
    const cleanUrl = (u) => u ? u.replace(/[.,;)]+$/, '').trim() : null;

    const cleanMeet = cleanUrl(meetUrl) || null;
    const cleanCal = cleanUrl(calLink) || null;

    events.push({
      title: title.trim(),
      start,
      end,
      meetUrl: cleanMeet,
      calLink: cleanCal,
      bestUrl: cleanMeet || cleanCal,
    });
  }

  return events.sort((a, b) => a.start - b.start);
}

/**
 * Get the next upcoming meeting (ends in the future).
 * @returns {{title, start, end, meetUrl, calLink, bestUrl}|null}
 */
export function getNextMeeting() {
  const now = new Date();
  const events = parseEvents();
  // Find first event that hasn't ended yet
  return events.find(e => e.end > now) || null;
}

/**
 * Get all events for today (in local time).
 * @returns {Array}
 */
export function getTodayEvents() {
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  const events = parseEvents();
  return events.filter(e => {
    const eventDateStr = e.start.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return eventDateStr === todayStr;
  });
}

/**
 * Get cache age in minutes (based on file mtime).
 * Returns Infinity if file doesn't exist.
 */
export function getCacheAgeMinutes() {
  try {
    const stat = statSync(CACHE_PATH);
    return (Date.now() - stat.mtimeMs) / 60000;
  } catch {
    return Infinity;
  }
}
