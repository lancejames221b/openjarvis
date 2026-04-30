import { describe, it, expect } from 'vitest';

// isWakeUpCommand lives in fsm.js (re-exported from wakeword detection logic)
// We import directly from fsm.js which exports isWakeUpCommand
import { isWakeUpCommand } from '../state/fsm.js';
import { VOICE_WAKE_WORD } from '../voice/wakeword.js';

// Tests use the configured wake word (VOICE_WAKE_WORD env) — not hardcoded "jarvis".
// Run with VOICE_WAKE_WORD=sonia (current default) or VOICE_WAKE_WORD=jarvis (Jarvis mode).
// "Jarvis" only wakes the bot when VOICE_WAKE_WORD=jarvis (/jvoice Jarvis mode).
const ww = VOICE_WAKE_WORD; // e.g. "sonia" or "jarvis"
const WW = ww.charAt(0).toUpperCase() + ww.slice(1); // "Sonia" / "Jarvis"

describe('Wake word detection — isWakeUpCommand()', () => {
  describe('positive detection', () => {
    it(`"Hey ${WW}" is detected`, () => {
      expect(isWakeUpCommand(`Hey ${WW}`)).toBe(true);
    });

    it(`"hey ${ww}" (lowercase) is detected`, () => {
      expect(isWakeUpCommand(`hey ${ww}`)).toBe(true);
    });

    it(`"${WW}" alone is detected`, () => {
      expect(isWakeUpCommand(WW)).toBe(true);
    });

    it(`"${ww}" (lowercase) alone is detected`, () => {
      expect(isWakeUpCommand(ww)).toBe(true);
    });

    it(`"Hey ${WW}, what time is it" is detected`, () => {
      expect(isWakeUpCommand(`Hey ${WW}, what time is it`)).toBe(true);
    });

    it(`"${WW} wake up" is detected`, () => {
      expect(isWakeUpCommand(`${WW} wake up`)).toBe(true);
    });

    it(`"hello ${ww}" is detected`, () => {
      expect(isWakeUpCommand(`hello ${ww}`)).toBe(true);
    });

    it(`"good morning ${ww}" is detected`, () => {
      expect(isWakeUpCommand(`good morning ${ww}`)).toBe(true);
    });

    it(`"hi ${ww}" is detected`, () => {
      expect(isWakeUpCommand(`hi ${ww}`)).toBe(true);
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

    // "Jarvis" is always a valid wake word regardless of VOICE_WAKE_WORD config
    // It is the permanent core identity — always reachable in any mode
    it('"Jarvis" always wakes the bot (universal fallback)', () => {
      expect(isWakeUpCommand('Jarvis')).toBe(true);
    });

    it('"Hey Jarvis" always wakes the bot (universal fallback)', () => {
      expect(isWakeUpCommand('Hey Jarvis')).toBe(true);
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
      expect(isWakeUpCommand(`${WW}!`)).toBe(true);
      expect(isWakeUpCommand(`Hey ${WW}.`)).toBe(true);
    });

    it(`"${WW}" embedded mid-sentence is NOT a pattern match start`, () => {
      // wake word pattern requires it to be at start
      expect(isWakeUpCommand(`I think ${WW} is cool`)).toBe(false);
    });
  });
});
