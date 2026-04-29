import { describe, it, expect, beforeEach, vi } from 'vitest';

// intent-classifier imports dotenv — no side-effects needed
vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  isHallucination,
  shouldSleep,
  shouldDismiss,
  isSideTalk,
  isTruncatedFragment,
  hasTaskContent,
  classifyIntent,
} from '../brain/intent-classifier.js';

describe('intent-classifier.js', () => {

  // ── isHallucination ────────────────────────────────────────────────
  describe('isHallucination()', () => {
    it('returns true for known Whisper artifact "thanks for watching"', () => {
      expect(isHallucination('Thanks for watching.')).toBe(true);
    });

    it('returns true for "please subscribe"', () => {
      expect(isHallucination('please subscribe')).toBe(true);
    });

    it('returns true for very short gibberish (under 3 chars)', () => {
      expect(isHallucination('uh')).toBe(true);
    });

    it('returns true for exact hallucination "bye"', () => {
      expect(isHallucination('bye')).toBe(true);
    });

    it('returns true for "subtitles by" prefix', () => {
      expect(isHallucination('subtitles by the team')).toBe(true);
    });

    it('returns true for single word "hmm"', () => {
      expect(isHallucination('hmm')).toBe(true);
    });

    it('passes real 3+ word command "what time is it"', () => {
      expect(isHallucination('what time is it')).toBe(false);
    });

    it('passes real command "check my email"', () => {
      expect(isHallucination('check my email')).toBe(false);
    });

    it('TV noise: short 1-word phrase not in whitelist is filtered', () => {
      // "cool" alone is not a known command in SHORT_COMMAND_WHITELIST
      // but it's only 1 word so it gets filtered as TV noise
      expect(isHallucination('cool')).toBe(true);
    });

    it('passes whitelisted command "stop" (1 word)', () => {
      // "stop" is in SHORT_COMMAND_WHITELIST
      expect(isHallucination('stop')).toBe(false);
    });

    it('passes whitelisted command "tldr on" (2 words)', () => {
      expect(isHallucination('tldr on')).toBe(false);
    });

    it('wake word bypass: short phrase containing jarvis passes', () => {
      // "jarvis" has wake word bypass — not TV noise even if short
      expect(isHallucination('jarvis')).toBe(false);
    });

    it('passes real sentence "remind me about the meeting"', () => {
      expect(isHallucination('remind me about the meeting')).toBe(false);
    });
  });

  // ── shouldSleep ────────────────────────────────────────────────────
  describe('shouldSleep()', () => {
    it('returns true for "go to sleep"', () => {
      expect(shouldSleep('go to sleep')).toBe(true);
    });

    it('returns true for "shut up"', () => {
      expect(shouldSleep('shut up')).toBe(true);
    });

    it('returns true for "mute"', () => {
      expect(shouldSleep('mute')).toBe(true);
    });

    it('returns true for "good night"', () => {
      expect(shouldSleep('good night')).toBe(true);
    });

    it('returns true for "stand down"', () => {
      expect(shouldSleep('stand down')).toBe(true);
    });

    it('returns true for "sleep mode"', () => {
      expect(shouldSleep('sleep mode')).toBe(true);
    });

    it('returns true for "see you later"', () => {
      expect(shouldSleep('see you later')).toBe(true);
    });

    it('returns true for "goodbye"', () => {
      expect(shouldSleep('goodbye')).toBe(true);
    });

    it('compound sign-off: "sounds good jarvis" → true', () => {
      expect(shouldSleep('sounds good jarvis')).toBe(true);
    });

    it('compound sign-off: "thanks jarvis talk to you later" → true', () => {
      expect(shouldSleep('thanks jarvis talk to you later')).toBe(true);
    });

    it('returns false for "what time is it"', () => {
      expect(shouldSleep('what time is it')).toBe(false);
    });

    it('returns false for "check my email please"', () => {
      expect(shouldSleep('check my email please')).toBe(false);
    });

    it('returns false for "sounds good, what about tomorrow"', () => {
      // Over 8 words compound sign-off rule — 5 words, but no closer/name
      expect(shouldSleep('sounds good what about tomorrow then')).toBe(false);
    });

    it('returns true for "talking to myself"', () => {
      expect(shouldSleep('talking to myself')).toBe(true);
    });

    it('returns true for "thank you jarvis"', () => {
      expect(shouldSleep('thank you jarvis')).toBe(true);
    });
  });

  // ── shouldDismiss ──────────────────────────────────────────────────
  describe('shouldDismiss()', () => {
    it('"got it" → dismiss', () => {
      expect(shouldDismiss('got it')).toMatchObject({ dismiss: true });
    });

    it('"ok" → dismiss (stop word)', () => {
      expect(shouldDismiss('ok')).toMatchObject({ dismiss: true });
    });

    it('"cool" → dismiss (stop word)', () => {
      expect(shouldDismiss('cool')).toMatchObject({ dismiss: true });
    });

    it('"okay" → dismiss', () => {
      expect(shouldDismiss('okay')).toMatchObject({ dismiss: true });
    });

    it('"never mind" → dismiss', () => {
      expect(shouldDismiss('never mind')).toMatchObject({ dismiss: true });
    });

    it('"sounds good" short phrase → dismiss (stop prefix, ≤5 words)', () => {
      expect(shouldDismiss('sounds good')).toMatchObject({ dismiss: true, reason: 'stop-prefix' });
    });

    it('"sounds good, let me handle that" (5 words) → dismiss', () => {
      // "sounds good let me handle" = 5 words → starts with stop-prefix "sounds good"
      expect(shouldDismiss("sounds good, let me handle")).toMatchObject({ dismiss: true });
    });

    it('"sounds good but can you also check something" (8 words) → NOT dismissed', () => {
      // >5 words → stop-prefix gate does NOT fire
      expect(shouldDismiss('sounds good but can you also check something')).toMatchObject({ dismiss: false });
    });

    it('self-talk → dismiss regardless of length', () => {
      expect(shouldDismiss("I'm talking to myself")).toMatchObject({ dismiss: true, reason: 'self-talk' });
    });

    it('"I was just talking to myself, sorry" → dismiss', () => {
      expect(shouldDismiss('I was just talking to myself, sorry')).toMatchObject({ dismiss: true });
    });

    it('"check my email" → NOT dismissed', () => {
      expect(shouldDismiss('check my email')).toMatchObject({ dismiss: false });
    });

    it('"what time is it" → NOT dismissed', () => {
      expect(shouldDismiss('what time is it')).toMatchObject({ dismiss: false });
    });

    it('"obviously" → dismiss (exact stop word)', () => {
      expect(shouldDismiss('obviously')).toMatchObject({ dismiss: true });
    });
  });

  // ── isSideTalk ─────────────────────────────────────────────────────
  describe('isSideTalk()', () => {
    it('returns true when no wake word and phrase is pure filler "yeah"', () => {
      expect(isSideTalk('yeah', false, false)).toBe(true);
    });

    it('returns false when wake word was used', () => {
      expect(isSideTalk('yeah', true, false)).toBe(false);
    });

    it('short fragment with no task verb and no wake word → side talk', () => {
      // "this is nice today" — 4 words, no task verb → coherence gate fires
      expect(isSideTalk('this is nice today', false, false)).toBe(true);
    });

    it('short fragment with task verb → NOT side talk', () => {
      expect(isSideTalk('check the calendar', false, false)).toBe(false);
    });

    it('long phrase (≥60 chars) bypasses side-talk', () => {
      const long = 'actually let me think about what we should do with the project management system';
      expect(isSideTalk(long, false, false)).toBe(false);
    });

    it('in conversation window — pure filler "right" → still side talk', () => {
      expect(isSideTalk('right', false, true)).toBe(true);
    });

    it('in conversation window — short non-filler with task verb → NOT side talk', () => {
      // "what about Tuesday" has a question mark + is contextual
      expect(isSideTalk('what about Tuesday', false, true)).toBe(false);
    });

    it('"hmm" with no wake word → side talk', () => {
      expect(isSideTalk('hmm', false, false)).toBe(true);
    });
  });

  // ── isTruncatedFragment ────────────────────────────────────────────
  describe('isTruncatedFragment()', () => {
    it('ellipsis ending → truncated', () => {
      expect(isTruncatedFragment('so the thing is...')).toBe(true);
    });

    it('unicode ellipsis → truncated', () => {
      expect(isTruncatedFragment('what about the…')).toBe(true);
    });

    it('short phrase ending with dangling preposition "of" → truncated', () => {
      expect(isTruncatedFragment('because of')).toBe(true);
    });

    it('short phrase ending with "and" → truncated', () => {
      expect(isTruncatedFragment('we need to check the config and')).toBe(true);
    });

    it('complete sentence passes', () => {
      expect(isTruncatedFragment('what time is it')).toBe(false);
    });

    it('complete question passes', () => {
      expect(isTruncatedFragment('check my email please')).toBe(false);
    });

    it('long sentence with >12 words and dangling word → NOT flagged (word limit)', () => {
      const long = 'we need to discuss the deployment pipeline and the new configuration changes and the';
      // > 12 words → word limit gate skips it
      expect(isTruncatedFragment(long)).toBe(false);
    });
  });

  // ── hasTaskContent ────────────────────────────────────────────────
  describe('hasTaskContent()', () => {
    it('"check my email" → has task content', () => {
      expect(hasTaskContent('check my email')).toBe(true);
    });

    it('"send a message" → has task content', () => {
      expect(hasTaskContent('send a message')).toBe(true);
    });

    it('"search for something" → has task content', () => {
      expect(hasTaskContent('search for something')).toBe(true);
    });

    it('"summarize the report" → has task content', () => {
      expect(hasTaskContent('summarize the report')).toBe(true);
    });

    it('"sounds good" alone → no task content', () => {
      expect(hasTaskContent('sounds good')).toBe(false);
    });

    it('"ok thanks" → no task content', () => {
      expect(hasTaskContent('ok thanks')).toBe(false);
    });

    it('"sounds good, check my calendar" → has task content', () => {
      expect(hasTaskContent('sounds good, check my calendar')).toBe(true);
    });

    it('"find the latest PR" → has task content', () => {
      expect(hasTaskContent('find the latest PR')).toBe(true);
    });
  });

  // ── classifyIntent ────────────────────────────────────────────────
  describe('classifyIntent()', () => {
    function mkSignals(transcript, overrides = {}) {
      return { transcript, speechDurationMs: 3000, conversationDepth: 0, isFollowUp: false, previousResponseType: null, ...overrides };
    }

    it('greeting → CHAT', () => {
      const result = classifyIntent(mkSignals('Hello there'));
      expect(result.type).toBe('CHAT');
    });

    it('"thanks" → CHAT', () => {
      const result = classifyIntent(mkSignals('thanks'));
      expect(result.type).toBe('CHAT');
    });

    it('"what time is it" → QUERY', () => {
      const result = classifyIntent(mkSignals('what time is it'));
      expect(result.type).toBe('QUERY');
    });

    it('"what is on my calendar today" → CALENDAR', () => {
      const result = classifyIntent(mkSignals('what is on my calendar today'));
      expect(result.type).toBe('CALENDAR');
    });

    it('"am I free at 3pm" → CALENDAR', () => {
      const result = classifyIntent(mkSignals('am I free at 3pm'));
      expect(result.type).toBe('CALENDAR');
    });

    it('"check my emails" → EMAIL_QUERY or SUMMARIZE', () => {
      const result = classifyIntent(mkSignals('check my emails'));
      // "check my emails" matches QUERY path (contains "check")
      expect(['QUERY', 'EMAIL_QUERY', 'SUMMARIZE']).toContain(result.type);
    });

    it('"summarize my inbox" → SUMMARIZE', () => {
      const result = classifyIntent(mkSignals('summarize my inbox'));
      expect(result.type).toBe('SUMMARIZE');
    });

    it('"any new emails" → SUMMARIZE', () => {
      const result = classifyIntent(mkSignals('any new emails'));
      expect(result.type).toBe('SUMMARIZE');
    });

    it('"remember this" → MEMORY_CMD', () => {
      const result = classifyIntent(mkSignals('remember this'));
      expect(result.type).toBe('MEMORY_CMD');
    });

    it('"recall what I said about the project" → MEMORY_CMD', () => {
      const result = classifyIntent(mkSignals('recall what I said about the project'));
      expect(result.type).toBe('MEMORY_CMD');
    });

    it('"create a todo list" → PLAN_CMD', () => {
      const result = classifyIntent(mkSignals('create a todo list'));
      expect(result.type).toBe('PLAN_CMD');
    });

    it('"use opus" → ADMIN_CMD', () => {
      const result = classifyIntent(mkSignals('use opus'));
      expect(result.type).toBe('ADMIN_CMD');
    });

    it('"switch to haiku" → ADMIN_CMD', () => {
      const result = classifyIntent(mkSignals('switch to haiku'));
      expect(result.type).toBe('ADMIN_CMD');
    });

    it('"explain how Kubernetes works" → DEEP_DIVE', () => {
      const result = classifyIntent(mkSignals('explain how Kubernetes works'));
      expect(result.type).toBe('DEEP_DIVE');
    });

    it('"send an email to John" → EMAIL_ACTION', () => {
      const result = classifyIntent(mkSignals('send an email to John about the project'));
      // "send an email" matches EMAIL_ACTION
      expect(result.type).toBe('EMAIL_ACTION');
    });

    it('"deploy the service" → ACTION', () => {
      const result = classifyIntent(mkSignals('deploy the service now'));
      expect(result.type).toBe('ACTION');
    });

    it('FOLLOW_UP on prior QUERY → FOLLOW_UP', () => {
      const result = classifyIntent(mkSignals('yes', { isFollowUp: true, previousResponseType: 'QUERY' }));
      expect(result.type).toBe('FOLLOW_UP');
    });

    it('result includes budget fields', () => {
      const result = classifyIntent(mkSignals('what time is the meeting'));
      expect(result).toHaveProperty('maxSentences');
      expect(result).toHaveProperty('maxSpokenSeconds');
      expect(result).toHaveProperty('responseStyle');
      expect(result).toHaveProperty('budgetInstruction');
    });

    it('short speech (<3s) → QUERY with ≤3 sentences', () => {
      const result = classifyIntent(mkSignals('tell me something', { speechDurationMs: 1000 }));
      expect(result.type).toBe('QUERY');
      expect(result.maxSentences).toBeLessThanOrEqual(3);
    });
  });
});
