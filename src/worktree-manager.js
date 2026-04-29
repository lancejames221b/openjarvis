import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const STATE_DIR = `${process.env.HOME ?? '/tmp'}/.local/state/jarvis-voice`;
export const WORKTREE_PATHS_FILE =
  process.env.WORKTREE_PATHS_FILE ?? `${STATE_DIR}/worktree-paths.json`;

const REGISTRY_PATH =
  process.env.CHANNEL_REGISTRY_PATH ??
  `${process.env.HOME ?? '/tmp'}/dev/contexts/channel-registry.json`;

try { mkdirSync(STATE_DIR, { recursive: true }); } catch {}

// ── State persistence ──────────────────────────────────────────────────────

function _loadState() {
  try {
    return JSON.parse(readFileSync(WORKTREE_PATHS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function _saveState(state) {
  try {
    writeFileSync(WORKTREE_PATHS_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[worktree-manager] state save failed: ${e.message}`);
  }
}

// ── Channel registry (TTL-cached, mirrors focus-state._loadRegistry pattern) ──

let _registry = null;
let _registryLoadedAt = 0;
const REGISTRY_TTL_MS = 60_000;

export function _resetRegistryCache() {
  _registry = null;
  _registryLoadedAt = 0;
}

function _loadRegistry() {
  const now = Date.now();
  if (_registry && now - _registryLoadedAt < REGISTRY_TTL_MS) return _registry;
  try {
    _registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    _registryLoadedAt = now;
  } catch {
    _registry = _registry ?? {};
  }
  return _registry;
}

function _lookupChannel(channelId) {
  return _loadRegistry()[channelId] ?? null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _stateKey(channelId, threadId) {
  return threadId ? `${channelId}:${threadId}` : `${channelId}:_channel_`;
}

function _expandPath(p) {
  return typeof p === 'string' ? p.replace(/^~/, process.env.HOME ?? '/tmp') : p;
}

function _git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function _worktreeExists(projectPath, worktreePath) {
  const r = _git(['worktree', 'list', '--porcelain'], projectPath);
  if (r.status !== 0) return false;
  return r.stdout.split('\n').some(line => line === `worktree ${worktreePath}`);
}

function _branchExists(projectPath, branchName) {
  return _git(['show-ref', '--verify', `refs/heads/${branchName}`], projectPath).status === 0;
}

function _refExists(projectPath, ref) {
  if (_git(['show-ref', '--verify', `refs/heads/${ref}`], projectPath).status === 0) return true;
  if (_git(['show-ref', '--verify', `refs/remotes/origin/${ref}`], projectPath).status === 0) return true;
  return false;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Ensure a git worktree exists for the given channel+thread combination.
 *
 * Per-thread: creates <worktreeRoot>/<channelName>-<threadId> on branch agent/<channelName>/<threadId>.
 * Per-channel: single shared worktree at <worktreeRoot>/<channelName> on branch agent/<channelName>.
 *
 * Returns the worktree path on success, or null when the channel has no
 * projectPath, worktreeMode is 'none'/absent, or a git operation fails.
 */
export async function ensureWorktree(channelId, threadId) {
  const entry = _lookupChannel(channelId);
  if (!entry?.projectPath || !entry.worktreeMode || entry.worktreeMode === 'none') return null;

  const { worktreeMode, name: channelName = channelId } = entry;
  const projectPath = _expandPath(entry.projectPath);
  const baseRef = entry.baseRef ?? 'main';
  const worktreeRoot = _expandPath(
    entry.worktreeRoot ?? `${process.env.HOME ?? '/tmp'}/dev/openjarvis-worktrees`,
  );

  let worktreePath, branchName, stateKey;
  if (worktreeMode === 'per-thread') {
    if (!threadId) return null;
    worktreePath = `${worktreeRoot}/${channelName}-${threadId}`;
    branchName = `agent/${channelName}/${threadId}`;
    stateKey = _stateKey(channelId, threadId);
  } else if (worktreeMode === 'per-channel') {
    worktreePath = `${worktreeRoot}/${channelName}`;
    branchName = `agent/${channelName}`;
    stateKey = _stateKey(channelId, null);
  } else {
    return null;
  }

  // Reuse if already tracked and still valid in git
  const state = _loadState();
  if (state[stateKey]?.path) {
    if (_worktreeExists(projectPath, state[stateKey].path)) {
      return state[stateKey].path;
    }
    // Stale entry — remove and fall through to re-create
    delete state[stateKey];
    _saveState(state);
  }

  try { mkdirSync(worktreeRoot, { recursive: true }); } catch {}

  // If git already knows about this worktree path (e.g. created externally), track it
  if (_worktreeExists(projectPath, worktreePath)) {
    state[stateKey] = { path: worktreePath, branch: branchName, channelId, threadId: threadId ?? null, createdAt: Date.now() };
    _saveState(state);
    return worktreePath;
  }

  // Create the worktree — reuse existing branch or create new from baseRef
  let addResult;
  if (_branchExists(projectPath, branchName)) {
    addResult = _git(['worktree', 'add', worktreePath, branchName], projectPath);
  } else {
    if (!_refExists(projectPath, baseRef)) {
      console.warn(`[worktree-manager] baseRef '${baseRef}' not found in ${projectPath}`);
      return null;
    }
    addResult = _git(['worktree', 'add', '-b', branchName, worktreePath, baseRef], projectPath);
  }

  if (addResult.status !== 0) {
    console.warn(`[worktree-manager] git worktree add failed: ${addResult.stderr}`);
    return null;
  }

  state[stateKey] = { path: worktreePath, branch: branchName, channelId, threadId: threadId ?? null, createdAt: Date.now() };
  _saveState(state);
  return worktreePath;
}

/**
 * Remove the tracked worktree for the given channel+thread.
 *
 * If the worktree has uncommitted changes, the directory is preserved (not deleted)
 * but the state entry is removed so ensureWorktree will re-create cleanly next time.
 */
export async function cleanupWorktree(channelId, threadId) {
  const stateKey = _stateKey(channelId, threadId);
  const state = _loadState();
  const tracked = state[stateKey];
  if (!tracked) return;

  const entry = _lookupChannel(channelId);
  const projectPath = entry?.projectPath ? _expandPath(entry.projectPath) : null;

  if (projectPath) {
    // Preserve uncommitted work — never auto-delete a dirty worktree
    const status = _git(['status', '--porcelain'], tracked.path);
    if (status.status === 0 && status.stdout.trim()) {
      console.warn(`[worktree-manager] Preserving dirty worktree at ${tracked.path} (uncommitted changes)`);
      delete state[stateKey];
      _saveState(state);
      return;
    }

    _git(['worktree', 'remove', tracked.path], projectPath);
  }

  delete state[stateKey];
  _saveState(state);
}

/**
 * Return all currently tracked active worktree entries.
 */
export function listActiveWorktrees() {
  return Object.values(_loadState());
}
