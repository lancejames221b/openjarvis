import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs and discord/voice before importing the module
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('@discordjs/voice', () => ({
  joinVoiceChannel: vi.fn(),
}));

vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { readFileSync } from 'fs';
import {
  detectChannelCommand,
  resolveChannel,
  loadDirective,
} from '../channel-router.js';

// ── Sample registry ──────────────────────────────────────────────────
const SAMPLE_REGISTRY = {
  discord: {
    'chan-001': {
      name: 'gibson',
      aliases: ['gibson-main', 'main-gibson'],
      directive: 'contexts/gibson.md',
      voiceChannelId: null,
    },
    'chan-002': {
      name: 'security',
      aliases: ['security-intel', 'sec'],
      directive: 'contexts/security.md',
      voiceChannelId: null,
    },
    'chan-003': {
      name: 'general',
      aliases: [],
      directive: null,
      voiceChannelId: null,
    },
  },
  voiceChannels: {
    'voice-001': {
      name: 'lobby',
      defaultContext: 'general',
    },
    'voice-002': {
      name: 'jarvis-voice',
      defaultContext: 'gibson',
    },
  },
};

describe('channel-router.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── detectChannelCommand ─────────────────────────────────────────────
  describe('detectChannelCommand()', () => {
    describe('move commands', () => {
      it('"go to lobby" → move action with target "lobby"', () => {
        const result = detectChannelCommand('go to lobby');
        expect(result.action).toBe('move');
        expect(result.target).toBe('lobby');
      });

      it('"move to the general channel" → move action with target "general"', () => {
        const result = detectChannelCommand('move to the general channel');
        expect(result.action).toBe('move');
        expect(result.target).toBe('general');
      });

      it('"join lobby" → move action', () => {
        const result = detectChannelCommand('join lobby');
        expect(result.action).toBe('move');
        expect(result.target).toBe('lobby');
      });

      it('"come to jarvis voice" → move action', () => {
        const result = detectChannelCommand('come to jarvis voice');
        expect(result.action).toBe('move');
      });
    });

    describe('query commands', () => {
      it('"where am i" → query action', () => {
        const result = detectChannelCommand('where am i');
        expect(result.action).toBe('query');
        expect(result.target).toBeNull();
      });

      it('"what context" → query action', () => {
        const result = detectChannelCommand('what context');
        expect(result.action).toBe('query');
      });

      it('"list channels" → query action', () => {
        const result = detectChannelCommand('list channels');
        expect(result.action).toBe('query');
      });

      it('"what channels are available" → query action', () => {
        const result = detectChannelCommand('what channels are available');
        expect(result.action).toBe('query');
      });

      it('"show channels" → query action', () => {
        const result = detectChannelCommand('show channels');
        expect(result.action).toBe('query');
      });
    });

    describe('focus commands', () => {
      it('"focus on security" → focus action with target "security"', () => {
        const result = detectChannelCommand('focus on security');
        expect(result.action).toBe('focus');
        expect(result.target).toBe('security');
      });

      it('"switch to gibson" → focus action', () => {
        const result = detectChannelCommand('switch to gibson');
        expect(result.action).toBe('focus');
        expect(result.target).toBe('gibson');
      });
    });

    describe('non-commands → null action', () => {
      it('"what time is it" → null action', () => {
        const result = detectChannelCommand('what time is it');
        expect(result.action).toBeNull();
      });

      it('"check my email" → null action', () => {
        const result = detectChannelCommand('check my email');
        expect(result.action).toBeNull();
      });

      it('empty string → null action', () => {
        const result = detectChannelCommand('');
        expect(result.action).toBeNull();
      });
    });

    it('returns the original raw transcript in result', () => {
      const transcript = 'go to lobby';
      const result = detectChannelCommand(transcript);
      expect(result.raw).toBe(transcript);
    });
  });

  // ── resolveChannel ────────────────────────────────────────────────
  describe('resolveChannel()', () => {
    it('exact name match returns correct channel', () => {
      const result = resolveChannel('gibson', SAMPLE_REGISTRY);
      expect(result).not.toBeNull();
      expect(result.channelId).toBe('chan-001');
      expect(result.channelName).toBe('gibson');
    });

    it('case-insensitive name match', () => {
      const result = resolveChannel('GIBSON', SAMPLE_REGISTRY);
      expect(result).not.toBeNull();
      expect(result.channelId).toBe('chan-001');
    });

    it('alias match returns correct channel', () => {
      const result = resolveChannel('sec', SAMPLE_REGISTRY);
      expect(result).not.toBeNull();
      expect(result.channelId).toBe('chan-002');
      expect(result.channelName).toBe('security');
    });

    it('another alias match', () => {
      const result = resolveChannel('gibson-main', SAMPLE_REGISTRY);
      expect(result).not.toBeNull();
      expect(result.channelId).toBe('chan-001');
    });

    it('voice channel lookup by name', () => {
      const result = resolveChannel('lobby', SAMPLE_REGISTRY);
      expect(result).not.toBeNull();
      expect(result.channelName).toBe('lobby');
      expect(result.voiceChannelId).toBe('voice-001');
    });

    it('returns null for unknown channel', () => {
      const result = resolveChannel('unknown-xyz', SAMPLE_REGISTRY);
      expect(result).toBeNull();
    });

    it('returns null for empty string', () => {
      const result = resolveChannel('', SAMPLE_REGISTRY);
      expect(result).toBeNull();
    });

    it('returns null for null input', () => {
      const result = resolveChannel(null, SAMPLE_REGISTRY);
      expect(result).toBeNull();
    });

    it('returns null for null registry', () => {
      const result = resolveChannel('gibson', null);
      expect(result).toBeNull();
    });

    it('returns directivePath from registry entry', () => {
      const result = resolveChannel('gibson', SAMPLE_REGISTRY);
      expect(result.directivePath).toBe('contexts/gibson.md');
    });

    it('returns null directivePath when not configured', () => {
      const result = resolveChannel('general', SAMPLE_REGISTRY);
      expect(result.directivePath).toBeNull();
    });
  });

  // ── loadDirective ────────────────────────────────────────────────
  describe('loadDirective()', () => {
    it('returns null for null path', () => {
      expect(loadDirective(null)).toBeNull();
    });

    it('returns null for undefined path', () => {
      expect(loadDirective(undefined)).toBeNull();
    });

    it('returns null when file read fails (e.g. not found)', () => {
      readFileSync.mockImplementation(() => { throw new Error('ENOENT: no such file'); });
      expect(loadDirective('contexts/nonexistent.md')).toBeNull();
    });

    it('returns truncated content from valid directive file', () => {
      const fakeContent = [
        '# Channel Directive',
        '## Purpose',
        'This channel is for security intelligence.',
        '## Active',
        'Working on incident tracking.',
        ...Array(100).fill('Some content line here.'),
      ].join('\n');

      readFileSync.mockReturnValue(fakeContent);
      const result = loadDirective('contexts/security.md');
      // Should return something (not null)
      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
      // Should be truncated to ~2000 chars
      expect(result.length).toBeLessThanOrEqual(2100);
    });

    it('returns first 2000 chars when no important sections found', () => {
      // No "## Purpose" etc. headers → falls back to first 2000 chars
      const fakeContent = 'Random content. '.repeat(200);
      readFileSync.mockReturnValue(fakeContent);
      const result = loadDirective('contexts/something.md');
      expect(result).not.toBeNull();
      expect(result.length).toBeLessThanOrEqual(2000);
    });
  });
});
