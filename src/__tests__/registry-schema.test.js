import { describe, it, expect } from 'vitest';
import { normalizeEntry, validateEntry } from '../registry-schema.js';

describe('normalizeEntry', () => {
  it('applies defaults to an empty entry', () => {
    const result = normalizeEntry({});
    expect(result.worktreeMode).toBe('none');
    expect(result.baseRef).toBe('main');
    expect(result.worktreeRoot).toBe('~/dev/openjarvis-worktrees');
    expect(result.projectPath).toBeUndefined();
  });

  it('preserves explicitly set worktreeMode', () => {
    expect(normalizeEntry({ worktreeMode: 'per-thread' }).worktreeMode).toBe('per-thread');
    expect(normalizeEntry({ worktreeMode: 'per-channel' }).worktreeMode).toBe('per-channel');
  });

  it('preserves explicit baseRef', () => {
    expect(normalizeEntry({ baseRef: 'master' }).baseRef).toBe('master');
  });

  it('preserves explicit worktreeRoot', () => {
    expect(normalizeEntry({ worktreeRoot: '/home/user/wt' }).worktreeRoot).toBe('/home/user/wt');
  });

  it('preserves explicit projectPath', () => {
    expect(normalizeEntry({ projectPath: '/home/user/Dev/ewitness' }).projectPath).toBe('/home/user/Dev/ewitness');
  });

  it('normalizes null worktreeMode to none', () => {
    expect(normalizeEntry({ worktreeMode: null }).worktreeMode).toBe('none');
  });

  it('passes through all other fields unchanged', () => {
    const entry = { name: 'ewitness-dev', model: 'claude-sonnet-4-6', directory: '/home/user/Dev', currentFocus: 'testing' };
    const result = normalizeEntry(entry);
    expect(result.name).toBe('ewitness-dev');
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.directory).toBe('/home/user/Dev');
    expect(result.currentFocus).toBe('testing');
  });
});

describe('validateEntry', () => {
  it('returns true for a minimal valid entry (no worktree config)', () => {
    expect(validateEntry({})).toBe(true);
  });

  it('returns true for worktreeMode none', () => {
    expect(validateEntry({ worktreeMode: 'none' })).toBe(true);
  });

  it('returns true for per-thread with projectPath', () => {
    expect(validateEntry({ worktreeMode: 'per-thread', projectPath: '/tmp/proj' })).toBe(true);
  });

  it('returns true for per-channel with projectPath', () => {
    expect(validateEntry({ worktreeMode: 'per-channel', projectPath: '/tmp/proj' })).toBe(true);
  });

  it('returns false for an unrecognized worktreeMode', () => {
    expect(validateEntry({ worktreeMode: 'magic' })).toBe(false);
  });

  it('returns false for per-thread without projectPath', () => {
    expect(validateEntry({ worktreeMode: 'per-thread' })).toBe(false);
  });

  it('returns false for per-channel without projectPath', () => {
    expect(validateEntry({ worktreeMode: 'per-channel' })).toBe(false);
  });
});
