import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { _internal, tryChannelDispatch } from '../discord/channel-dispatch.js';

describe('channel-dispatch — _matchPattern()', () => {
  const cases = [
    ['register a channel called demos under engineering', 'demos', 'engineering'],
    ['Register a channel called Demos under the Engineering category', 'Demos', 'Engineering'],
    // Exact problem case from haivemind memory ea30f2d7 (2026-05-12)
    ['register a channel called Demos under the Engineering category in Discord', 'Demos', 'Engineering'],
    ['create a channel named foo in reverse-engineering', 'foo', 'reverse-engineering'],
    ['create a new channel named foo inside internal-tools category', 'foo', 'internal-tools'],
    ['new channel: bar under internal-tools', 'bar', 'internal-tools'],
    ['jarvis, register a channel called demos under engineering.', 'demos', 'engineering'],
    ['add a channel called pulse to the engineering category', 'pulse', 'engineering'],
    ['make a discord channel named test-chan under reverse engineering category', 'test-chan', 'reverse engineering'],
  ];

  for (const [text, expectedName, expectedCategory] of cases) {
    it(`matches "${text}"`, () => {
      const m = _internal._matchPattern(text);
      expect(m).not.toBeNull();
      expect(m.rawName.toLowerCase()).toBe(expectedName.toLowerCase());
      expect(m.rawCategory.toLowerCase()).toBe(expectedCategory.toLowerCase());
    });
  }

  it('returns null for unrelated text', () => {
    expect(_internal._matchPattern('what is the weather')).toBeNull();
    expect(_internal._matchPattern('show me the kanban board')).toBeNull();
    expect(_internal._matchPattern('')).toBeNull();
  });
});

describe('channel-dispatch — _slugify()', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(_internal._slugify('Demo Channel')).toBe('demo-channel');
  });
  it('removes invalid characters', () => {
    expect(_internal._slugify('demos!@#$')).toBe('demos');
  });
  it('preserves underscores and hyphens', () => {
    expect(_internal._slugify('demo_chan-1')).toBe('demo_chan-1');
  });
});

describe('channel-dispatch — tryChannelDispatch() guards', () => {
  let origToken, origGuild;
  beforeEach(() => {
    origToken = process.env.DISCORD_TOKEN;
    origGuild = process.env.DISCORD_GUILD_ID;
  });
  afterEach(() => {
    process.env.DISCORD_TOKEN = origToken;
    process.env.DISCORD_GUILD_ID = origGuild;
  });

  it('returns handled=false when transcript does not match', async () => {
    const r = await tryChannelDispatch('what is for dinner');
    expect(r.handled).toBe(false);
  });

  it('returns handled=true with credential error when env vars missing', async () => {
    delete process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_GUILD_ID;
    const r = await tryChannelDispatch('register a channel called demos under engineering');
    expect(r.handled).toBe(true);
    expect(r.result).toMatch(/DISCORD_TOKEN/);
  });
});
