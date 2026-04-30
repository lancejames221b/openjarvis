/**
 * registry-schema — JSDoc types and validation helpers for channel-registry.json entries.
 *
 * The registry file is a flat JSON object keyed by Discord channel ID:
 *   { "<channelId>": RegistryEntry, ... }
 *
 * New optional fields added in Pillar 3 (worktree isolation):
 *   projectPath, baseRef, worktreeMode, worktreeRoot
 */

/**
 * @typedef {Object} RegistryEntry
 * @property {string} name - Human-readable channel name (e.g. "ewitness-dev")
 * @property {string} [directory] - Local working directory for claude sessions
 * @property {string} [model] - Default Claude model (e.g. 'claude-sonnet-4-6')
 * @property {string[]} [aliases] - Alternate names for voice/text resolution
 * @property {string} [purpose] - One-line description of the channel's purpose
 * @property {string} [currentFocus] - Current work focus description
 * @property {string} [lastActive] - ISO 8601 timestamp of last activity
 * @property {string[]} [notes] - Free-form notes
 * @property {string[]} [todos] - Open task items
 * @property {string} [projectPath] - Absolute path to the git repository for this channel
 * @property {string} [baseRef] - Default git ref to branch from (default: 'main')
 * @property {'per-thread'|'per-channel'|'none'} [worktreeMode] - Worktree isolation mode (default: 'none')
 * @property {string} [worktreeRoot] - Root directory for worktrees (default: '~/dev/openjarvis-worktrees')
 */

/** @type {readonly ('per-thread'|'per-channel'|'none')[]} */
const VALID_WORKTREE_MODES = ['per-thread', 'per-channel', 'none'];

/**
 * Apply defaults to a raw registry entry.
 * Does not mutate the input.
 * @param {Partial<RegistryEntry>} entry
 * @returns {RegistryEntry}
 */
export function normalizeEntry(entry) {
  return {
    ...entry,
    worktreeMode: entry.worktreeMode ?? 'none',
    baseRef: entry.baseRef ?? 'main',
    worktreeRoot: entry.worktreeRoot ?? '~/dev/openjarvis-worktrees',
  };
}

/**
 * Validate a registry entry.
 * Returns true if the entry is valid, false if there are structural errors.
 * @param {Partial<RegistryEntry>} entry
 * @returns {boolean}
 */
export function validateEntry(entry) {
  if (entry.worktreeMode !== undefined && !VALID_WORKTREE_MODES.includes(entry.worktreeMode)) {
    return false;
  }
  if (entry.worktreeMode === 'per-thread' || entry.worktreeMode === 'per-channel') {
    if (!entry.projectPath) return false;
  }
  return true;
}
