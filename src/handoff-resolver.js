/**
 * handoff-resolver — gather the pieces needed for a resume card:
 * chatId from zeroclaw-sessions.json, directory+model from channel-registry.json,
 * with safe fallbacks when data is missing.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

const STATE_DIR  = process.env.JARVIS_STATE_DIR || `${process.env.HOME}/.local/state/jarvis-voice`;
const SESSIONS_FILE = join(STATE_DIR, 'zeroclaw-sessions.json');
const REGISTRY = process.env.JARVIS_CHANNEL_REGISTRY || `${process.env.HOME}/dev/contexts/channel-registry.json`;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

/**
 * Detect a handoff command phrase. Matches:
 *   "handoff", "hand off", "hand it off", "hand this off"
 *   "hand off to terminal", "hand off to gcloud", "hand off to laptop", "hand off to claude"
 *   "give me the handoff / a handoff / the resume command"
 *   "continue in a thread", "pick this up in terminal"
 */
export function isHandoffCommand(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    /\bhand\s?(it\s+|this\s+)?off\b/.test(t) ||
    /\bgive\s+me\s+(a\s+|the\s+)?(hand\s?off|resume(\s+command)?)\b/.test(t) ||
    /\bcontinue\s+in\s+(a\s+)?thread\b/.test(t) ||
    /\bpick\s+this\s+up\s+in\s+(terminal|claude|gcloud|laptop)\b/.test(t) ||
    /\bresume\s+(this|session)\s+(in|on)\s+(terminal|claude|laptop)\b/.test(t)
  );
}

/**
 * Detect per-channel "ask mode" toggle commands.
 * Returns { ask: true | false } or null.
 *
 * Matches:
 *   "ask mode on" / "ask mode off"
 *   "read only mode" / "read-only on"
 *   "ask only" / "just ask"
 *   "turn off ask mode"
 */
export function parseAskModeCommand(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  if (/\b(ask\s*mode\s*off|turn\s+off\s+ask|disable\s+ask|stop\s+ask\s*mode|exit\s+ask)\b/.test(t)) {
    return { ask: false };
  }
  if (/\b(ask\s*mode\s*on|ask\s+only|read[\s-]only(\s+mode)?(\s+on)?|enable\s+ask|turn\s+on\s+ask)\b/.test(t)) {
    return { ask: true };
  }
  return null;
}

/**
 * Detect per-thread verbose toggle commands.
 * Returns { verbose: true | false } or null.
 *
 * Matches:
 *   "verbose on" / "verbose off"
 *   "turn on verbose" / "turn verbose off"
 *   "go verbose" (on only)
 */
export function parseVerboseCommand(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  if (/\b(verbose\s+on|turn\s+on\s+verbose|go\s+verbose|enable\s+verbose)\b/.test(t)) {
    return { verbose: true };
  }
  if (/\b(verbose\s+off|turn\s+off\s+verbose|disable\s+verbose|stop\s+verbose)\b/.test(t)) {
    return { verbose: false };
  }
  return null;
}

/**
 * Detect per-channel MCP mode toggle commands.
 * Returns { mode: 'full'|'off', servers?: string[] } or null.
 *
 * Matches:
 *   "mcp on" / "full mcp" / "enable tools" / "give me tools" / "turn on tools"
 *   "mcp off" / "fast mode" / "voice mode" / "no tools" / "disable tools"
 *   "mcp with notion and slack" / "only notion and slack" (subset)
 */
export function parseMcpModeCommand(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();

  // Subset first — "mcp with notion and slack"
  const subsetMatch = t.match(/\b(?:mcp|tools)\s+(?:with|only|just)\s+([a-z0-9 ,-]+?)(?:\s*$|[.!?])/);
  if (subsetMatch) {
    const servers = subsetMatch[1]
      .split(/\s*(?:,|\band\b)\s*/)
      .map(s => s.trim())
      .filter(Boolean);
    if (servers.length) return { mode: 'full', servers };
  }

  if (/\b(mcp\s+off|turn\s+off\s+mcp|disable\s+mcp|disable\s+tools|no\s+tools|fast\s+mode|voice\s+mode|tools\s+off|turn\s+off\s+tools)\b/.test(t)) {
    return { mode: 'off' };
  }
  if (/\b(mcp\s+on|full\s+mcp|enable\s+mcp|enable\s+tools|turn\s+on\s+mcp|turn\s+on\s+tools|give\s+me\s+tools|tools\s+on|unlock\s+tools)\b/.test(t)) {
    return { mode: 'full' };
  }
  return null;
}

/**
 * Resolve the full resume-card info for a Discord message.
 * @param {import('discord.js').Message} message
 * @returns {{channelId, threadId?, chatId, model, directory, configDir?} | null}
 */
export function resolveHandoff(message) {
  const parentId = message.channel?.parentId || message.channelId;
  const isThread = !!message.channel?.isThread?.();
  const threadId = isThread ? message.channelId : null;

  const sessions = readJson(SESSIONS_FILE);
  const key = threadId
    ? `agent:main:discord:channel:${parentId}:thread:${threadId}`
    : `agent:main:discord:channel:${parentId}`;
  const chatId = sessions[key];

  if (!chatId) {
    logger.info(`[handoff-resolver] no session for ${key}`);
    return null;
  }

  const registry = readJson(REGISTRY);
  const entry = registry[parentId] || {};
  const name = entry.name || (message.channel?.name || '').replace(/[^a-z0-9-]/gi, '-');
  const directory = entry.directory || `${process.env.HOME}/Dev/${name}`;
  const model = entry.model || 'claude-sonnet-4-6';

  return { channelId: parentId, threadId, chatId, model, directory, name };
}
