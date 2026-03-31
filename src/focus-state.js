/**
 * Focus State — persistent channel focus for voice context anchoring.
 *
 * When the user says "focus on Gibson" or "switch to ewitness", we:
 * 1. Resolve the channel name/alias against channel-registry.json
 * 2. Load the channel directive from ~/dev/contexts/{channelId}.md
 * 3. Store the focus state to data/focus-state.json (survives restarts)
 * 4. Inject [CHANNEL FOCUS] context tag into voice prompts
 *
 * The gateway agent then knows which project/channel the user is working
 * in and can pass that context to sub-agents.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '..', 'data', 'focus-state.json');
const REGISTRY_PATH = process.env.CHANNEL_REGISTRY_PATH || '/home/generic/dev/contexts/channel-registry.json';
const CONTEXTS_DIR = process.env.CHANNEL_CONTEXTS_DIR || '/home/generic/dev/contexts';

// ── Focus state ──────────────────────────────────────────────────────

let _focus = _loadState();

function _loadState() {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    if (state && state.channelId) {
      logger.info(`[focus] Restored focus: ${state.channelName} (${state.channelId})`);
      return state;
    }
  } catch {}
  return null;
}

function _saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`[focus] Failed to persist focus state: ${err.message}`);
  }
}

// ── Channel registry ────────────────────────────────────────────────

let _registry = null;
let _registryLoadedAt = 0;
const REGISTRY_TTL_MS = 60_000; // Reload every 60s max

function _loadRegistry() {
  const now = Date.now();
  if (_registry && now - _registryLoadedAt < REGISTRY_TTL_MS) return _registry;

  try {
    const raw = readFileSync(REGISTRY_PATH, 'utf8');
    _registry = JSON.parse(raw);
    _registryLoadedAt = now;
  } catch (err) {
    logger.warn(`[focus] Failed to load channel registry: ${err.message}`);
    if (!_registry) _registry = { channels: {} };
  }
  return _registry;
}

/**
 * Resolve a channel name or alias to a channel entry.
 * @param {string} nameOrAlias — e.g. "gibson", "ewitness", "general"
 * @returns {{ channelId: string, channelName: string, purpose: string } | null}
 */
export function resolveChannel(nameOrAlias) {
  if (!nameOrAlias) return null;
  const query = nameOrAlias.toLowerCase().trim();
  const registry = _loadRegistry();
  const channels = registry.channels || {};

  for (const [channelId, data] of Object.entries(channels)) {
    // Match channel name
    if (data.name && data.name.toLowerCase() === query) {
      return { channelId, channelName: data.name, purpose: data.purpose || '' };
    }
    // Match aliases
    if (data.aliases && Array.isArray(data.aliases)) {
      if (data.aliases.some(a => a.toLowerCase() === query)) {
        return { channelId, channelName: data.name, purpose: data.purpose || '' };
      }
    }
  }
  return null;
}

/**
 * Load channel directive from contexts/{channelId}.md
 * Returns a truncated snippet (~1500 chars) focused on purpose + current focus.
 * @param {string} channelId
 * @returns {string | null}
 */
export function loadDirective(channelId) {
  if (!channelId) return null;

  try {
    const filePath = join(CONTEXTS_DIR, `${channelId}.md`);
    const content = readFileSync(filePath, 'utf8');

    // Extract the most useful sections: first ~1500 chars, prioritising
    // headers, purpose, current focus, active work
    const lines = content.split('\n');
    const result = [];
    let chars = 0;
    const MAX_CHARS = 1500;

    for (const line of lines) {
      if (chars + line.length > MAX_CHARS) break;
      result.push(line);
      chars += line.length + 1;
    }

    return result.join('\n').trim() || null;
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────

/** Get the current focus state, or null if unfocused. */
export function getFocus() {
  return _focus;
}

/** Check if a channel focus is active. */
export function hasFocus() {
  return _focus !== null;
}

/**
 * Set the focus to a channel (by name/alias).
 * Resolves the channel, loads its directive, and persists.
 * @param {string} nameOrAlias — channel name or alias (e.g. "gibson")
 * @returns {{ channelId: string, channelName: string, directive: string|null, purpose: string } | null}
 */
export function setFocusByName(nameOrAlias) {
  const resolved = resolveChannel(nameOrAlias);
  if (!resolved) return null;

  const directive = loadDirective(resolved.channelId);

  _focus = {
    channelId: resolved.channelId,
    channelName: resolved.channelName,
    purpose: resolved.purpose,
    directive: directive || null,
    setAt: new Date().toISOString(),
  };

  _saveState(_focus);
  logger.info(`[focus] Set focus: ${resolved.channelName} (${resolved.channelId})`);
  return _focus;
}

/**
 * Set focus directly by channel ID (used programmatically).
 * @param {string} channelId
 * @param {string} channelName
 */
export function setFocusById(channelId, channelName) {
  const directive = loadDirective(channelId);
  const registry = _loadRegistry();
  const channelData = registry.channels?.[channelId];

  _focus = {
    channelId,
    channelName: channelName || channelData?.name || 'unknown',
    purpose: channelData?.purpose || '',
    directive: directive || null,
    setAt: new Date().toISOString(),
  };

  _saveState(_focus);
  logger.info(`[focus] Set focus by ID: ${_focus.channelName} (${channelId})`);
  return _focus;
}

/** Clear the current focus. */
export function clearFocus() {
  _focus = null;
  _saveState({});
  logger.info('[focus] Focus cleared');
}

/**
 * Get a compact context string for injection into voice prompts.
 * Returns null if unfocused.
 * @returns {string | null}
 */
export function getFocusContextTag() {
  if (!_focus) return null;

  let tag = `[CHANNEL FOCUS: #${_focus.channelName}`;
  if (_focus.purpose) {
    tag += ` — ${_focus.purpose}`;
  }
  tag += ']';

  // Append directive snippet if available (truncated for voice prompt)
  if (_focus.directive) {
    // Take just the first ~800 chars of the directive for the prompt
    const snippet = _focus.directive.substring(0, 800);
    tag += `\n[CHANNEL DIRECTIVE SNIPPET:\n${snippet}\n]`;
  }

  return tag;
}

/**
 * List all available channels (for "what channels are available" queries).
 * @returns {Array<{ channelId: string, name: string, aliases: string[] }>}
 */
export function listChannels() {
  const registry = _loadRegistry();
  const channels = registry.channels || {};
  return Object.entries(channels).map(([channelId, data]) => ({
    channelId,
    name: data.name || 'unknown',
    aliases: data.aliases || [],
  }));
}
