import { describe, it, expect } from 'vitest';
import { isVerifiedOwner } from '../auth.js';

describe('isVerifiedOwner() — speaker authentication helper', () => {
  describe('high-tier required (strictest)', () => {
    it('high tier + is_owner=true → returns true', () => {
      const spkr = { is_owner: true, confidence_tier: 'high', confidence: 0.92 };
      expect(isVerifiedOwner(spkr, 'high')).toBe(true);
    });

    it('medium tier + is_owner=true → returns false (insufficient tier)', () => {
      const spkr = { is_owner: true, confidence_tier: 'medium', confidence: 0.72 };
      expect(isVerifiedOwner(spkr, 'high')).toBe(false);
    });

    it('low tier + is_owner=true → returns false (insufficient tier)', () => {
      const spkr = { is_owner: true, confidence_tier: 'low', confidence: 0.40 };
      expect(isVerifiedOwner(spkr, 'high')).toBe(false);
    });
  });

  describe('medium-tier required', () => {
    it('medium tier + is_owner=true → returns true', () => {
      const spkr = { is_owner: true, confidence_tier: 'medium', confidence: 0.72 };
      expect(isVerifiedOwner(spkr, 'medium')).toBe(true);
    });

    it('high tier + is_owner=true → returns true (exceeds requirement)', () => {
      const spkr = { is_owner: true, confidence_tier: 'high', confidence: 0.93 };
      expect(isVerifiedOwner(spkr, 'medium')).toBe(true);
    });

    it('low tier + is_owner=true → returns false', () => {
      const spkr = { is_owner: true, confidence_tier: 'low', confidence: 0.38 };
      expect(isVerifiedOwner(spkr, 'medium')).toBe(false);
    });
  });

  describe('low-tier required (least strict)', () => {
    it('low tier + is_owner=true → returns true', () => {
      const spkr = { is_owner: true, confidence_tier: 'low', confidence: 0.40 };
      expect(isVerifiedOwner(spkr, 'low')).toBe(true);
    });

    it('medium tier + is_owner=true → returns true', () => {
      const spkr = { is_owner: true, confidence_tier: 'medium', confidence: 0.70 };
      expect(isVerifiedOwner(spkr, 'low')).toBe(true);
    });
  });

  describe('null/falsy speaker', () => {
    it('null spkr → returns false', () => {
      expect(isVerifiedOwner(null, 'high')).toBe(false);
    });

    it('undefined spkr → returns false', () => {
      expect(isVerifiedOwner(undefined, 'high')).toBe(false);
    });

    it('empty object → returns false (no is_owner)', () => {
      expect(isVerifiedOwner({}, 'high')).toBe(false);
    });
  });

  describe('is_owner=false cases', () => {
    it('high tier + is_owner=false → always false', () => {
      const spkr = { is_owner: false, confidence_tier: 'high', confidence: 0.95 };
      expect(isVerifiedOwner(spkr, 'high')).toBe(false);
    });

    it('medium tier + is_owner=false → always false', () => {
      const spkr = { is_owner: false, confidence_tier: 'medium', confidence: 0.75 };
      expect(isVerifiedOwner(spkr, 'medium')).toBe(false);
    });

    it('low tier + is_owner=false → always false', () => {
      const spkr = { is_owner: false, confidence_tier: 'low', confidence: 0.50 };
      expect(isVerifiedOwner(spkr, 'low')).toBe(false);
    });
  });

  describe('default tier (no requiredTier arg)', () => {
    it('defaults to "high" tier requirement', () => {
      const highSpkr = { is_owner: true, confidence_tier: 'high', confidence: 0.91 };
      const medSpkr = { is_owner: true, confidence_tier: 'medium', confidence: 0.71 };
      expect(isVerifiedOwner(highSpkr)).toBe(true);
      expect(isVerifiedOwner(medSpkr)).toBe(false);
    });
  });

  describe('unknown confidence_tier', () => {
    it('unknown tier + is_owner=true → returns false for high requirement', () => {
      const spkr = { is_owner: true, confidence_tier: 'unknown', confidence: 0.80 };
      expect(isVerifiedOwner(spkr, 'high')).toBe(false);
    });

    it('unknown tier + is_owner=true → returns false for medium requirement', () => {
      const spkr = { is_owner: true, confidence_tier: 'foobar', confidence: 0.80 };
      expect(isVerifiedOwner(spkr, 'medium')).toBe(false);
    });
  });
});
