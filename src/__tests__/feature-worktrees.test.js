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

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const {
  ensureWorktree,
  removeWorktree,
  getWorktreePath,
  listActiveWorktrees,
  _resetRegistryCache,
} = await import('../agent/worktree-manager.js');

const {
  handleWtStatusCommand,
  handleWtCleanCommand,
} = await import('../discord/slash/wt-commands.js');

// ── Fixtures ───────────────────────────────────────────────────────────────

const CHANNEL_ID = 'chan-alpha';
const THREAD_ID = 'thread-001';
const PROJECT_PATH = '/tmp/test-proj';
const WORKTREE_ROOT = '/tmp/test-wt';
const EXPECTED_WT_PATH = `${WORKTREE_ROOT}/alpha-dev-${THREAD_ID}`;
const EXPECTED_BRANCH = `agent/alpha-dev/${THREAD_ID}`;

const REGISTRY_PER_THREAD = {
  [CHANNEL_ID]: {
    name: 'alpha-dev',
    projectPath: PROJECT_PATH,
    baseRef: 'main',
    worktreeMode: 'per-thread',
    worktreeRoot: WORKTREE_ROOT,
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function setupRegistry(reg) {
  readFileSync.mockImplementation((path) => {
    const p = String(path);
    if (p.includes('channel-registry')) return JSON.stringify(reg);
    if (p.includes('worktree-paths')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    throw new Error(`Unexpected readFileSync: ${p}`);
  });
}

function setupRegistryWithState(reg, state) {
  readFileSync.mockImplementation((path) => {
    const p = String(path);
    if (p.includes('channel-registry')) return JSON.stringify(reg);
    if (p.includes('worktree-paths')) return JSON.stringify(state);
    throw new Error(`Unexpected readFileSync: ${p}`);
  });
}

// Default: branch absent, baseRef present, add/remove succeed
function gitMock(args) {
  const sub = args[0];
  if (sub === 'worktree' && args[1] === 'list') return { status: 0, stdout: '', stderr: '' };
  if (sub === 'show-ref') return { status: 0, stdout: '', stderr: '' };
  if (sub === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
  if (sub === 'worktree' && args[1] === 'remove') return { status: 0, stdout: '', stderr: '' };
  if (sub === 'status') return { status: 0, stdout: '', stderr: '' };
  return { status: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
}

function newBranchGitMock(args) {
  if (args[0] === 'show-ref' && args[2]?.includes('refs/heads/agent/')) {
    return { status: 1, stdout: '', stderr: '' }; // branch not found → will use -b
  }
  return gitMock(args);
}

function porcelainFor(wPath) {
  return `worktree ${wPath}\nHEAD abc123\nbranch refs/heads/agent/alpha\n\n`;
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _resetRegistryCache();
  writeFileSync.mockReturnValue(undefined);
  setupRegistry(REGISTRY_PER_THREAD);
  spawnSync.mockImplementation((_cmd, args) => newBranchGitMock(args));
});

// ── Scenario 1: ensureWorktree for new thread ──────────────────────────────

describe('scenario 1 — ensureWorktree for new thread spawns git worktree add', () => {
  it('calls git worktree add -b with correct path and branch', async () => {
    const path = await ensureWorktree(CHANNEL_ID, THREAD_ID);

    expect(path).toBe(EXPECTED_WT_PATH);

    const addCall = spawnSync.mock.calls.find(c => c[1][0] === 'worktree' && c[1][1] === 'add');
    expect(addCall).toBeDefined();
    expect(addCall[1]).toEqual([
      'worktree', 'add', '-b', EXPECTED_BRANCH, EXPECTED_WT_PATH, 'main',
    ]);
  });

  it('persists the new worktree entry to state', async () => {
    await ensureWorktree(CHANNEL_ID, THREAD_ID);

    const saved = JSON.parse(writeFileSync.mock.calls.at(-1)[1]);
    const entry = saved[`${CHANNEL_ID}:${THREAD_ID}`];
    expect(entry).toBeDefined();
    expect(entry.path).toBe(EXPECTED_WT_PATH);
    expect(entry.channelId).toBe(CHANNEL_ID);
    expect(entry.threadId).toBe(THREAD_ID);
  });
});

// ── Scenario 2: idempotent ─────────────────────────────────────────────────

describe('scenario 2 — ensureWorktree is idempotent for the same channelKey', () => {
  it('returns the existing path on a second call without spawning git worktree add again', async () => {
    const path1 = await ensureWorktree(CHANNEL_ID, THREAD_ID);
    expect(path1).toBe(EXPECTED_WT_PATH);

    // Simulate the written state being available on disk
    const savedState = JSON.parse(writeFileSync.mock.calls.at(-1)[1]);
    setupRegistryWithState(REGISTRY_PER_THREAD, savedState);

    // Git confirms the worktree still exists
    spawnSync.mockImplementation((_cmd, args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: porcelainFor(EXPECTED_WT_PATH), stderr: '' };
      }
      return gitMock(args);
    });

    const addCallsBefore = spawnSync.mock.calls.filter(
      c => c[1][0] === 'worktree' && c[1][1] === 'add',
    ).length;

    const path2 = await ensureWorktree(CHANNEL_ID, THREAD_ID);
    expect(path2).toBe(EXPECTED_WT_PATH);

    const addCallsAfter = spawnSync.mock.calls.filter(
      c => c[1][0] === 'worktree' && c[1][1] === 'add',
    ).length;
    expect(addCallsAfter).toBe(addCallsBefore);
  });
});

// ── Scenario 3: path naming convention ─────────────────────────────────────

describe('scenario 3 — worktree path follows channelName-threadId naming convention', () => {
  it('path is <worktreeRoot>/<channelName>-<threadId>', async () => {
    const path = await ensureWorktree(CHANNEL_ID, THREAD_ID);
    expect(path).toMatch(new RegExp(`^${WORKTREE_ROOT}/[^/]+-${THREAD_ID}$`));
    expect(path).toContain('alpha-dev');
  });

  it('branch is agent/<channelName>/<threadId>', async () => {
    await ensureWorktree(CHANNEL_ID, THREAD_ID);
    const addCall = spawnSync.mock.calls.find(c => c[1][0] === 'worktree' && c[1][1] === 'add');
    // -b <branch> is at index 3 when creating a new branch
    const branchArg = addCall[1][3];
    expect(branchArg).toBe(EXPECTED_BRANCH);
    expect(branchArg).toMatch(/^agent\/.+\/.+$/);
  });
});

// ── Scenario 4: getWorktreePath ─────────────────────────────────────────────

describe('scenario 4 — getWorktreePath', () => {
  it('returns the path for an existing tracked worktree', () => {
    const state = {
      [`${CHANNEL_ID}:${THREAD_ID}`]: {
        path: EXPECTED_WT_PATH, branch: EXPECTED_BRANCH,
        channelId: CHANNEL_ID, threadId: THREAD_ID, createdAt: 1,
      },
    };
    setupRegistryWithState(REGISTRY_PER_THREAD, state);

    expect(getWorktreePath(CHANNEL_ID, THREAD_ID)).toBe(EXPECTED_WT_PATH);
  });

  it('returns null for an unknown channelId/threadId', () => {
    expect(getWorktreePath('unknown-chan', 'thread-x')).toBeNull();
  });

  it('returns null when state file is missing', () => {
    // readFileSync throws ENOENT for state file (already the default setup)
    expect(getWorktreePath(CHANNEL_ID, THREAD_ID)).toBeNull();
  });
});

// ── Scenario 5: removeWorktree --force ─────────────────────────────────────

describe('scenario 5 — removeWorktree spawns git worktree remove --force', () => {
  const trackedState = {
    [`${CHANNEL_ID}:${THREAD_ID}`]: {
      path: EXPECTED_WT_PATH, branch: EXPECTED_BRANCH,
      channelId: CHANNEL_ID, threadId: THREAD_ID, createdAt: 1,
    },
  };

  it('runs git worktree remove --force and removes the state entry', async () => {
    setupRegistryWithState(REGISTRY_PER_THREAD, trackedState);

    await removeWorktree(CHANNEL_ID, THREAD_ID);

    const removeCall = spawnSync.mock.calls.find(
      c => c[1][0] === 'worktree' && c[1][1] === 'remove',
    );
    expect(removeCall).toBeDefined();
    expect(removeCall[1]).toEqual(['worktree', 'remove', '--force', EXPECTED_WT_PATH]);

    const saved = JSON.parse(writeFileSync.mock.calls.at(-1)[1]);
    expect(saved[`${CHANNEL_ID}:${THREAD_ID}`]).toBeUndefined();
  });

  it('is a no-op when channelKey has no tracked worktree', async () => {
    // state file is missing (default mock setup)
    await removeWorktree(CHANNEL_ID, 'thread-unknown');

    expect(spawnSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('force-removes even when worktree is dirty (unlike cleanupWorktree)', async () => {
    setupRegistryWithState(REGISTRY_PER_THREAD, trackedState);

    // git status reports dirty
    spawnSync.mockImplementation((_cmd, args) => {
      if (args[0] === 'status') return { status: 0, stdout: 'M dirty.js\n', stderr: '' };
      return gitMock(args);
    });

    await removeWorktree(CHANNEL_ID, THREAD_ID);

    const removeCall = spawnSync.mock.calls.find(
      c => c[1][0] === 'worktree' && c[1][1] === 'remove',
    );
    expect(removeCall).toBeDefined();
    expect(removeCall[1]).toContain('--force');
  });
});

// ── Scenario 6: /wt status command ────────────────────────────────────────

describe('scenario 6 — /wt status lists active worktrees with channelKey mapping', () => {
  it('includes the path and channelId in the reply for each active worktree', async () => {
    setupRegistryWithState(REGISTRY_PER_THREAD, {
      [`${CHANNEL_ID}:${THREAD_ID}`]: {
        path: EXPECTED_WT_PATH, branch: EXPECTED_BRANCH,
        channelId: CHANNEL_ID, threadId: THREAD_ID, createdAt: Date.now(),
      },
    });

    const reply = vi.fn();
    await handleWtStatusCommand({ reply });

    expect(reply).toHaveBeenCalledOnce();
    const { content } = reply.mock.calls[0][0];
    expect(content).toContain(CHANNEL_ID);
    expect(content).toContain(EXPECTED_WT_PATH);
  });

  it('replies with a "no active worktrees" message when state is empty', async () => {
    // state file throws ENOENT (default beforeEach setup)
    const reply = vi.fn();
    await handleWtStatusCommand({ reply });

    expect(reply).toHaveBeenCalledOnce();
    const { content } = reply.mock.calls[0][0];
    expect(content.toLowerCase()).toMatch(/no.*(active|worktree)/);
  });
});

// ── Scenario 7: /wt clean command ─────────────────────────────────────────

describe('scenario 7 — /wt clean removes worktrees for dead Discord threads', () => {
  const trackedState = {
    [`${CHANNEL_ID}:${THREAD_ID}`]: {
      path: EXPECTED_WT_PATH, branch: EXPECTED_BRANCH,
      channelId: CHANNEL_ID, threadId: THREAD_ID, createdAt: Date.now(),
    },
  };

  it('removes a worktree when its Discord thread no longer exists', async () => {
    setupRegistryWithState(REGISTRY_PER_THREAD, trackedState);

    const client = {
      channels: { fetch: vi.fn().mockRejectedValue(new Error('Unknown Channel')) },
    };
    const reply = vi.fn();

    await handleWtCleanCommand({ reply }, client);

    // git worktree remove --force should have been called
    const removeCall = spawnSync.mock.calls.find(
      c => c[1][0] === 'worktree' && c[1][1] === 'remove',
    );
    expect(removeCall).toBeDefined();
    expect(removeCall[1]).toContain('--force');

    expect(reply).toHaveBeenCalledOnce();
    const { content } = reply.mock.calls[0][0];
    expect(content.toLowerCase()).toMatch(/clean|remov/);
    expect(content).toContain(THREAD_ID);
  });

  it('skips worktrees for threads that still exist in Discord', async () => {
    setupRegistryWithState(REGISTRY_PER_THREAD, trackedState);

    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({ id: THREAD_ID }) },
    };
    const reply = vi.fn();

    await handleWtCleanCommand({ reply }, client);

    expect(spawnSync.mock.calls.some(c => c[1][0] === 'worktree' && c[1][1] === 'remove')).toBe(false);

    expect(reply).toHaveBeenCalledOnce();
    const { content } = reply.mock.calls[0][0];
    expect(content.toLowerCase()).toMatch(/no.*stale|nothing/);
  });
});

// ── Scenario 8: worktreeMode=per-thread gates ensureWorktree ───────────────

describe('scenario 8 — worktreeMode=per-thread causes ensureWorktree to return a path', () => {
  it('returns a non-null path for a channel with worktreeMode=per-thread', async () => {
    setupRegistry(REGISTRY_PER_THREAD);
    const path = await ensureWorktree(CHANNEL_ID, THREAD_ID);
    expect(path).toBeTruthy();
    expect(path).toContain(THREAD_ID);
  });

  it('calls git worktree add when worktreeMode=per-thread and thread is new', async () => {
    setupRegistry(REGISTRY_PER_THREAD);
    await ensureWorktree(CHANNEL_ID, THREAD_ID);
    expect(spawnSync.mock.calls.some(c => c[1][0] === 'worktree' && c[1][1] === 'add')).toBe(true);
  });
});

// ── Scenario 9: worktreeMode=none (or unset) blocks ensureWorktree ─────────

describe('scenario 9 — worktreeMode=none or unset means ensureWorktree is NOT called', () => {
  it('returns null when worktreeMode is "none"', async () => {
    setupRegistry({
      [CHANNEL_ID]: { name: 'alpha-dev', projectPath: PROJECT_PATH, worktreeMode: 'none' },
    });
    const path = await ensureWorktree(CHANNEL_ID, THREAD_ID);
    expect(path).toBeNull();
    expect(spawnSync.mock.calls.some(c => c[1][0] === 'worktree' && c[1][1] === 'add')).toBe(false);
  });

  it('returns null when worktreeMode is absent from the registry entry', async () => {
    setupRegistry({
      [CHANNEL_ID]: { name: 'alpha-dev', projectPath: PROJECT_PATH },
    });
    const path = await ensureWorktree(CHANNEL_ID, THREAD_ID);
    expect(path).toBeNull();
    expect(spawnSync.mock.calls.some(c => c[1][0] === 'worktree' && c[1][1] === 'add')).toBe(false);
  });
});

// ── Scenario 10: git worktree add failure ──────────────────────────────────

describe('scenario 10 — git worktree add failure: null returned, no state persisted', () => {
  it('returns null when git worktree add exits non-zero', async () => {
    spawnSync.mockImplementation((_cmd, args) => {
      if (args[0] === 'show-ref' && args[2]?.includes('refs/heads/agent/')) {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        return { status: 128, stdout: '', stderr: 'fatal: failed to create worktree' };
      }
      return gitMock(args);
    });

    const path = await ensureWorktree(CHANNEL_ID, THREAD_ID);
    expect(path).toBeNull();
  });

  it('does not persist state when git worktree add fails', async () => {
    spawnSync.mockImplementation((_cmd, args) => {
      if (args[0] === 'show-ref' && args[2]?.includes('refs/heads/agent/')) {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        return { status: 1, stdout: '', stderr: 'error: something went wrong' };
      }
      return gitMock(args);
    });

    await ensureWorktree(CHANNEL_ID, THREAD_ID);

    // Any state writes must not contain an entry for this thread
    for (const call of writeFileSync.mock.calls) {
      if (!String(call[0]).includes('worktree-paths')) continue;
      const saved = JSON.parse(call[1]);
      expect(saved[`${CHANNEL_ID}:${THREAD_ID}`]).toBeUndefined();
    }
  });
});
