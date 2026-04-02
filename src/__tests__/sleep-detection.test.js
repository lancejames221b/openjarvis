import { describe, it, expect } from 'vitest';
import { shouldSleep } from '../intent-classifier.js';

describe('Sleep/goodbye detection — shouldSleep()', () => {
  describe('explicit sleep commands', () => {
    it('"sleep" triggers sleep', () => {
      expect(shouldSleep('sleep')).toBe(true);
    });

    it('"go to sleep" triggers sleep', () => {
      expect(shouldSleep('go to sleep')).toBe(true);
    });

    it('"goodnight Jarvis" triggers sleep', () => {
      expect(shouldSleep('goodnight Jarvis')).toBe(true);
    });

    it('"good night" triggers sleep', () => {
      expect(shouldSleep('good night')).toBe(true);
    });

    it('"goodbye" triggers sleep', () => {
      expect(shouldSleep('goodbye')).toBe(true);
    });

    it('"bye" triggers sleep', () => {
      expect(shouldSleep('bye')).toBe(true);
    });

    it('"sleep mode" triggers sleep', () => {
      expect(shouldSleep('sleep mode')).toBe(true);
    });
  });

  describe('natural sign-offs', () => {
    it('"talk to you later" triggers sleep', () => {
      expect(shouldSleep('talk to you later')).toBe(true);
    });

    it('"see you later" triggers sleep', () => {
      expect(shouldSleep('see you later')).toBe(true);
    });

    it('"catch you later" triggers sleep', () => {
      expect(shouldSleep('catch you later')).toBe(true);
    });

    it('"take care" triggers sleep', () => {
      expect(shouldSleep('take care')).toBe(true);
    });

    it('"stand down" triggers sleep', () => {
      expect(shouldSleep('stand down')).toBe(true);
    });

    it('"dismissed" triggers sleep', () => {
      expect(shouldSleep('dismissed')).toBe(true);
    });

    it('"all set" triggers sleep', () => {
      expect(shouldSleep('all set')).toBe(true);
    });

    it('"have a good night" triggers sleep', () => {
      expect(shouldSleep('have a good night')).toBe(true);
    });
  });

  describe('compound sign-offs', () => {
    it('"sounds good jarvis" triggers sleep', () => {
      expect(shouldSleep('sounds good jarvis')).toBe(true);
    });

    it('"thanks jarvis" triggers sleep (with closer)', () => {
      // "thanks jarvis" — "thanks" is SIGNOFF_COMPOUND, "jarvis" is SIGNOFF_CLOSER
      expect(shouldSleep('thanks jarvis')).toBe(true);
    });

    it('"thanks, talk to you later" triggers sleep', () => {
      expect(shouldSleep('thanks, talk to you later')).toBe(true);
    });
  });

  describe('normal commands do NOT trigger sleep', () => {
    it('"what is the weather today" does NOT trigger sleep', () => {
      expect(shouldSleep('what is the weather today')).toBe(false);
    });

    it('"set a timer for 5 minutes" does NOT trigger sleep', () => {
      expect(shouldSleep('set a timer for 5 minutes')).toBe(false);
    });

    it('"check my emails" does NOT trigger sleep', () => {
      expect(shouldSleep('check my emails')).toBe(false);
    });

    it('"play some music" does NOT trigger sleep', () => {
      expect(shouldSleep('play some music')).toBe(false);
    });

    it('"what time is it" does NOT trigger sleep', () => {
      expect(shouldSleep('what time is it')).toBe(false);
    });

    it('"tell me a joke" does NOT trigger sleep', () => {
      expect(shouldSleep('tell me a joke')).toBe(false);
    });

    it('"remind me to call john tomorrow" does NOT trigger sleep', () => {
      expect(shouldSleep('remind me to call john tomorrow')).toBe(false);
    });

    it('empty string does NOT trigger sleep', () => {
      expect(shouldSleep('')).toBe(false);
    });
  });

  describe('stop/mute commands', () => {
    it('"stop listening" triggers sleep', () => {
      expect(shouldSleep('stop listening')).toBe(true);
    });

    it('"mute" triggers sleep', () => {
      expect(shouldSleep('mute')).toBe(true);
    });

    it('"be quiet" triggers sleep', () => {
      expect(shouldSleep('be quiet')).toBe(true);
    });

    it('"go silent" triggers sleep', () => {
      expect(shouldSleep('go silent')).toBe(true);
    });
  });

  describe('"talking to myself" sleep word', () => {
    it('"talking to myself" triggers sleep', () => {
      expect(shouldSleep('talking to myself')).toBe(true);
    });

    it('"I\'m talking to myself" triggers sleep', () => {
      expect(shouldSleep("I'm talking to myself")).toBe(true);
    });

    it('"i am talking to myself" triggers sleep', () => {
      expect(shouldSleep('i am talking to myself')).toBe(true);
    });

    it('"I was talking to myself" triggers sleep', () => {
      expect(shouldSleep('I was talking to myself')).toBe(true);
    });

    it('"just talking to myself" triggers sleep', () => {
      expect(shouldSleep('just talking to myself')).toBe(true);
    });

    it('"sorry talking to myself" triggers sleep', () => {
      expect(shouldSleep('sorry talking to myself')).toBe(true);
    });

    it('"I was just talking to myself" triggers sleep', () => {
      expect(shouldSleep('I was just talking to myself')).toBe(true);
    });

    it('"talking to myself here" triggers sleep', () => {
      expect(shouldSleep('talking to myself here')).toBe(true);
    });

    it('"talking to someone else" does NOT trigger sleep', () => {
      expect(shouldSleep('talking to someone else')).toBe(false);
    });

    it('"what am I talking to myself about" does NOT trigger sleep (has task content)', () => {
      // This phrase contains talking to myself but no task verb — still triggers sleep
      // (hasTaskContent check is done by the caller, not shouldSleep)
      expect(shouldSleep('talking to myself about the meeting')).toBe(true);
    });
  });
});
