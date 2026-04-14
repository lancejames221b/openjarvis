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
import { exec as _exec } from 'child_process';
import { promisify } from 'util';
import logger from './logger.js';

const execAsync = promisify(_exec);

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '..', 'data', 'focus-state.json');
const REGISTRY_PATH = process.env.CHANNEL_REGISTRY_PATH || '/home/generic/dev/contexts/channel-registry.json';
const CONTEXTS_DIR = process.env.CHANNEL_CONTEXTS_DIR || '/home/generic/dev/contexts';

// ── Focus state ──────────────────────────────────────────────────────

let _focus = _loadState();
let _previousFocus = null; // Last focus before clear — for "refocus" back-button

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
  // Normalize spoken phrase: strip "channel", "the", "focus on", leading/trailing noise
  const normalized = query
    .replace(/^(?:focus\s+on|the|channel|thread)\s+/g, '')
    .replace(/\s+channel$/, '')
    .trim();
  const registry = _loadRegistry();
  const channels = registry.channels || {};

  // ── Pass 1: Exact match on name or alias ──────────────────────────
  for (const [channelId, data] of Object.entries(channels)) {
    const name = (data.name || '').toLowerCase();
    if (name === normalized || name === query) {
      return { channelId, channelName: data.name, purpose: data.purpose || '' };
    }
    if (data.aliases?.some(a => a.toLowerCase() === normalized || a.toLowerCase() === query)) {
      return { channelId, channelName: data.name, purpose: data.purpose || '' };
    }
  }

  // ── Pass 2: Partial / fuzzy match ────────────────────────────────
  // Score each channel: prefer longer overlap, penalize substring matches in wrong position.
  // "jarvis voice" → "jarvis-voice-dev"
  // "ewitness" → "ewitness-engineering" (if no exact match)
  // "gibson gtm" → "gibson-gtm"
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const querySlug = slug(normalized);

  let bestMatch = null;
  let bestScore = 0;

  for (const [channelId, data] of Object.entries(channels)) {
    const nameSlug = slug(data.name || '');
    const allTerms = [nameSlug, ...(data.aliases || []).map(a => slug(a))];

    for (const term of allTerms) {
      let score = 0;
      if (term === querySlug) { score = 100; }                          // exact slug match
      else if (term.startsWith(querySlug)) { score = 80; }              // prefix: "ewitness" → "ewitness-engineering"
      else if (term.includes(querySlug)) { score = 60; }                // substring in name
      else if (querySlug.includes(term) && term.length >= 4) { score = 40; } // query contains term
      else {
        // Word-overlap: "jarvis voice" (words: jarvis, voice) vs "jarvis-voice-dev" (words: jarvis, voice, dev)
        const qWords = querySlug.split('-').filter(w => w.length >= 3);
        const tWords = term.split('-');
        const overlap = qWords.filter(w => tWords.some(t => t.startsWith(w) || w.startsWith(t)));
        if (overlap.length > 0) {
          score = 20 + (overlap.length / Math.max(qWords.length, 1)) * 20;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = { channelId, channelName: data.name, purpose: data.purpose || '' };
      }
    }
  }

  // Only return fuzzy matches with reasonable confidence (score >= 40)
  if (bestScore >= 40) {
    logger.info(`[focus] Fuzzy resolved "${nameOrAlias}" → "${bestMatch.channelName}" (score=${bestScore})`);
    return bestMatch;
  }

  // ── Pass 3: Discord guild cache fallback ────────────────────────
  // If the channel isn't in the registry, try to find it in the Discord
  // bot's guild cache. This handles newly created channels that haven't
  // been registered yet.
  if (_discordGuildChannels) {
    const discordMatch = _findInDiscordCache(normalized, querySlug);
    if (discordMatch) {
      logger.info(`[focus] Discord cache resolved "${nameOrAlias}" → "${discordMatch.channelName}" (${discordMatch.channelId})`);
      return discordMatch;
    }
  }

  return null;
}

// ── Discord client + guild cache for channel resolution + message fetch ──
let _discordClient = null;
let _discordGuildChannels = null;

/**
 * Inject the Discord client from index.js at startup.
 * Used to fetch channel messages on focus.
 * @param {import('discord.js').Client} client
 */
export function setDiscordClient(client) {
  _discordClient = client;
  logger.info('[focus] Discord client injected — channel message fetch enabled');
}

/**
 * Inject the Discord guild channels map from index.js at startup.
 * Called once after client.ready.
 * @param {Map|Object} channels — guild.channels.cache (Discord.js Collection)
 */
export function setDiscordGuildChannels(channels) {
  _discordGuildChannels = channels;
  logger.info(`[focus] Discord guild cache loaded (${channels?.size || 0} channels)`);
}

function _findInDiscordCache(normalized, querySlug) {
  if (!_discordGuildChannels) return null;
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  let bestMatch = null;
  let bestScore = 0;

  for (const [id, ch] of _discordGuildChannels) {
    // Only text channels (type 0) and announcement (type 5)
    if (ch.type !== 0 && ch.type !== 5) continue;
    const nameSlug = slug(ch.name || '');

    let score = 0;
    if (nameSlug === querySlug) score = 100;
    else if (nameSlug.startsWith(querySlug)) score = 80;
    else if (nameSlug.includes(querySlug)) score = 60;
    else if (querySlug.includes(nameSlug) && nameSlug.length >= 4) score = 40;
    else {
      const qWords = querySlug.split('-').filter(w => w.length >= 3);
      const tWords = nameSlug.split('-');
      const overlap = qWords.filter(w => tWords.some(t => t.startsWith(w) || w.startsWith(t)));
      if (overlap.length > 0) {
        score = 20 + (overlap.length / Math.max(qWords.length, 1)) * 20;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { channelId: id, channelName: ch.name, purpose: ch.topic || '' };
    }
  }

  return bestScore >= 50 ? bestMatch : null; // Slightly higher threshold for unregistered channels
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
 * Check if the current focus was set recently enough to be considered fresh.
 * "Fresh" means it was set within the last `maxAgeHours` hours (default 4h).
 * Used to suppress stale focus announcements on join — e.g. "focused on plex"
 * from a session that ended days ago.
 * @param {number} [maxAgeHours=4]
 * @returns {boolean}
 */
export function isFocusFresh(maxAgeHours = 4) {
  if (!_focus?.setAt) return false;
  const ageMs = Date.now() - new Date(_focus.setAt).getTime();
  return ageMs < maxAgeHours * 60 * 60 * 1000;
}

/**
 * Refresh the focus timestamp to "now" without changing the channel.
 * Called on each voice task completion so active focus stays fresh.
 * Focus goes stale (and stops announcing on join) after 4h of inactivity.
 */
export function touchFocus() {
  if (!_focus) return;
  _focus.setAt = new Date().toISOString();
  _saveState(_focus);
}

/**
 * Build structured references for a channel — actionable paths, tools, commands.
 * @param {string} channelId
 * @param {object} channelData — registry entry
 * @returns {object}
 */
function _buildReferences(channelId, channelData) {
  const refs = {};
  const proj = channelData.project || {};

  // File paths
  refs.contextFile = `~/dev/contexts/${channelId}.md`;
  refs.channelRegistryPath = '~/dev/contexts/channel-registry.json';

  // Repo / working directory
  if (proj.repo) {
    // Derive local repo path from repo name
    const repoName = proj.repo.split('/').pop();
    refs.repo = proj.repo;
    refs.branch = proj.branch || 'main';
    refs.localPath = `~/dev/${repoName}`;
  }

  // Infrastructure
  if (proj.gcpProject) refs.gcpProject = proj.gcpProject;
  if (proj.gcpServer) refs.gcpServer = proj.gcpServer;
  if (proj.cloudSQL) refs.cloudSQL = `${proj.cloudSQL}/${proj.cloudSQLDb || ''}`;
  if (proj.esCluster) refs.esCluster = proj.esCluster;

  // Tracking URLs
  const tracking = channelData.tracking || {};
  if (tracking.notion?.commandCenter?.url) refs.notionUrl = tracking.notion.commandCenter.url;
  if (tracking.trello?.url) refs.trelloUrl = tracking.trello.url;
  if (proj.linearUrl) refs.linearUrl = proj.linearUrl;

  // MCP tools for this channel's domain
  refs.mcpTools = channelData.mcpTools || [];

  // Actionable commands
  refs.commands = {
    readDirective: `cat ~/dev/contexts/${channelId}.md`,
    searchHaivemind: `mcporter call haivemind.search_memories query="${channelId} context" limit=10`,
    readDiscord: `message action=read channelId=${channelId} limit=20`,
  };
  if (proj.repo) {
    refs.commands.gitStatus = `cd ~/dev/${proj.repo.split('/').pop()} && git status`;
    refs.commands.gitLog = `cd ~/dev/${proj.repo.split('/').pop()} && git log --oneline -5`;
  }

  return refs;
}

/**
 * Fetch recent Discord messages from a channel.
 * Ground truth — always run BEFORE haivemind.
 * Stores result in _focus.discordContext.
 * @param {string} channelId
 * @param {number} [limit=30] — number of messages to fetch
 */
async function _prefetchDiscordMessages(channelId, limit = 30) {
  if (!_discordClient) {
    logger.warn('[focus] No Discord client — skipping channel message fetch');
    return;
  }

  try {
    const channel = await _discordClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased?.()) {
      logger.warn(`[focus] Channel ${channelId} is not text-based or not found`);
      return;
    }

    const messages = await channel.messages.fetch({ limit });
    if (!messages || messages.size === 0) {
      logger.info(`[focus] No messages found in #${channel.name}`);
      return;
    }

    // Format messages oldest-first for natural reading order
    const sorted = [...messages.values()].reverse();
    const formatted = sorted.map(m => {
      const ts = m.createdAt.toISOString().replace('T', ' ').substring(0, 19);
      const author = m.author?.username || 'unknown';
      const content = m.content || (m.attachments.size > 0 ? `[${m.attachments.size} attachment(s)]` : '[empty]');
      return `[${ts}] ${author}: ${content}`;
    }).join('\n');

    if (_focus && _focus.channelId === channelId) {
      _focus.discordContext = formatted.substring(0, 4000); // Cap at 4k chars
      _saveState(_focus);
      logger.info(`[focus] Fetched ${sorted.length} Discord messages from #${channel.name}`);
    }
  } catch (err) {
    logger.warn(`[focus] Discord message fetch failed (non-fatal): ${err.message}`);
  }
}

/**
 * Pre-fetch haivemind context for a channel. Fire-and-forget, non-blocking.
 * Stores result in _focus.haivemindContext.
 * @param {string} channelId
 */
async function _prefetchHaivemind(channelId) {
  try {
    const mcporterPath = process.env.MCPORTER_PATH || '/home/generic/.npm-global/bin/mcporter';
    // Shell-safe: wrap key=value args in double quotes, escape inner content
    // CRITICAL: mcporter reads config relative to CWD — must run from ~/dev
    const query = `${channelId} context`.replace(/"/g, '\\"');
    const { stdout } = await execAsync(
      `${mcporterPath} call haivemind.search_memories "query=${query}" "limit=8"`,
      { timeout: 10000, cwd: '/home/generic/dev', env: { ...process.env, PATH: `${process.env.PATH}:/home/generic/.npm-global/bin` } }
    );
    const raw = stdout.trim();
    const data = JSON.parse(raw);
    const memories = data?.result?.memories || data?.memories || [];
    if (memories.length > 0 && _focus && _focus.channelId === channelId) {
      _focus.haivemindContext = memories
        .map(m => m.content || String(m))
        .join('\n---\n')
        .substring(0, 2000);
      _saveState(_focus);
      logger.info(`[focus] Pre-fetched ${memories.length} haivemind memories for #${_focus.channelName}`);
    }
  } catch (e) {
    logger.warn(`[focus] haivemind pre-fetch failed (non-fatal): ${e.message}`);
  }
}

/**
 * Post a breadcrumb notice to the previously-focused channel when switching focus.
 * Non-blocking, fire-and-forget.
 * @param {object} oldFocus — previous focus state
 * @param {string} newChannelName — name of the new channel
 */
async function _postFocusBreadcrumb(oldFocus, newChannelName) {
  if (!_discordClient || !oldFocus?.channelId) return;
  // Don't post breadcrumb if switching to the same channel
  if (oldFocus.channelId === newChannelName) return;

  try {
    const channel = await _discordClient.channels.fetch(oldFocus.channelId);
    if (channel?.isTextBased?.()) {
      await channel.send(`📌 *Switching focus to **#${newChannelName}***`);
      logger.info(`[focus] Posted breadcrumb to #${oldFocus.channelName} → #${newChannelName}`);
    }
  } catch (err) {
    logger.warn(`[focus] Breadcrumb post failed (non-fatal): ${err.message}`);
  }
}

/**
 * Set the focus to a channel (by name/alias).
 * Resolves the channel, loads its directive, builds structured references,
 * and kicks off a haivemind pre-fetch.
 * @param {string} nameOrAlias — channel name or alias (e.g. "gibson")
 * @returns {{ channelId: string, channelName: string, directive: string|null, purpose: string, references: object } | null}
 */
export function setFocusByName(nameOrAlias) {
  const resolved = resolveChannel(nameOrAlias);
  if (!resolved) return null;
  const previousFocus = _focus;
  // Save for refocus back-button
  if (_focus) _previousFocus = { ..._focus };

  const directive = loadDirective(resolved.channelId);
  const registry = _loadRegistry();
  const channelData = registry.channels?.[resolved.channelId] || {};
  const references = _buildReferences(resolved.channelId, channelData);

  _focus = {
    channelId: resolved.channelId,
    channelName: resolved.channelName,
    purpose: resolved.purpose,
    directive: directive || null,
    references,
    discordContext: null, // populated async by _prefetchDiscordMessages
    haivemindContext: null, // populated async by _prefetchHaivemind
    setAt: new Date().toISOString(),
  };

  _saveState(_focus);
  logger.info(`[focus] Set focus: ${resolved.channelName} (${resolved.channelId})`);

  // Post breadcrumb to previous channel (fire-and-forget)
  if (previousFocus && previousFocus.channelId !== resolved.channelId) {
    _postFocusBreadcrumb(previousFocus, resolved.channelName);
  }

  // Pre-fetch context: Discord messages FIRST (ground truth), then haivemind
  _prefetchDiscordMessages(resolved.channelId).then(() => {
    _prefetchHaivemind(resolved.channelId);
  });

  return _focus;
}

/**
 * Set focus to a channel + an optional thread within it.
 * Resolves the channel by name/alias (fuzzy), then looks up active/archived threads
 * in that channel to find one matching threadHint (fuzzy name match).
 *
 * If a thread is found, stores threadId + threadName in the focus state.
 * The context tag will inject the thread name so sub-agents know to work in that thread.
 *
 * @param {string} nameOrAlias — channel name/alias
 * @param {string} threadHint — partial thread name spoken by user (e.g. "beta launch", "team-member")
 * @returns {Promise<FocusState|null>}
 */
export async function setFocusWithThread(nameOrAlias, threadHint) {
  const resolved = resolveChannel(nameOrAlias);
  if (!resolved) return null;
  const previousFocus = _focus;

  // Try to resolve the thread via Discord bot client (if available in global scope)
  let threadId = null;
  let threadName = null;

  try {
    // Query Discord REST for active + archived threads in the resolved channel
    const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
    const GUILD_ID = process.env.GUILD_ID;
    if (DISCORD_TOKEN && GUILD_ID) {
      const headers = { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' };
      const fetch = (await import('node-fetch')).default;

      // Active threads first
      const activeRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/threads/active`, { headers });
      const activeData = activeRes.ok ? await activeRes.json() : { threads: [] };

      // Also try archived threads in the channel
      const archiveRes = await fetch(`https://discord.com/api/v10/channels/${resolved.channelId}/threads/archived/public?limit=25`, { headers });
      const archiveData = archiveRes.ok ? await archiveRes.json() : { threads: [] };

      const allThreads = [
        ...(activeData.threads || []).filter(t => t.parent_id === resolved.channelId),
        ...(archiveData.threads || []),
      ];

      // Fuzzy match threadHint against thread names
      const hint = threadHint.toLowerCase();
      const hintWords = hint.split(/\s+/).filter(w => w.length >= 3);

      let best = null;
      let bestScore = 0;
      for (const t of allThreads) {
        const tname = (t.name || '').toLowerCase();
        let score = 0;
        if (tname.includes(hint)) score = 80;
        else {
          const overlap = hintWords.filter(w => tname.includes(w));
          score = (overlap.length / Math.max(hintWords.length, 1)) * 60;
        }
        if (score > bestScore) { bestScore = score; best = t; }
      }

      if (best && bestScore >= 40) {
        threadId = best.id;
        threadName = best.name;
        logger.info(`[focus] Thread resolved: "${threadHint}" → "${threadName}" (${threadId}) score=${bestScore}`);
      } else {
        logger.info(`[focus] No thread matched "${threadHint}" in #${resolved.channelName} (${allThreads.length} threads checked)`);
      }
    }
  } catch (err) {
    logger.warn(`[focus] Thread lookup failed (non-fatal): ${err.message}`);
  }

  const directive = loadDirective(resolved.channelId);
  const registry = _loadRegistry();
  const channelData = registry.channels?.[resolved.channelId] || {};
  const references = _buildReferences(resolved.channelId, channelData);

  _focus = {
    channelId: resolved.channelId,
    channelName: resolved.channelName,
    purpose: resolved.purpose,
    directive: directive || null,
    references,
    discordContext: null,
    haivemindContext: null,
    setAt: new Date().toISOString(),
    ...(threadId ? { threadId, threadName } : {}),
  };

  _saveState(_focus);
  logger.info(`[focus] Set focus: ${resolved.channelName}${threadName ? ` › ${threadName}` : ''} (${resolved.channelId})`);

  // Post breadcrumb to previous channel
  if (previousFocus && previousFocus.channelId !== resolved.channelId) {
    _postFocusBreadcrumb(previousFocus, resolved.channelName);
  }

  // Discord messages FIRST (ground truth), then haivemind
  _prefetchDiscordMessages(resolved.channelId).then(() => {
    _prefetchHaivemind(resolved.channelId);
  });

  return _focus;
}

/**
 * Set focus directly by channel ID (used programmatically, e.g. from handoff).
 * @param {string} channelId
 * @param {string} channelName
 */
export function setFocusById(channelId, channelName) {
  const previousFocus = _focus;
  const directive = loadDirective(channelId);
  const registry = _loadRegistry();
  const channelData = registry.channels?.[channelId] || {};
  const references = _buildReferences(channelId, channelData);

  _focus = {
    channelId,
    channelName: channelName || channelData?.name || 'unknown',
    purpose: channelData?.purpose || '',
    directive: directive || null,
    references,
    discordContext: null,
    haivemindContext: null,
    setAt: new Date().toISOString(),
  };

  _saveState(_focus);
  logger.info(`[focus] Set focus by ID: ${_focus.channelName} (${channelId})`);

  // Post breadcrumb to previous channel
  if (previousFocus && previousFocus.channelId !== channelId) {
    _postFocusBreadcrumb(previousFocus, _focus.channelName);
  }

  // Discord messages FIRST (ground truth), then haivemind
  _prefetchDiscordMessages(channelId).then(() => {
    _prefetchHaivemind(channelId);
  });

  return _focus;
}

/** Clear the current focus. Saves previous focus for refocus back-button. */
export function clearFocus() {
  if (_focus) {
    _previousFocus = { ..._focus };
    logger.info(`[focus] Saved previous focus: ${_focus.channelName || _focus.channelId} for refocus`);
  }
  _focus = null;
  _saveState({});
  logger.info('[focus] Focus cleared');
}

/** Restore the previous focus (back-button). Returns the restored focus or null. */
export function refocus() {
  if (!_previousFocus) {
    logger.info('[focus] No previous focus to restore');
    return null;
  }
  _focus = { ..._previousFocus, setAt: new Date().toISOString() };
  _previousFocus = null;
  _saveState(_focus);
  logger.info(`[focus] Refocused on ${_focus.channelName || _focus.channelId}`);
  return _focus;
}

/** Get the previous focus (for status queries). */
export function getPreviousFocus() {
  return _previousFocus;
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
  if (_focus.threadName) {
    tag += ` › thread: ${_focus.threadName}`;
    if (_focus.threadId) tag += ` (${_focus.threadId})`;
  }
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

  // ── Structured references ──────────────────────────────────────────
  const refs = _focus.references || {};
  const refLines = [];
  if (refs.contextFile) refLines.push(`Context file: ${refs.contextFile}`);
  if (refs.repo) refLines.push(`Repo: ${refs.repo} (branch: ${refs.branch || 'main'})`);
  if (refs.localPath) refLines.push(`Local path: ${refs.localPath}`);
  if (refs.gcpProject) refLines.push(`GCP: ${refs.gcpProject}${refs.gcpServer ? ` (${refs.gcpServer})` : ''}`);
  if (refs.cloudSQL) refLines.push(`Cloud SQL: ${refs.cloudSQL}`);
  if (refLines.length > 0) {
    tag += `[REFERENCES:\n${refLines.join('\n')}\n]\n`;
  }

  // ── Pre-fetched Discord messages (ground truth) ────────────────────
  if (_focus.discordContext) {
    const discordSnippet = _focus.discordContext.substring(0, 2000);
    tag += `[RECENT MESSAGES (ground truth):\n${discordSnippet}\n]\n`;
  }

  // ── Pre-fetched haivemind context ─────────────────────────────────
  if (_focus.haivemindContext) {
    const memSnippet = _focus.haivemindContext.substring(0, 1200);
    tag += `[CHANNEL MEMORY (pre-fetched):\n${memSnippet}\n]\n`;
  } else {
    tag += `[CHANNEL MEMORY: Search haivemind for "${_focus.channelId} context" to restore prior work and decisions.]\n`;
  }

  return tag;
}

/**
 * Get the full context blob for sub-agent task injection.
 * Richer than the prompt tag — includes structured references,
 * pre-fetched haivemind context, actionable commands, and the full directive.
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

  // ── Structured references (actionable, not just descriptive) ──────
  const refs = _focus.references || {};
  ctx += `\n### References\n`;
  ctx += `- **Context file:** ${refs.contextFile || `~/dev/contexts/${_focus.channelId}.md`}\n`;
  if (refs.repo) ctx += `- **Repo:** ${refs.repo} (branch: ${refs.branch || 'main'})\n`;
  if (refs.localPath) ctx += `- **Local path:** ${refs.localPath}\n`;
  if (refs.gcpProject) ctx += `- **GCP project:** ${refs.gcpProject}${refs.gcpServer ? ` (${refs.gcpServer})` : ''}\n`;
  if (refs.cloudSQL) ctx += `- **Cloud SQL:** ${refs.cloudSQL}\n`;
  if (refs.notionUrl) ctx += `- **Notion:** ${refs.notionUrl}\n`;
  if (refs.trelloUrl) ctx += `- **Trello:** ${refs.trelloUrl}\n`;
  if (refs.linearUrl) ctx += `- **Linear:** ${refs.linearUrl}\n`;

  // ── Commands the sub-agent should run ─────────────────────────────
  const cmds = refs.commands || {};
  ctx += `\n### Startup Commands (run these first)\n`;
  ctx += `\`\`\`bash\n`;
  ctx += `# Read the full channel directive\n${cmds.readDirective || `cat ~/dev/contexts/${_focus.channelId}.md`}\n\n`;
  ctx += `# Search haivemind for prior work and decisions\n${cmds.searchHaivemind || `mcporter call haivemind.search_memories query="${_focus.channelId} context" limit=10`}\n\n`;
  ctx += `# Read recent Discord messages (ground truth)\n${cmds.readDiscord || `message action=read channelId=${_focus.channelId} limit=20`}\n`;
  if (cmds.gitStatus) {
    ctx += `\n# Check repo state\n${cmds.gitStatus}\n${cmds.gitLog}\n`;
  }
  ctx += `\`\`\`\n`;

  // ── Recent Discord messages (ground truth — always first) ─────────
  if (_focus.discordContext) {
    ctx += `\n### Recent Messages (ground truth)\n\`\`\`\n${_focus.discordContext.substring(0, 3000)}\n\`\`\`\n`;
  }

  // ── Pre-fetched haivemind context (if available) ──────────────────
  if (_focus.haivemindContext) {
    ctx += `\n### Prior Context (from haivemind)\n${_focus.haivemindContext}\n`;
  }

  // ── Full directive ────────────────────────────────────────────────
  if (_focus.directive) {
    ctx += `\n### Channel Directive\n${_focus.directive}\n`;
  }

  ctx += `\n**Post output to:** Discord channel ${_focus.channelId} (#${_focus.channelName})\n`;

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
