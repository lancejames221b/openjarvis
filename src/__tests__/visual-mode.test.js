import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs so we don't touch real .env
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { readFileSync, writeFileSync } from 'fs';
import {
  isVisualModeToggle,
  isVisualModeEnabled,
  setVisualMode,
  getVisualTargetChannel,
  setVisualTargetChannel,
} from '../visual-mode.js';

describe('visual-mode.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── isVisualModeToggle ──────────────────────────────────────────────
  describe('isVisualModeToggle()', () => {
    describe('ON patterns', () => {
      it('"visual mode on" → true', () => {
        expect(isVisualModeToggle('visual mode on')).toBe(true);
      });

      it('"turn on visual mode" → true', () => {
        expect(isVisualModeToggle('turn on visual mode')).toBe(true);
      });

      it('"screen mode" → true', () => {
        expect(isVisualModeToggle('screen mode')).toBe(true);
      });

      it('"screen mode on" → true', () => {
        expect(isVisualModeToggle('screen mode on')).toBe(true);
      });

      it('"text only" → true', () => {
        expect(isVisualModeToggle('text only')).toBe(true);
      });

      it('"text only mode" → true', () => {
        expect(isVisualModeToggle('text only mode')).toBe(true);
      });

      it('"expanse mode" → true', () => {
        expect(isVisualModeToggle('expanse mode')).toBe(true);
      });

      it('"display mode" → true', () => {
        expect(isVisualModeToggle('display mode')).toBe(true);
      });

      it('"go visual" → true', () => {
        expect(isVisualModeToggle('go visual')).toBe(true);
      });

      it('"text mode" → true', () => {
        expect(isVisualModeToggle('text mode')).toBe(true);
      });
    });

    describe('OFF patterns', () => {
      it('"visual mode off" → false (OFF checked before ON)', () => {
        // "visual mode" alone would match ON, but "visual mode off" must return false
        expect(isVisualModeToggle('visual mode off')).toBe(false);
      });

      it('"turn off visual mode" → false', () => {
        expect(isVisualModeToggle('turn off visual mode')).toBe(false);
      });

      it('"screen mode off" → false', () => {
        expect(isVisualModeToggle('screen mode off')).toBe(false);
      });

      it('"voice mode" → false', () => {
        expect(isVisualModeToggle('voice mode')).toBe(false);
      });

      it('"voice mode on" → false', () => {
        expect(isVisualModeToggle('voice mode on')).toBe(false);
      });

      it('"talk to me" → false', () => {
        expect(isVisualModeToggle('talk to me')).toBe(false);
      });

      it('"speak to me" → false', () => {
        expect(isVisualModeToggle('speak to me')).toBe(false);
      });

      it('"audio mode" → false', () => {
        expect(isVisualModeToggle('audio mode')).toBe(false);
      });
    });

    describe('non-toggle phrases → null', () => {
      it('"check my email" → null', () => {
        expect(isVisualModeToggle('check my email')).toBeNull();
      });

      it('"what time is it" → null', () => {
        expect(isVisualModeToggle('what time is it')).toBeNull();
      });

      it('empty string → null', () => {
        expect(isVisualModeToggle('')).toBeNull();
      });
    });

    it('OFF checked before ON: "visual mode off" returns false (not true)', () => {
      // The pattern "/\bvisual\s+mode\b/i" (ON) would match "visual mode off"
      // But OFF patterns are checked FIRST, so it must return false.
      const result = isVisualModeToggle('visual mode off');
      expect(result).toBe(false);
      expect(result).not.toBe(true);
    });
  });

  // ── isVisualModeEnabled ─────────────────────────────────────────────
  describe('isVisualModeEnabled()', () => {
    it('returns true when .env has VOICE_VISUAL_MODE=true', () => {
      readFileSync.mockReturnValue('VOICE_VISUAL_MODE=true\nOTHER=value\n');
      expect(isVisualModeEnabled()).toBe(true);
    });

    it('returns false when .env has VOICE_VISUAL_MODE=false', () => {
      readFileSync.mockReturnValue('VOICE_VISUAL_MODE=false\n');
      expect(isVisualModeEnabled()).toBe(false);
    });

    it('returns false when .env has no VOICE_VISUAL_MODE', () => {
      readFileSync.mockReturnValue('OTHER=value\n');
      expect(isVisualModeEnabled()).toBe(false);
    });

    it('returns false when .env read throws (file not found)', () => {
      readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect(isVisualModeEnabled()).toBe(false);
    });
  });

  // ── setVisualMode ───────────────────────────────────────────────────
  describe('setVisualMode()', () => {
    it('updates existing VOICE_VISUAL_MODE=false → true', () => {
      readFileSync.mockReturnValue('VOICE_VISUAL_MODE=false\n');
      writeFileSync.mockReturnValue(undefined);

      const result = setVisualMode(true);

      expect(result).toBe(true);
      expect(writeFileSync).toHaveBeenCalledOnce();
      const written = writeFileSync.mock.calls[0][1];
      expect(written).toContain('VOICE_VISUAL_MODE=true');
    });

    it('appends VOICE_VISUAL_MODE when not present in .env', () => {
      readFileSync.mockReturnValue('OTHER=value\n');
      writeFileSync.mockReturnValue(undefined);

      const result = setVisualMode(false);

      expect(result).toBe(true);
      const written = writeFileSync.mock.calls[0][1];
      expect(written).toContain('VOICE_VISUAL_MODE=false');
    });

    it('returns false when writeFileSync throws', () => {
      readFileSync.mockReturnValue('VOICE_VISUAL_MODE=true\n');
      writeFileSync.mockImplementation(() => { throw new Error('EACCES'); });

      const result = setVisualMode(false);
      expect(result).toBe(false);
    });
  });

  // ── getVisualTargetChannel ──────────────────────────────────────────
  describe('getVisualTargetChannel()', () => {
    it('returns channel ID from .env', () => {
      readFileSync.mockReturnValue('VOICE_VISUAL_CHANNEL=123456789\n');
      expect(getVisualTargetChannel()).toBe('123456789');
    });

    it('returns null when VOICE_VISUAL_CHANNEL is empty', () => {
      readFileSync.mockReturnValue('VOICE_VISUAL_CHANNEL=\n');
      expect(getVisualTargetChannel()).toBeNull();
    });

    it('returns null when VOICE_VISUAL_CHANNEL is missing', () => {
      readFileSync.mockReturnValue('OTHER=value\n');
      expect(getVisualTargetChannel()).toBeNull();
    });

    it('returns null when .env read throws', () => {
      readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect(getVisualTargetChannel()).toBeNull();
    });
  });

  // ── setVisualTargetChannel ──────────────────────────────────────────
  describe('setVisualTargetChannel()', () => {
    it('updates existing VOICE_VISUAL_CHANNEL entry', () => {
      readFileSync.mockReturnValue('VOICE_VISUAL_CHANNEL=old123\n');
      writeFileSync.mockReturnValue(undefined);

      const result = setVisualTargetChannel('new456');

      expect(result).toBe(true);
      const written = writeFileSync.mock.calls[0][1];
      expect(written).toContain('VOICE_VISUAL_CHANNEL=new456');
    });

    it('appends VOICE_VISUAL_CHANNEL when not present', () => {
      readFileSync.mockReturnValue('OTHER=value\n');
      writeFileSync.mockReturnValue(undefined);

      setVisualTargetChannel('chan789');

      const written = writeFileSync.mock.calls[0][1];
      expect(written).toContain('VOICE_VISUAL_CHANNEL=chan789');
    });

    it('clears channel when called with null', () => {
      readFileSync.mockReturnValue('VOICE_VISUAL_CHANNEL=123\n');
      writeFileSync.mockReturnValue(undefined);

      setVisualTargetChannel(null);

      const written = writeFileSync.mock.calls[0][1];
      expect(written).toContain('VOICE_VISUAL_CHANNEL=');
    });

    it('returns false on write error', () => {
      readFileSync.mockReturnValue('VOICE_VISUAL_CHANNEL=abc\n');
      writeFileSync.mockImplementation(() => { throw new Error('EACCES'); });

      expect(setVisualTargetChannel('new')).toBe(false);
    });
  });
});
