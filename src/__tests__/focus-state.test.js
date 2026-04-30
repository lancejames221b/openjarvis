import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs before importing focus-state (it reads STATE_FILE on module load)
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: vi.fn((fn) => vi.fn()),
}));

vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Sample registry for tests — FLAT format (keyed by channelId, no channels wrapper)
const SAMPLE_REGISTRY = {
  'chan-gibson': {
    name: 'gibson',
    aliases: ['gibson-main', 'gib'],
    purpose: 'Gibson AI project',
    project: { name: 'Gibson', repo: 'unit221b/gibson', branch: 'main' },
    currentFocus: 'Working on beta launch',
    todos: ['Review PR', 'Update docs'],
    mcpTools: ['notion-oauth', 'linear'],
  },
  'chan-ewitness': {
    name: 'ewitness-engineering',
    aliases: ['ewitness', 'ew-api'],
    purpose: 'eWitness engineering channel',
    project: { name: 'eWitness' },
    currentFocus: null,
    todos: [],
    mcpTools: [],
  },
  'chan-jarvis-voice': {
    name: 'jarvis-voice-dev',
    aliases: ['jarvis voice', 'voice dev'],
    purpose: 'Jarvis voice bot development',
    project: { name: 'Jarvis Voice' },
    currentFocus: null,
    todos: [],
    mcpTools: [],
  },
  'chan-worktree': {
    name: 'ewitness-dev',
    purpose: 'eWitness worktree channel',
    directory: '/home/user/Dev/ewitness',
    model: 'claude-sonnet-4-6',
    projectPath: '/home/user/Dev/ewitness',
    baseRef: 'main',
    worktreeMode: 'per-thread',
    worktreeRoot: '/home/user/dev/worktrees',
  },
};

import { readFileSync, writeFileSync } from 'fs';

describe('focus-state.js', () => {
  // We need to set up mocks before the module loads the registry.
  // Use a factory approach — dynamic import after mocks are set.
  let focusStateModule;

  beforeEach(async () => {
    vi.clearAllMocks();

    // STATE_FILE read → no saved state (empty / throws)
    // REGISTRY_PATH read → SAMPLE_REGISTRY
    readFileSync.mockImplementation((path, enc) => {
      const p = String(path);
      if (p.includes('focus-state.json')) {
        throw new Error('ENOENT');
      }
      if (p.includes('channel-registry.json')) {
        return JSON.stringify(SAMPLE_REGISTRY);
      }
      // context files
      if (p.includes('.md')) {
        return '# Channel Directive\n## Purpose\nTest purpose.';
      }
      throw new Error(`Unexpected readFileSync: ${p}`);
    });

    writeFileSync.mockReturnValue(undefined);

    // Re-import to get fresh module state (vi.resetModules resets the cache)
    vi.resetModules();

    // Re-mock after resetModules
    vi.mock('fs', () => ({
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
    }));
    vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

    focusStateModule = await import('../state/focus-state.js');

    // Reapply mock implementation after module reload
    const { readFileSync: rfs, writeFileSync: wfs } = await import('fs');
    rfs.mockImplementation((path, enc) => {
      const p = String(path);
      if (p.includes('focus-state.json')) throw new Error('ENOENT');
      if (p.includes('channel-registry.json')) return JSON.stringify(SAMPLE_REGISTRY);
      if (p.includes('.md')) return '# Channel Directive\n## Purpose\nTest purpose.';
      throw new Error(`Unexpected readFileSync: ${p}`);
    });
    wfs.mockReturnValue(undefined);
  });

  // ── resolveChannel ───────────────────────────────────────────────
  describe('resolveChannel()', () => {
    it('exact name match returns channel entry', () => {
      const result = focusStateModule.resolveChannel('gibson');
      expect(result).not.toBeNull();
      expect(result.channelId).toBe('chan-gibson');
      expect(result.channelName).toBe('gibson');
    });

    it('alias match returns channel entry', () => {
      const result = focusStateModule.resolveChannel('gib');
      expect(result).not.toBeNull();
      expect(result.channelId).toBe('chan-gibson');
    });

    it('"gibson-main" alias resolves to gibson channel', () => {
      const result = focusStateModule.resolveChannel('gibson-main');
      expect(result).not.toBeNull();
      expect(result.channelId).toBe('chan-gibson');
    });

    it('fuzzy match: "jarvis voice" → "jarvis-voice-dev"', () => {
      const result = focusStateModule.resolveChannel('jarvis voice');
      expect(result).not.toBeNull();
      expect(result.channelName).toBe('jarvis-voice-dev');
    });

    it('prefix match: "ewitness" → "ewitness-engineering"', () => {
      const result = focusStateModule.resolveChannel('ewitness');
      expect(result).not.toBeNull();
      expect(result.channelId).toBe('chan-ewitness');
    });

    it('slug normalization: "eWitness Engineering" resolves', () => {
      const result = focusStateModule.resolveChannel('eWitness Engineering');
      expect(result).not.toBeNull();
      expect(result.channelId).toBe('chan-ewitness');
    });

    it('returns purpose in resolved result', () => {
      const result = focusStateModule.resolveChannel('gibson');
      expect(result.purpose).toBe('Gibson AI project');
    });

    it('returns null for unknown channel name', () => {
      const result = focusStateModule.resolveChannel('does-not-exist-xyz');
      expect(result).toBeNull();
    });

    it('returns null for empty string', () => {
      const result = focusStateModule.resolveChannel('');
      expect(result).toBeNull();
    });

    it('minimum score threshold: very dissimilar name returns null', () => {
      // "abc" vs all channel names — should not match above threshold 40
      const result = focusStateModule.resolveChannel('zxqvmwp');
      expect(result).toBeNull();
    });
  });

  // ── setFocusByName / getFocus / clearFocus / hasFocus ────────────
  describe('setFocusByName() / getFocus() / clearFocus() / hasFocus()', () => {
    it('setFocusByName returns focus object for known channel', () => {
      const result = focusStateModule.setFocusByName('gibson');
      expect(result).not.toBeNull();
      expect(result.channelId).toBe('chan-gibson');
      expect(result.channelName).toBe('gibson');
    });

    it('setFocusByName returns null for unknown channel', () => {
      const result = focusStateModule.setFocusByName('nonexistent-channel');
      expect(result).toBeNull();
    });

    it('getFocus returns null before any focus is set', () => {
      expect(focusStateModule.getFocus()).toBeNull();
    });

    it('getFocus returns focus after setFocusByName', () => {
      focusStateModule.setFocusByName('gibson');
      const focus = focusStateModule.getFocus();
      expect(focus).not.toBeNull();
      expect(focus.channelId).toBe('chan-gibson');
    });

    it('hasFocus returns false before setting focus', () => {
      expect(focusStateModule.hasFocus()).toBe(false);
    });

    it('hasFocus returns true after setFocusByName', () => {
      focusStateModule.setFocusByName('gibson');
      expect(focusStateModule.hasFocus()).toBe(true);
    });

    it('clearFocus sets focus to null', () => {
      focusStateModule.setFocusByName('gibson');
      focusStateModule.clearFocus();
      expect(focusStateModule.getFocus()).toBeNull();
      expect(focusStateModule.hasFocus()).toBe(false);
    });

    it('setFocusByName persists state via writeFileSync', () => {
      focusStateModule.setFocusByName('gibson');
      expect(writeFileSync).toHaveBeenCalled();
    });

    it('setFocusByName sets setAt timestamp', () => {
      const before = new Date().toISOString();
      const result = focusStateModule.setFocusByName('gibson');
      expect(result.setAt).toBeDefined();
      expect(new Date(result.setAt).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });
  });

  // ── isFocusFresh ─────────────────────────────────────────────────
  describe('isFocusFresh()', () => {
    it('returns false when no focus is set', () => {
      expect(focusStateModule.isFocusFresh()).toBe(false);
    });

    it('returns true for freshly set focus (just now)', () => {
      focusStateModule.setFocusByName('gibson');
      expect(focusStateModule.isFocusFresh(4)).toBe(true);
    });

    it('returns false for stale focus (older than maxAgeHours)', async () => {
      focusStateModule.setFocusByName('gibson');
      const focus = focusStateModule.getFocus();
      // Manually backdate the setAt to 5 hours ago
      focus.setAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      expect(focusStateModule.isFocusFresh(4)).toBe(false);
    });

    it('returns true when maxAgeHours is large enough', () => {
      focusStateModule.setFocusByName('gibson');
      const focus = focusStateModule.getFocus();
      // Backdate to 3 hours ago
      focus.setAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      expect(focusStateModule.isFocusFresh(4)).toBe(true);
    });
  });

  // ── touchFocus ──────────────────────────────────────────────────
  describe('touchFocus()', () => {
    it('does nothing when no focus set', () => {
      expect(() => focusStateModule.touchFocus()).not.toThrow();
    });

    it('refreshes setAt timestamp when called', async () => {
      focusStateModule.setFocusByName('gibson');
      const focus = focusStateModule.getFocus();
      // Backdate to 2 hours ago
      const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      focus.setAt = oldTime;

      focusStateModule.touchFocus();

      const updatedFocus = focusStateModule.getFocus();
      expect(updatedFocus.setAt).not.toBe(oldTime);
      const updatedMs = new Date(updatedFocus.setAt).getTime();
      const twoHoursAgoMs = Date.now() - 2 * 60 * 60 * 1000;
      expect(updatedMs).toBeGreaterThan(twoHoursAgoMs);
    });
  });

  // ── getFocusContextTag ─────────────────────────────────────────
  describe('getFocusContextTag()', () => {
    it('returns null when no focus set', () => {
      expect(focusStateModule.getFocusContextTag()).toBeNull();
    });

    it('returns a string starting with [CHANNEL FOCUS:', () => {
      focusStateModule.setFocusByName('gibson');
      const tag = focusStateModule.getFocusContextTag();
      expect(typeof tag).toBe('string');
      expect(tag).toContain('[CHANNEL FOCUS: #gibson');
    });

    it('includes purpose in the tag', () => {
      focusStateModule.setFocusByName('gibson');
      const tag = focusStateModule.getFocusContextTag();
      expect(tag).toContain('Gibson AI project');
    });

    it('includes channel registry section with todos', () => {
      focusStateModule.setFocusByName('gibson');
      const tag = focusStateModule.getFocusContextTag();
      expect(tag).toContain('[CHANNEL REGISTRY:');
    });

    it('includes haivemind search instruction', () => {
      focusStateModule.setFocusByName('gibson');
      const tag = focusStateModule.getFocusContextTag();
      expect(tag).toContain('[CHANNEL MEMORY:');
    });
  });

  // ── listChannels ──────────────────────────────────────────────
  describe('listChannels()', () => {
    it('returns all channels from registry', () => {
      const channels = focusStateModule.listChannels();
      expect(Array.isArray(channels)).toBe(true);
      expect(channels.length).toBe(4); // gibson, ewitness, jarvis-voice-dev, ewitness-dev
    });

    it('each channel has channelId, name, aliases', () => {
      const channels = focusStateModule.listChannels();
      for (const ch of channels) {
        expect(ch).toHaveProperty('channelId');
        expect(ch).toHaveProperty('name');
        expect(ch).toHaveProperty('aliases');
        expect(Array.isArray(ch.aliases)).toBe(true);
      }
    });

    it('includes gibson channel', () => {
      const channels = focusStateModule.listChannels();
      const gibson = channels.find(c => c.name === 'gibson');
      expect(gibson).toBeDefined();
      expect(gibson.channelId).toBe('chan-gibson');
    });

    it('includes channel aliases', () => {
      const channels = focusStateModule.listChannels();
      const gibson = channels.find(c => c.name === 'gibson');
      expect(gibson.aliases).toContain('gib');
    });
  });

  // ── worktree fields in focus state ──────────────────────────────
  describe('worktree fields from registry entry', () => {
    it('setFocusByName includes projectPath when registry entry has it', () => {
      const result = focusStateModule.setFocusByName('ewitness-dev');
      expect(result).not.toBeNull();
      expect(result.projectPath).toBe('/home/user/Dev/ewitness');
    });

    it('setFocusByName includes worktreeMode when registry entry has it', () => {
      const result = focusStateModule.setFocusByName('ewitness-dev');
      expect(result.worktreeMode).toBe('per-thread');
    });

    it('setFocusByName includes baseRef when registry entry has it', () => {
      const result = focusStateModule.setFocusByName('ewitness-dev');
      expect(result.baseRef).toBe('main');
    });

    it('setFocusByName includes worktreeRoot when registry entry has it', () => {
      const result = focusStateModule.setFocusByName('ewitness-dev');
      expect(result.worktreeRoot).toBe('/home/user/dev/worktrees');
    });

    it('setFocusByName omits worktree fields for channels without worktree config', () => {
      const result = focusStateModule.setFocusByName('gibson');
      expect(result).not.toBeNull();
      // Fields should be undefined or null — not present from a channel with no worktree config
      expect(result.projectPath == null).toBe(true);
      expect(result.worktreeMode == null || result.worktreeMode === 'none').toBe(true);
    });

    it('setFocusById includes worktree fields', () => {
      const result = focusStateModule.setFocusById('chan-worktree', 'ewitness-dev');
      expect(result.projectPath).toBe('/home/user/Dev/ewitness');
      expect(result.worktreeMode).toBe('per-thread');
      expect(result.baseRef).toBe('main');
      expect(result.worktreeRoot).toBe('/home/user/dev/worktrees');
    });
  });
});
