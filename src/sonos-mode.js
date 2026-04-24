/**
 * Sonos Speaker Mode — state + command parser.
 *
 * When enabled, playAudioEnhanced (index.js) routes TTS wavs to a house Sonos
 * via sonos-play.js (in-process UPnP) instead of Discord voice.
 *
 * Also carries per-response context (channelId/threadId/taskId) so
 * sonos-play can name wavs per-channel for traceability and to dodge
 * URL-level caching on the Sonos device.
 */

import logger from './logger.js';

// ── Mode state ────────────────────────────────────────────────────────
// Per-channel: presence in the map = enabled for that channel.
// Channels not in the map stay text-only (Discord chat).

/** @type {Map<string, { target: string }>} */
const _byChannel = new Map();

export function isSonosModeEnabled(channelId) {
  return _byChannel.has(String(channelId || ''));
}

export function getSonosTarget(channelId) {
  return _byChannel.get(String(channelId || ''))?.target || 'down';
}

export function setSonosMode(channelId, target = 'down') {
  const key = String(channelId || '');
  if (!key) return;
  _byChannel.set(key, { target });
  logger.info(`[sonos-mode] enabled for ${key} → target: ${target}`);
}

export function clearSonosMode(channelId) {
  const key = String(channelId || '');
  if (key === 'all' || key === '*') {
    const n = _byChannel.size;
    _byChannel.clear();
    logger.info(`[sonos-mode] disabled for all channels (${n})`);
    return;
  }
  if (_byChannel.delete(key)) {
    logger.info(`[sonos-mode] disabled for ${key}`);
  }
}

/** For admin/debug: list every channel currently routed to a speaker. */
export function listSonosChannels() {
  return Array.from(_byChannel.entries()).map(([channelId, v]) => ({ channelId, target: v.target }));
}

// ── Response context (set by caller before TTS, read by sonos-play) ──

let _ctx = { channelId: 'system', threadId: 'main', taskId: null, role: 'response' };

export function setSonosCtx(ctx) {
  _ctx = {
    channelId: ctx?.channelId ?? 'system',
    threadId:  ctx?.threadId  ?? 'main',
    taskId:    ctx?.taskId    ?? null,
    role:      ctx?.role      ?? 'response',
  };
}

export function getSonosCtx() {
  return { ..._ctx };
}

export function resetSonosCtx() {
  _ctx = { channelId: 'system', threadId: 'main', taskId: null, role: 'response' };
}

// ── Location parsing ──────────────────────────────────────────────────

/**
 * Infer speaker target from natural language.
 * Returns "up", "down", or "all".
 */
export function parseSonosTarget(text) {
  const t = text.toLowerCase();
  if (/\b(upstairs|bedroom|bathroom|up)\b/.test(t))         return 'up';
  if (/\b(downstairs|kitchen|living.?room|down)\b/.test(t)) return 'down';
  if (/\b(everywhere|all|both|whole.?house)\b/.test(t))     return 'all';
  return 'down'; // default
}

/**
 * Detect speaker mode commands in a message.
 * Returns { command: 'on'|'off', target } or null.
 *
 * Off is checked BEFORE on because the on-matcher's target group is greedy —
 * "speaker mode off" would otherwise match the on-pattern with an empty target
 * and never reach the off branch.
 */
export function parseSonosModeCommand(text) {
  const t = text.toLowerCase().trim();

  const offMatch = t.match(
    /\b(speaker\s+mode\s+off|sonos\s+mode\s+off|speakers?\s+off|sonos\s+off|disable\s+speakers?|disable\s+sonos(\s+mode)?|disable\s+speaker\s+mode|turn\s+off\s+(the\s+)?speakers?|turn\s+off\s+(the\s+)?sonos(\s+mode)?|turn\s+off\s+speaker\s+mode|stop\s+speaker\s+mode|stop\s+sonos\s+mode|exit\s+speaker\s+mode|exit\s+sonos\s+mode)\b/
  );
  if (offMatch) {
    return { command: 'off', target: null };
  }

  // On-matcher: target group is now REQUIRED (was optional, causing the off bug).
  // "speaker mode" alone without a target falls through to null.
  const onMatch = t.match(
    /\b(speaker\s+mode|sonos\s+mode)\b.*?\b(on|kitchen|bedroom|upstairs|downstairs|up|down|all|everywhere)\b/
  ) || t.match(
    /\b(go\s+into\s+speaker\s+mode|enable\s+speaker\s+mode|put\s+on\s+speaker\s+mode|speaker\s+mode\s+on|sonos\s+mode\s+on)\b/
  ) || t.match(
    /\bspeak\s+(responses?|replies?)\s+(on|to|through|via)\s+(sonos|speaker|kitchen|bedroom)\b/
  );

  if (onMatch) {
    return { command: 'on', target: parseSonosTarget(t) };
  }

  return null;
}
