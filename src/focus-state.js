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
    // Return the full directive — truncation happens at injection time
    // based on whether it's for the voice prompt tag or sub-agent context
    return content.trim() || null;
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
 * Get a rich context string for injection into voice prompts.
 * Includes channel registry metadata (project, repo, branch, todos, tracking),
 * channel directive, and haivemind search instructions.
 * Returns null if unfocused.
 * @returns {string | null}
 */
export function getFocusContextTag() {
  if (!_focus) return null;

  const registry = _loadRegistry();
  const channelData = registry.channels?.[_focus.channelId] || {};

  let tag = `[CHANNEL FOCUS: #${_focus.channelName}`;
  if (_focus.purpose) {
    tag += ` — ${_focus.purpose}`;
  }
  tag += ']\n';

  // ── Channel registry metadata ──────────────────────────────────────
  const parts = [];

  if (channelData.currentFocus) {
    parts.push(`Current Focus: ${channelData.currentFocus}`);
  }

  if (channelData.todos && channelData.todos.length > 0) {
    parts.push(`Open TODOs:\n${channelData.todos.map(t => `  - ${t}`).join('\n')}`);
  }

  // Project details (repo, branch, GCP, Linear, etc.)
  const proj = channelData.project;
  if (proj) {
    const projLines = [];
    if (proj.name) projLines.push(`Project: ${proj.name}`);
    if (proj.status) projLines.push(`Status: ${proj.status}${proj.statusReason ? ` (${proj.statusReason})` : ''}`);
    if (proj.repo) projLines.push(`Repo: ${proj.repo}${proj.branch ? `, branch: ${proj.branch}` : ''}`);
    if (proj.gcpProject) projLines.push(`GCP: ${proj.gcpProject}${proj.gcpServer ? ` (${proj.gcpServer})` : ''}`);
    if (proj.linearUrl) projLines.push(`Linear: ${proj.linearUrl}`);
    if (proj.dueDate) projLines.push(`Due: ${proj.dueDate}`);
    parts.push(projLines.join('\n'));
  }

  // Tracking (Notion, Trello)
  const tracking = channelData.tracking;
  if (tracking) {
    const trackLines = [];
    if (tracking.notion?.commandCenter?.url) {
      trackLines.push(`Notion: ${tracking.notion.commandCenter.url}`);
    }
    if (tracking.trello?.url) {
      trackLines.push(`Trello: ${tracking.trello.url}`);
    }
    if (trackLines.length) parts.push(trackLines.join('\n'));
  }

  // MCP tools configured for this channel
  if (channelData.mcpTools && channelData.mcpTools.length > 0) {
    parts.push(`MCP Tools: ${channelData.mcpTools.join(', ')}`);
  }

  if (parts.length > 0) {
    tag += `[CHANNEL REGISTRY:\n${parts.join('\n')}\n]\n`;
  }

  // ── Channel directive ──────────────────────────────────────────────
  if (_focus.directive) {
    // Generous slice — sub-agents need real context
    const snippet = _focus.directive.substring(0, 2000);
    tag += `[CHANNEL DIRECTIVE:\n${snippet}\n]`;
  }

  // ── haivemind search instruction ───────────────────────────────────
  tag += `\n[CHANNEL MEMORY: Search haivemind for "${_focus.channelId} context" to restore prior work and decisions for this channel.]`;

  return tag;
}

/**
 * Get the full context blob for sub-agent task injection.
 * Richer than the prompt tag — includes everything the sub-agent needs.
 * @returns {string | null}
 */
export function getFullFocusContext() {
  if (!_focus) return null;

  const registry = _loadRegistry();
  const channelData = registry.channels?.[_focus.channelId] || {};

  let ctx = `## Channel Context: #${_focus.channelName} (${_focus.channelId})\n`;
  if (_focus.purpose) ctx += `**Purpose:** ${_focus.purpose}\n`;

  if (channelData.currentFocus) ctx += `**Current Focus:** ${channelData.currentFocus}\n`;

  if (channelData.todos?.length > 0) {
    ctx += `**Open TODOs:**\n${channelData.todos.map(t => `- ${t}`).join('\n')}\n`;
  }

  const proj = channelData.project;
  if (proj) {
    ctx += `**Project:** ${proj.name || 'unnamed'}`;
    if (proj.status) ctx += ` | Status: ${proj.status}`;
    if (proj.repo) ctx += ` | Repo: ${proj.repo}`;
    if (proj.branch) ctx += ` | Branch: ${proj.branch}`;
    if (proj.gcpProject) ctx += ` | GCP: ${proj.gcpProject}`;
    if (proj.gcpServer) ctx += ` | Server: ${proj.gcpServer}`;
    if (proj.linearUrl) ctx += ` | Linear: ${proj.linearUrl}`;
    if (proj.dueDate) ctx += ` | Due: ${proj.dueDate}`;
    ctx += '\n';
  }

  const tracking = channelData.tracking;
  if (tracking) {
    if (tracking.notion?.commandCenter?.url) ctx += `**Notion:** ${tracking.notion.commandCenter.url}\n`;
    if (tracking.trello?.url) ctx += `**Trello:** ${tracking.trello.url}\n`;
  }

  if (channelData.contextFile) {
    ctx += `**Context file:** ~/dev/contexts/${channelData.contextFile}\n`;
  }

  // Full directive (no truncation for sub-agents)
  if (_focus.directive) {
    ctx += `\n### Channel Directive\n${_focus.directive}\n`;
  }

  ctx += `\n**haivemind:** Search for "${_focus.channelId} context" to get prior work and decisions.\n`;
  ctx += `**Post output to:** Discord channel ${_focus.channelId} (#${_focus.channelName})\n`;

  return ctx;
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
