/**
 * fuzzy-dispatch.js — Tier 1.5: keyword-based intent matching
 *
 * Sits between regex (Tier 1) and Haiku LLM (Tier 2). Zero latency.
 * Extracts channel names from natural speech using the channel registry
 * vocabulary + known action verbs. No LLM call needed.
 *
 * Strategy:
 * 1. Strip known action verbs/phrases ("focus on", "switch to", "bring up", etc.)
 * 2. Strip noise words ("the", "a", "an", "please", "channel", etc.)
 * 3. Try resolveChannel() on what remains
 * 4. If a channel matches AND the transcript had a focus-like verb → focus_set
 * 5. Also handles focus_clear, focus_query, channel_list with simple keyword checks
 */

import logger from './logger.js';
import { resolveChannel } from './focus-state.js';

// ── Action verb patterns (ordered longest-first for greedy strip) ────
const FOCUS_VERBS = [
  'focus on', 'switch to', 'switch over to', 'work on', 'go to',
  'bring up', 'take me to', 'let me see', 'open up', 'open',
  'pull up', 'hop to', 'hop over to', 'jump to', 'move to',
  'go back to', 'get back to', 'return to', 'head to', 'head over to',
  "let's do", "let's work on", "let's focus on", "let's go to",
  'can you focus on', 'can you switch to', 'can you go to',
  'could you focus on', 'could you switch to',
  'i want to focus on', 'i want to work on', 'i want to go to',
  'change to', 'change focus to',
  'set focus to', 'set focus',
  'focus', 'switch',
];

const CLEAR_PATTERNS = [
  'clear focus', 'clear the focus', 'drop focus', 'drop the focus',
  'reset focus', 'reset the focus', 'remove focus', 'remove the focus',
  'no focus', 'no more focus', 'stop focusing', 'unfocus',
];

const QUERY_PATTERNS = [
  'where am i', 'where are we', 'what channel', 'what channel am i on',
  'what channel am i in', "what's my focus", 'what is my focus',
  'current focus', 'current channel', 'what context', 'what am i focused on',
  'which channel',
];

const LIST_PATTERNS = [
  'list channels', 'list the channels', 'show channels', 'show the channels',
  'show me the channels', 'what channels', 'available channels',
  'what channels do i have', 'what channels are there',
];

// Noise words to strip after removing action verbs
const NOISE_WORDS = new Set([
  'the', 'a', 'an', 'my', 'our', 'that', 'this', 'please', 'now',
  'channel', 'channels', 'in', 'on', 'for', 'to', 'up', 'over',
  'discord', 'can', 'you', 'could', 'would', 'i', 'want', 'me',
  'lets', "let's", 'go', 'do', 'just', 'like',
]);

/**
 * Try to match a transcript to a structured command using keyword extraction.
 *
 * @param {string} transcript - Cleaned transcript (wake word stripped)
 * @returns {{ matched: boolean, type?: string, params?: object }}
 */
export function fuzzyMatch(transcript) {
  // Normalize: strip punctuation, curly quotes → straight, collapse whitespace
  const clean = transcript.toLowerCase()
    .replace(/[.,!?;:"]+/g, '')
    .replace(/[''`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  // ── Check clear/query/list first (exact phrase matches) ────────────
  if (CLEAR_PATTERNS.some(p => clean === p || clean.startsWith(p))) {
    logger.info(`[fuzzy] Matched focus_clear: "${clean}"`);
    return { matched: true, type: 'focus_clear' };
  }

  if (QUERY_PATTERNS.some(p => clean === p || clean.startsWith(p))) {
    logger.info(`[fuzzy] Matched focus_query: "${clean}"`);
    return { matched: true, type: 'focus_query' };
  }

  if (LIST_PATTERNS.some(p => clean === p || clean.startsWith(p))) {
    logger.info(`[fuzzy] Matched channel_list: "${clean}"`);
    return { matched: true, type: 'channel_list' };
  }

  // ── Try to extract a channel name ──────────────────────────────────
  let remainder = clean;
  let hadFocusVerb = false;

  // Strip action verbs (longest first)
  for (const verb of FOCUS_VERBS) {
    if (remainder.startsWith(verb + ' ') || remainder === verb) {
      remainder = remainder.slice(verb.length).trim();
      hadFocusVerb = true;
      break;
    }
  }

  // Also check if transcript ends with "channel please" / "please"
  remainder = remainder.replace(/\s+please$/, '').trim();
  remainder = remainder.replace(/\s+channel$/, '').trim();

  // Strip noise words from the beginning and end
  const words = remainder.split(/\s+/);
  const filtered = words.filter(w => !NOISE_WORDS.has(w));
  const target = filtered.join(' ').trim();

  if (!target || target.length < 2) {
    return { matched: false };
  }

  // Try resolveChannel on the extracted target
  const resolved = resolveChannel(target);

  if (resolved && hadFocusVerb) {
    logger.info(`[fuzzy] Matched focus_set: "${transcript}" → channel="${resolved.channelName}" (extracted="${target}")`);
    return {
      matched: true,
      type: 'focus_set',
      params: { channelName: resolved.channelName, channelId: resolved.channelId, purpose: resolved.purpose },
    };
  }

  // If we found a channel but no focus verb, the user might just be mentioning it
  // Don't auto-focus — let Haiku or brain decide intent
  if (resolved && !hadFocusVerb) {
    logger.info(`[fuzzy] Channel "${resolved.channelName}" found in transcript but no focus verb — passing to Tier 2`);
  }

  return { matched: false };
}
