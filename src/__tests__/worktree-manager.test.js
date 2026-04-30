import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs and child_process before the module loads (top-level mkdirSync fires on import)
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const {
  ensureWorktree,
  cleanupWorktree,
  listActiveWorktrees,
  WORKTREE_PATHS_FILE,
  _resetRegistryCache,
} = await import('../agent/worktree-manager.js');

// ── Fixtures ───────────────────────────────────────────────────────────────

const PROJECT_PATH = '/tmp/test-project';
const WORKTREE_ROOT = '/tmp/test-worktrees';

const REGISTRY = {
  'chan-per-thread': {
    name: 'ewitness-dev',
    projectPath: PROJECT_PATH,
    baseRef: 'main',
    worktreeMode: 'per-thread',
    worktreeRoot: WORKTREE_ROOT,
  },
  'chan-per-channel': {
    name: 'ewitness-ops',
    projectPath: PROJECT_PATH,
    baseRef: 'main',
    worktreeMode: 'per-channel',
    worktreeRoot: WORKTREE_ROOT,
  },
  'chan-none': {
    name: 'general',
    directory: '/tmp/test-general',
    worktreeMode: 'none',
  },
  'chan-no-project': {
    name: 'no-project',
  },
};

// Helper: build git worktree list --porcelain output for a given path
function porcelainFor(wPath) {
  return `worktree ${wPath}\nHEAD abc123\nbranch refs/heads/agent/some\n\n`;
}

// Default spawnSync: no worktrees exist, all refs exist, add succeeds
function defaultGitMock(args) {
  const sub = args[0];
  if (sub === 'worktree' && args[1] === 'list') return { status: 0, stdout: '', stderr: '' };
  if (sub === 'show-ref') return { status: 0, stdout: '', stderr: '' };
  if (sub === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
  if (sub === 'worktree' && args[1] === 'remove') return { status: 0, stdout: '', stderr: '' };
  if (sub === 'status') return { status: 0, stdout: '', stderr: '' };
  return { status: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _resetRegistryCache();

  // Registry: return REGISTRY JSON; state file: start empty (throws ENOENT)
  readFileSync.mockImplementation((path) => {
    const p = String(path);
    if (p.includes('channel-registry')) return JSON.stringify(REGISTRY);
    if (p.includes('worktree-paths')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    throw new Error(`Unexpected readFileSync: ${p}`);
  });

  writeFileSync.mockReturnValue(undefined);
  mkdirSync.mockReturnValue(undefined);
  spawnSync.mockImplementation((_cmd, args) => defaultGitMock(args));
});

// ── ensureWorktree ─────────────────────────────────────────────────────────

describe('ensureWorktree', () => {
  describe('returns null for channels without worktree config', () => {
    it('channel missing from registry', async () => {
      expect(await ensureWorktree('chan-unknown', 'thread-1')).toBeNull();
    });

    it('channel has no projectPath', async () => {
      expect(await ensureWorktree('chan-no-project', 'thread-1')).toBeNull();
    });

    it('worktreeMode is none', async () => {
      expect(await ensureWorktree('chan-none', 'thread-1')).toBeNull();
    });

    it('per-thread channel with no threadId', async () => {
      expect(await ensureWorktree('chan-per-thread', null)).toBeNull();
      expect(await ensureWorktree('chan-per-thread', '')).toBeNull();
    });
  });

  describe('per-thread: creates new worktree', () => {
    it('runs git worktree add -b on new branch and returns path', async () => {
      // show-ref for branch: not found; show-ref for baseRef: found; worktree add: success
      spawnSync.mockImplementation((_cmd, args) => {
        if (args[0] === 'show-ref' && args[2]?.includes('refs/heads/agent/')) {
          return { status: 1, stdout: '', stderr: '' }; // branch does not exist
        }
        return defaultGitMock(args);
      });

      const path = await ensureWorktree('chan-per-thread', 'thread-1');
      expect(path).toBe(`${WORKTREE_ROOT}/ewitness-dev-thread-1`);

      // Verify git worktree add -b was called with correct args
      const addCall = spawnSync.mock.calls.find(c => c[1][0] === 'worktree' && c[1][1] === 'add');
      expect(addCall[1]).toEqual([
        'worktree', 'add', '-b',
        'agent/ewitness-dev/thread-1',
        `${WORKTREE_ROOT}/ewitness-dev-thread-1`,
        'main',
      ]);
    });

    it('saves state to worktree-paths.json', async () => {
      spawnSync.mockImplementation((_cmd, args) => {
        if (args[0] === 'show-ref' && args[2]?.includes('refs/heads/agent/')) {
          return { status: 1, stdout: '', stderr: '' };
        }
        return defaultGitMock(args);
      });

      await ensureWorktree('chan-per-thread', 'thread-1');

      const saved = JSON.parse(writeFileSync.mock.calls[0][1]);
      const key = 'chan-per-thread:thread-1';
      expect(saved[key].path).toBe(`${WORKTREE_ROOT}/ewitness-dev-thread-1`);
      expect(saved[key].branch).toBe('agent/ewitness-dev/thread-1');
      expect(saved[key].channelId).toBe('chan-per-thread');
      expect(saved[key].threadId).toBe('thread-1');
    });

    it('reuses existing branch (no -b flag)', async () => {
      // branch exists, no existing worktree
      spawnSync.mockImplementation((_cmd, args) => {
        if (args[0] === 'show-ref' && args[2]?.includes('refs/heads/agent/')) {
          return { status: 0, stdout: '', stderr: '' }; // branch exists
        }
        return defaultGitMock(args);
      });

      const path = await ensureWorktree('chan-per-thread', 'thread-2');
      expect(path).toBe(`${WORKTREE_ROOT}/ewitness-dev-thread-2`);

      const addCall = spawnSync.mock.calls.find(c => c[1][0] === 'worktree' && c[1][1] === 'add');
      expect(addCall[1]).toEqual([
        'worktree', 'add',
        `${WORKTREE_ROOT}/ewitness-dev-thread-2`,
        'agent/ewitness-dev/thread-2',
      ]);
    });

    it('returns null when baseRef does not exist', async () => {
      spawnSync.mockImplementation((_cmd, args) => {
        if (args[0] === 'show-ref') return { status: 1, stdout: '', stderr: '' };
        return defaultGitMock(args);
      });

      const path = await ensureWorktree('chan-per-thread', 'thread-1');
      expect(path).toBeNull();
      expect(spawnSync.mock.calls.some(c => c[1][0] === 'worktree' && c[1][1] === 'add')).toBe(false);
    });

    it('returns null when git worktree add fails', async () => {
      spawnSync.mockImplementation((_cmd, args) => {
        if (args[0] === 'show-ref' && args[2]?.includes('refs/heads/agent/')) {
          return { status: 1, stdout: '', stderr: '' };
        }
        if (args[0] === 'worktree' && args[1] === 'add') {
          return { status: 128, stdout: '', stderr: 'fatal: already exists' };
        }
        return defaultGitMock(args);
      });

      const path = await ensureWorktree('chan-per-thread', 'thread-1');
      expect(path).toBeNull();
    });
  });

  describe('per-thread: reuses existing worktree', () => {
    it('returns cached path when git confirms worktree still exists', async () => {
      const wPath = `${WORKTREE_ROOT}/ewitness-dev-thread-1`;
      const existingState = {
        'chan-per-thread:thread-1': { path: wPath, branch: 'agent/ewitness-dev/thread-1', channelId: 'chan-per-thread', threadId: 'thread-1', createdAt: Date.now() },
      };
      readFileSync.mockImplementation((path) => {
        const p = String(path);
        if (p.includes('channel-registry')) return JSON.stringify(REGISTRY);
        if (p.includes('worktree-paths')) return JSON.stringify(existingState);
        throw new Error(`Unexpected: ${p}`);
      });

      spawnSync.mockImplementation((_cmd, args) => {
        if (args[0] === 'worktree' && args[1] === 'list') {
          return { status: 0, stdout: porcelainFor(wPath), stderr: '' };
        }
        return defaultGitMock(args);
      });

      const path = await ensureWorktree('chan-per-thread', 'thread-1');
      expect(path).toBe(wPath);
      // No git worktree add should have been called
      expect(spawnSync.mock.calls.some(c => c[1][0] === 'worktree' && c[1][1] === 'add')).toBe(false);
    });

    it('re-creates worktree when state entry is stale (path gone from git)', async () => {
      const wPath = `${WORKTREE_ROOT}/ewitness-dev-thread-1`;
      const staleState = {
        'chan-per-thread:thread-1': { path: wPath, branch: 'agent/ewitness-dev/thread-1', channelId: 'chan-per-thread', threadId: 'thread-1', createdAt: Date.now() },
      };
      readFileSync.mockImplementation((path) => {
        const p = String(path);
        if (p.includes('channel-registry')) return JSON.stringify(REGISTRY);
        if (p.includes('worktree-paths')) return JSON.stringify(staleState);
        throw new Error(`Unexpected: ${p}`);
      });

      // git worktree list returns empty (stale path gone)
      spawnSync.mockImplementation((_cmd, args) => {
        if (args[0] === 'show-ref' && args[2]?.includes('refs/heads/agent/')) {
          return { status: 1, stdout: '', stderr: '' };
        }
        return defaultGitMock(args); // list returns empty, add succeeds
      });

      const path = await ensureWorktree('chan-per-thread', 'thread-1');
      expect(path).toBe(wPath);
      expect(spawnSync.mock.calls.some(c => c[1][0] === 'worktree' && c[1][1] === 'add')).toBe(true);
    });
  });

  describe('per-channel mode', () => {
    it('creates a single shared worktree (no threadId in path)', async () => {
      spawnSync.mockImplementation((_cmd, args) => {
        if (args[0] === 'show-ref' && args[2]?.includes('refs/heads/agent/')) {
          return { status: 1, stdout: '', stderr: '' };
        }
        return defaultGitMock(args);
      });

      const path = await ensureWorktree('chan-per-channel', 'thread-ignored');
      expect(path).toBe(`${WORKTREE_ROOT}/ewitness-ops`);

      const addCall = spawnSync.mock.calls.find(c => c[1][0] === 'worktree' && c[1][1] === 'add');
      // args: ['worktree','add','-b','agent/ewitness-ops','<path>','main']
      expect(addCall[1][5]).toBe('main'); // baseRef at index 5
    });

    it('state key uses _channel_ sentinel (no threadId)', async () => {
      spawnSync.mockImplementation((_cmd, args) => {
        if (args[0] === 'show-ref' && args[2]?.includes('refs/heads/agent/')) {
          return { status: 1, stdout: '', stderr: '' };
        }
        return defaultGitMock(args);
      });

      await ensureWorktree('chan-per-channel', 'thread-x');
      const saved = JSON.parse(writeFileSync.mock.calls[0][1]);
      expect(Object.keys(saved)).toContain('chan-per-channel:_channel_');
    });
  });

  describe('tilde expansion', () => {
    it('expands ~ in worktreeRoot', async () => {
      const registry = {
        'chan-tilde': {
          name: 'tilde-chan',
          projectPath: PROJECT_PATH,
          baseRef: 'main',
          worktreeMode: 'per-thread',
          worktreeRoot: '~/dev/my-worktrees',
        },
      };
      readFileSync.mockImplementation((path) => {
        const p = String(path);
        if (p.includes('channel-registry')) return JSON.stringify(registry);
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      spawnSync.mockImplementation((_cmd, args) => {
        if (args[0] === 'show-ref' && args[2]?.includes('refs/heads/agent/')) {
          return { status: 1, stdout: '', stderr: '' };
        }
        return defaultGitMock(args);
      });

      const path = await ensureWorktree('chan-tilde', 'thread-1');
      expect(path).not.toContain('~');
      expect(path).toContain('/dev/my-worktrees/');
    });
  });
});

// ── cleanupWorktree ────────────────────────────────────────────────────────

describe('cleanupWorktree', () => {
  const wPath = `${WORKTREE_ROOT}/ewitness-dev-thread-1`;
  const stateWithEntry = {
    'chan-per-thread:thread-1': { path: wPath, branch: 'agent/ewitness-dev/thread-1', channelId: 'chan-per-thread', threadId: 'thread-1', createdAt: Date.now() },
  };

  beforeEach(() => {
    readFileSync.mockImplementation((path) => {
      const p = String(path);
      if (p.includes('channel-registry')) return JSON.stringify(REGISTRY);
      if (p.includes('worktree-paths')) return JSON.stringify(stateWithEntry);
      throw new Error(`Unexpected: ${p}`);
    });
  });

  it('no-op when no state entry exists', async () => {
    readFileSync.mockImplementation((path) => {
      const p = String(path);
      if (p.includes('channel-registry')) return JSON.stringify(REGISTRY);
      if (p.includes('worktree-paths')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw new Error(`Unexpected: ${p}`);
    });

    await cleanupWorktree('chan-per-thread', 'thread-99');
    expect(spawnSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('runs git worktree remove for a clean worktree', async () => {
    // status --porcelain returns empty (clean)
    spawnSync.mockImplementation((_cmd, args) => defaultGitMock(args));

    await cleanupWorktree('chan-per-thread', 'thread-1');

    const removeCall = spawnSync.mock.calls.find(c => c[1][0] === 'worktree' && c[1][1] === 'remove');
    expect(removeCall).toBeDefined();
    expect(removeCall[1][2]).toBe(wPath);

    // State entry should be removed
    const saved = JSON.parse(writeFileSync.mock.calls[0][1]);
    expect(saved['chan-per-thread:thread-1']).toBeUndefined();
  });

  it('preserves dirty worktree — skips git worktree remove', async () => {
    spawnSync.mockImplementation((_cmd, args) => {
      if (args[0] === 'status') return { status: 0, stdout: 'M modified-file.js\n', stderr: '' };
      return defaultGitMock(args);
    });

    await cleanupWorktree('chan-per-thread', 'thread-1');

    expect(spawnSync.mock.calls.some(c => c[1][0] === 'worktree' && c[1][1] === 'remove')).toBe(false);

    // State entry still removed (so ensureWorktree can start fresh next time)
    const saved = JSON.parse(writeFileSync.mock.calls[0][1]);
    expect(saved['chan-per-thread:thread-1']).toBeUndefined();
  });
});

// ── listActiveWorktrees ────────────────────────────────────────────────────

describe('listActiveWorktrees', () => {
  it('returns empty array when state is empty', () => {
    expect(listActiveWorktrees()).toEqual([]);
  });

  it('returns all tracked worktree entries', () => {
    const wt1 = { path: '/wt/a', branch: 'agent/a/1', channelId: 'c1', threadId: 't1', createdAt: 1 };
    const wt2 = { path: '/wt/b', branch: 'agent/b/2', channelId: 'c2', threadId: null, createdAt: 2 };
    readFileSync.mockImplementation((path) => {
      const p = String(path);
      if (p.includes('channel-registry')) return JSON.stringify(REGISTRY);
      if (p.includes('worktree-paths')) return JSON.stringify({ 'c1:t1': wt1, 'c2:_channel_': wt2 });
      throw new Error(`Unexpected: ${p}`);
    });

    const list = listActiveWorktrees();
    expect(list).toHaveLength(2);
    expect(list).toContainEqual(wt1);
    expect(list).toContainEqual(wt2);
  });
});
