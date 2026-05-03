import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({ readFileSync: vi.fn() }));
vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { readFileSync } from 'fs';

const SESSION_KEY_FLAT = 'agent:main:discord:channel:chan-123';
const SESSION_KEY_THREAD = 'agent:main:discord:channel:chan-123:thread:thread-456';

const SESSIONS = {
  [SESSION_KEY_FLAT]: 'chat-uuid-flat',
  [SESSION_KEY_THREAD]: 'chat-uuid-thread',
};

const REGISTRY = {
  'chan-123': {
    name: 'ewitness-dev',
    directory: '/home/user/Dev/ewitness',
    model: 'claude-sonnet-4-6',
    projectPath: '/home/user/Dev/ewitness',
    baseRef: 'main',
    worktreeMode: 'per-thread',
    worktreeRoot: '/home/user/dev/openjarvis-worktrees',
  },
  'chan-no-worktree': {
    name: 'general',
    directory: '/home/user/Dev/general',
    model: 'claude-haiku-4-5',
  },
};

function makeMessage({ channelId, parentId = null, isThread = false, channelName = 'test' } = {}) {
  return {
    channelId,
    channel: {
      id: channelId,
      name: channelName,
      parentId,
      isThread: () => isThread,
    },
  };
}

let resolveHandoff;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.mock('fs', () => ({ readFileSync: vi.fn() }));
  vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

  const { readFileSync: rfs } = await import('fs');
  rfs.mockImplementation((path) => {
    const p = String(path);
    if (p.includes('jarvis-sessions')) return JSON.stringify(SESSIONS);
    if (p.includes('channel-registry')) return JSON.stringify(REGISTRY);
    throw new Error(`Unexpected: ${p}`);
  });

  ({ resolveHandoff } = await import('../discord/handoff-resolver.js'));
});

describe('resolveHandoff', () => {
  describe('top-level channel', () => {
    it('returns null when no session exists', () => {
      const msg = makeMessage({ channelId: 'chan-unknown' });
      expect(resolveHandoff(msg)).toBeNull();
    });

    it('returns core fields for a known channel with a session', () => {
      const msg = makeMessage({ channelId: 'chan-123' });
      const result = resolveHandoff(msg);
      expect(result).not.toBeNull();
      expect(result.channelId).toBe('chan-123');
      expect(result.threadId).toBeNull();
      expect(result.chatId).toBe('chat-uuid-flat');
      expect(result.model).toBe('claude-sonnet-4-6');
      expect(result.directory).toBe('/home/user/Dev/ewitness');
      expect(result.name).toBe('ewitness-dev');
    });

    it('includes worktree fields from the registry entry', () => {
      const msg = makeMessage({ channelId: 'chan-123' });
      const result = resolveHandoff(msg);
      expect(result.projectPath).toBe('/home/user/Dev/ewitness');
      expect(result.worktreeMode).toBe('per-thread');
      expect(result.baseRef).toBe('main');
      expect(result.worktreeRoot).toBe('/home/user/dev/openjarvis-worktrees');
    });

  });

  describe('thread message', () => {
    it('returns the thread id and uses parent channel for registry lookup', () => {
      const msg = makeMessage({ channelId: 'thread-456', parentId: 'chan-123', isThread: true });
      const result = resolveHandoff(msg);
      expect(result).not.toBeNull();
      expect(result.channelId).toBe('chan-123');
      expect(result.threadId).toBe('thread-456');
      expect(result.chatId).toBe('chat-uuid-thread');
    });

    it('includes worktree fields resolved via parent channel', () => {
      const msg = makeMessage({ channelId: 'thread-456', parentId: 'chan-123', isThread: true });
      const result = resolveHandoff(msg);
      expect(result.projectPath).toBe('/home/user/Dev/ewitness');
      expect(result.worktreeMode).toBe('per-thread');
    });
  });

  describe('missing registry entry', () => {
    it('falls back gracefully — projectPath null, worktreeMode none', async () => {
      const SESSIONS_FALLBACK = { 'agent:main:discord:channel:chan-fallback': 'chat-fallback' };
      vi.resetModules();
      vi.mock('fs', () => ({ readFileSync: vi.fn() }));
      vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
      const { readFileSync: rfs2 } = await import('fs');
      rfs2.mockImplementation((path) => {
        const p = String(path);
        if (p.includes('jarvis-sessions')) return JSON.stringify(SESSIONS_FALLBACK);
        if (p.includes('channel-registry')) return JSON.stringify({});
        throw new Error(`Unexpected: ${p}`);
      });
      const { resolveHandoff: rh } = await import('../discord/handoff-resolver.js');
      const msg = makeMessage({ channelId: 'chan-fallback' });
      const result = rh(msg);
      expect(result).not.toBeNull();
      expect(result.projectPath).toBeNull();
      expect(result.worktreeMode).toBe('none');
      expect(result.baseRef).toBe('main');
    });
  });
});
