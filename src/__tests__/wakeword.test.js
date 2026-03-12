import { describe, it, expect, beforeEach } from 'vitest';

// isWakeUpCommand lives in fsm.js (re-exported from wakeword detection logic)
// We import directly from fsm.js which exports isWakeUpCommand
import { isWakeUpCommand } from '../fsm.js';

describe('Wake word detection — isWakeUpCommand()', () => {
  describe('positive detection', () => {
    it('"Hey Jarvis" is detected', () => {
      expect(isWakeUpCommand('Hey Jarvis')).toBe(true);
    });

    it('"hey jarvis" (lowercase) is detected', () => {
      expect(isWakeUpCommand('hey jarvis')).toBe(true);
    });

    it('"Jarvis" alone is detected', () => {
      expect(isWakeUpCommand('Jarvis')).toBe(true);
    });

    it('"jarvis" (lowercase) alone is detected', () => {
      expect(isWakeUpCommand('jarvis')).toBe(true);
    });

    it('"Hey Jarvis, what time is it" is detected', () => {
      expect(isWakeUpCommand('Hey Jarvis, what time is it')).toBe(true);
    });

    it('"Jarvis wake up" is detected', () => {
      expect(isWakeUpCommand('Jarvis wake up')).toBe(true);
    });

    it('"hello jarvis" is detected', () => {
      expect(isWakeUpCommand('hello jarvis')).toBe(true);
    });

    it('"good morning jarvis" is detected', () => {
      expect(isWakeUpCommand('good morning jarvis')).toBe(true);
    });

    it('"hi jarvis" is detected', () => {
      expect(isWakeUpCommand('hi jarvis')).toBe(true);
    });
  });

  describe('negative detection — common sentence starters', () => {
    it('"just" alone is NOT a wake word', () => {
      expect(isWakeUpCommand('just kidding')).toBe(false);
    });

    it('"just kidding" is NOT a wake word', () => {
      expect(isWakeUpCommand('just kidding')).toBe(false);
    });

    it('"and another thing" is NOT a wake word', () => {
      expect(isWakeUpCommand('and another thing')).toBe(false);
    });

    it('"so what do you think" is NOT a wake word', () => {
      expect(isWakeUpCommand('so what do you think')).toBe(false);
    });

    it('"ok let me check" is NOT a wake word', () => {
      expect(isWakeUpCommand('ok let me check')).toBe(false);
    });

    it('"well actually" is NOT a wake word', () => {
      expect(isWakeUpCommand('well actually this is different')).toBe(false);
    });

    it('empty string returns false', () => {
      expect(isWakeUpCommand('')).toBe(false);
    });

    it('whitespace-only string returns false', () => {
      expect(isWakeUpCommand('   ')).toBe(false);
    });
  });

  describe('fuzzy wake word detection (speaker verified)', () => {
    // Fuzzy detection is only active when WAKE_WORD_FUZZY=true env var is set
    // In test env it defaults to false, so we test the non-fuzzy path
    it('"Gervis" without speaker verified and FUZZY off is NOT detected', () => {
      // WAKE_WORD_FUZZY defaults to false in test environment
      expect(isWakeUpCommand('Gervis, what time is it', false)).toBe(false);
    });

    it('"Hey Gervis" without FUZZY is not detected', () => {
      expect(isWakeUpCommand('Hey Gervis', false)).toBe(false);
    });
  });

  describe('COMMON_SENTENCE_STARTERS are not fuzzy wake words', () => {
    // These are the words in the COMMON list in fsm.js
    const commonStarters = [
      'so but this is important',
      'and then we need to',
      'the other thing is',
      'ok what about that',
      'yes tell me more',
      'no that is wrong',
      'hey wait a moment',
      'well just checking',
      'now what should we',
      'just one more thing',
      'oh interesting idea',
    ];

    for (const phrase of commonStarters) {
      it(`"${phrase}" is NOT a wake word`, () => {
        expect(isWakeUpCommand(phrase, false)).toBe(false);
      });
    }
  });

  describe('edge cases', () => {
    it('trailing punctuation is stripped before matching', () => {
      expect(isWakeUpCommand('Jarvis!')).toBe(true);
      expect(isWakeUpCommand('Hey Jarvis.')).toBe(true);
    });

    it('"Jarvis" embedded mid-sentence is NOT a pattern match start', () => {
      // "hey jarvis" pattern requires it to be at start
      expect(isWakeUpCommand('I think Jarvis is cool')).toBe(false);
    });
  });
});
