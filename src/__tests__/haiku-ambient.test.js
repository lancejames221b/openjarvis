/**
 * haiku-ambient.test.js — Tests for the Haiku Ambient Intent Classifier
 *
 * The Haiku API call is mocked — we test:
 * 1. Correct routing based on mock responses
 * 2. Fail-open behavior (timeouts, errors, bad responses)
 * 3. Phase gating (phase 1 vs 2 vs 3)
 * 4. Edge cases (empty transcript, wake word present, no token)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Environment setup (must run before module import) ─────────────────────────
// Set vars before importing the module so its top-level const reads fire correctly
const ENV_DEFAULTS = {
  HAIKU_AMBIENT_CLASSIFIER_ENABLED: 'true',
  HAIKU_AMBIENT_LOG_DECISIONS: 'false', // silence Discord logging in tests
  HAIKU_AMBIENT_TIMEOUT_MS: '2000',
  HAIKU_AMBIENT_PHASE: '3', // full phase by default — individual tests override
  JARVIS_GATEWAY_URL: 'http://localhost:22100',
  JARVIS_GATEWAY_TOKEN: 'test-token',
};

// Apply env before module load
Object.assign(process.env, ENV_DEFAULTS);

// ── Mock fetch ────────────────────────────────────────────────────────────────

/**
 * Build a mock fetch that returns a Haiku completions response.
 */
function mockFetch(result, reason = 'test reason') {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({ result, reason }),
        },
      }],
    }),
    text: async () => 'ok',
  });
}

function mockFetchError(message = 'Network error') {
  return vi.fn().mockRejectedValue(new Error(message));
}

function mockFetchBadStatus(status = 500) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => 'Internal Server Error',
    json: async () => ({}),
  });
}

function mockFetchBadJSON() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{
        message: { content: 'not valid json' },
      }],
    }),
    text: async () => 'not valid json',
  });
}

function mockFetchTimeout() {
  return vi.fn().mockImplementation(() =>
    new Promise((_, reject) => {
      // Simulate an AbortError
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      setTimeout(() => reject(err), 10);
    })
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('haiku-ambient classifyAmbient()', () => {

  beforeEach(() => {
    // Reset env to defaults before each test
    Object.assign(process.env, ENV_DEFAULTS);
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Core classification routing ───────────────────────────────────────────

  describe('core classification outcomes', () => {
    it('"hmm" → AMBIENT', async () => {
      vi.stubGlobal('fetch', mockFetch('AMBIENT', 'non-language vocalization'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=ambient1');
      const result = await classifyAmbient('hmm');
      expect(result).toBe('AMBIENT');
    });

    it('"yeah exactly" → SELF_TALK', async () => {
      vi.stubGlobal('fetch', mockFetch('SELF_TALK', 'internal monologue'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=selftalk1');
      const result = await classifyAmbient('yeah exactly');
      expect(result).toBe('SELF_TALK');
    });

    it('"Jarvis what time is it" → DIRECTED', async () => {
      vi.stubGlobal('fetch', mockFetch('DIRECTED', 'wake word present'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=directed1');
      const result = await classifyAmbient('Jarvis what time is it');
      expect(result).toBe('DIRECTED');
    });

    it('"good night" → SLEEP', async () => {
      vi.stubGlobal('fetch', mockFetch('SLEEP', 'clear sign-off'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=sleep1');
      const result = await classifyAmbient('good night');
      expect(result).toBe('SLEEP');
    });

    it('empty string → UNCERTAIN (fast path, no API call)', async () => {
      const mockFn = vi.fn();
      vi.stubGlobal('fetch', mockFn);
      const { classifyAmbient } = await import('../haiku-ambient.js?t=empty1');
      const result = await classifyAmbient('');
      expect(result).toBe('UNCERTAIN');
      expect(mockFn).not.toHaveBeenCalled(); // fast path
    });

    it('whitespace-only transcript → UNCERTAIN (fast path)', async () => {
      const mockFn = vi.fn();
      vi.stubGlobal('fetch', mockFn);
      const { classifyAmbient } = await import('../haiku-ambient.js?t=ws1');
      const result = await classifyAmbient('   ');
      expect(result).toBe('UNCERTAIN');
      expect(mockFn).not.toHaveBeenCalled();
    });

    it('"ugh" → AMBIENT', async () => {
      vi.stubGlobal('fetch', mockFetch('AMBIENT', 'filler vocalization'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=ugh1');
      const result = await classifyAmbient('ugh');
      expect(result).toBe('AMBIENT');
    });

    it('"wait no actually" → SELF_TALK', async () => {
      vi.stubGlobal('fetch', mockFetch('SELF_TALK', 'thinking aloud'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=st2');
      const result = await classifyAmbient('wait no actually');
      expect(result).toBe('SELF_TALK');
    });

    it('"stand down" → SLEEP', async () => {
      vi.stubGlobal('fetch', mockFetch('SLEEP', 'explicit dismissal'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=sleep2');
      const result = await classifyAmbient('stand down');
      expect(result).toBe('SLEEP');
    });
  });

  // ── Wake word fast path ───────────────────────────────────────────────────

  describe('wake word fast path', () => {
    it('wakeWordDetected=true → DIRECTED immediately (no API call)', async () => {
      const mockFn = vi.fn();
      vi.stubGlobal('fetch', mockFn);
      const { classifyAmbient } = await import('../haiku-ambient.js?t=ww1');
      const result = await classifyAmbient('what time is it', { wakeWordDetected: true });
      expect(result).toBe('DIRECTED');
      expect(mockFn).not.toHaveBeenCalled();
    });
  });

  // ── Fail-open behavior ────────────────────────────────────────────────────

  describe('fail-open — errors return UNCERTAIN', () => {
    it('network error → UNCERTAIN', async () => {
      vi.stubGlobal('fetch', mockFetchError('Connection refused'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=err1');
      const result = await classifyAmbient('play some music');
      expect(result).toBe('UNCERTAIN');
    });

    it('gateway 500 → UNCERTAIN', async () => {
      vi.stubGlobal('fetch', mockFetchBadStatus(500));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=err2');
      const result = await classifyAmbient('check my emails');
      expect(result).toBe('UNCERTAIN');
    });

    it('invalid JSON response → UNCERTAIN', async () => {
      vi.stubGlobal('fetch', mockFetchBadJSON());
      const { classifyAmbient } = await import('../haiku-ambient.js?t=err3');
      const result = await classifyAmbient('what is the weather');
      expect(result).toBe('UNCERTAIN');
    });

    it('AbortError (timeout) → UNCERTAIN', async () => {
      vi.stubGlobal('fetch', mockFetchTimeout());
      const { classifyAmbient } = await import('../haiku-ambient.js?t=err4');
      const result = await classifyAmbient('remind me at 3');
      expect(result).toBe('UNCERTAIN');
    });

    it('unknown result value → UNCERTAIN', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ result: 'BANANA', reason: 'test' }) } }],
        }),
        text: async () => '',
      }));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=err5');
      const result = await classifyAmbient('hello there');
      expect(result).toBe('UNCERTAIN');
    });

    it('no gateway token → UNCERTAIN', async () => {
      const savedToken = process.env.JARVIS_GATEWAY_TOKEN;
      delete process.env.JARVIS_GATEWAY_TOKEN;
      const mockFn = vi.fn();
      vi.stubGlobal('fetch', mockFn);
      const { classifyAmbient } = await import('../haiku-ambient.js?t=notoken1');
      const result = await classifyAmbient('what time is it');
      expect(result).toBe('UNCERTAIN');
      expect(mockFn).not.toHaveBeenCalled();
      process.env.JARVIS_GATEWAY_TOKEN = savedToken;
    });
  });

  // ── Disabled classifier ───────────────────────────────────────────────────

  describe('disabled classifier', () => {
    it('HAIKU_AMBIENT_CLASSIFIER_ENABLED=false → DIRECTED (pass through)', async () => {
      process.env.HAIKU_AMBIENT_CLASSIFIER_ENABLED = 'false';
      const mockFn = vi.fn();
      vi.stubGlobal('fetch', mockFn);
      const { classifyAmbient } = await import('../haiku-ambient.js?t=disabled1');
      const result = await classifyAmbient('hmm yeah okay');
      expect(result).toBe('DIRECTED'); // passes through, no API call
      expect(mockFn).not.toHaveBeenCalled();
    });
  });

  // ── Phase gating ─────────────────────────────────────────────────────────

  describe('phase gating', () => {
    it('Phase 1: AMBIENT is actioned', async () => {
      process.env.HAIKU_AMBIENT_PHASE = '1';
      vi.stubGlobal('fetch', mockFetch('AMBIENT', 'filler'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=ph1a');
      const result = await classifyAmbient('hmm');
      expect(result).toBe('AMBIENT');
    });

    it('Phase 1: SELF_TALK falls through as DIRECTED', async () => {
      process.env.HAIKU_AMBIENT_PHASE = '1';
      vi.stubGlobal('fetch', mockFetch('SELF_TALK', 'internal'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=ph1b');
      const result = await classifyAmbient('yeah exactly right');
      expect(result).toBe('DIRECTED'); // gated out in phase 1
    });

    it('Phase 1: SLEEP falls through as DIRECTED', async () => {
      process.env.HAIKU_AMBIENT_PHASE = '1';
      vi.stubGlobal('fetch', mockFetch('SLEEP', 'sign-off'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=ph1c');
      const result = await classifyAmbient('good night');
      expect(result).toBe('DIRECTED'); // gated out in phase 1
    });

    it('Phase 2: SELF_TALK is actioned', async () => {
      process.env.HAIKU_AMBIENT_PHASE = '2';
      vi.stubGlobal('fetch', mockFetch('SELF_TALK', 'thinking aloud'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=ph2a');
      const result = await classifyAmbient('oh right that makes sense');
      expect(result).toBe('SELF_TALK');
    });

    it('Phase 2: SLEEP still falls through as DIRECTED', async () => {
      process.env.HAIKU_AMBIENT_PHASE = '2';
      vi.stubGlobal('fetch', mockFetch('SLEEP', 'goodbye'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=ph2b');
      const result = await classifyAmbient('goodbye');
      expect(result).toBe('DIRECTED'); // gated out in phase 2
    });

    it('Phase 3: all outcomes active — SLEEP is actioned', async () => {
      process.env.HAIKU_AMBIENT_PHASE = '3';
      vi.stubGlobal('fetch', mockFetch('SLEEP', 'stand down'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=ph3a');
      const result = await classifyAmbient('stand down');
      expect(result).toBe('SLEEP');
    });

    it('Phase 3: UNCERTAIN is returned as-is', async () => {
      process.env.HAIKU_AMBIENT_PHASE = '3';
      vi.stubGlobal('fetch', mockFetch('UNCERTAIN', 'ambiguous'));
      const { classifyAmbient } = await import('../haiku-ambient.js?t=ph3b');
      const result = await classifyAmbient('some ambiguous phrase');
      expect(result).toBe('UNCERTAIN');
    });
  });

  // ── Context signals ───────────────────────────────────────────────────────

  describe('context signals passed to API', () => {
    it('includes wordCount, hasTaskVerb, isQuestion in request body', async () => {
      const mockFn = mockFetch('DIRECTED', 'task verb present');
      vi.stubGlobal('fetch', mockFn);
      const { classifyAmbient } = await import('../haiku-ambient.js?t=ctx1');
      await classifyAmbient('check my emails', {
        hasTaskVerb: true,
        isQuestion: false,
        wordCount: 3,
      });
      expect(mockFn).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFn.mock.calls[0][1].body);
      const userContent = body.messages[1].content;
      expect(userContent).toContain('HAS_TASK_VERB: true');
      expect(userContent).toContain('IS_QUESTION: false');
      expect(userContent).toContain('WORD_COUNT: 3');
    });

    it('includes recentHistory when provided', async () => {
      const mockFn = mockFetch('DIRECTED', 'context');
      vi.stubGlobal('fetch', mockFn);
      const { classifyAmbient } = await import('../haiku-ambient.js?t=ctx2');
      await classifyAmbient('what about that?', {
        recentHistory: ['User: check emails', 'Jarvis: You have 3 unread.'],
      });
      const body = JSON.parse(mockFn.mock.calls[0][1].body);
      const userContent = body.messages[1].content;
      expect(userContent).toContain('RECENT HISTORY');
      expect(userContent).toContain('check emails');
    });
  });

  // ── Utility exports ───────────────────────────────────────────────────────

  describe('utility exports', () => {
    it('isAmbientClassifierEnabled() reflects env var', async () => {
      process.env.HAIKU_AMBIENT_CLASSIFIER_ENABLED = 'true';
      const { isAmbientClassifierEnabled } = await import('../haiku-ambient.js?t=util1');
      // Note: top-level const is read at import time; this tests the initial env
      expect(typeof isAmbientClassifierEnabled()).toBe('boolean');
    });

    it('getAmbientPhase() returns numeric phase', async () => {
      const { getAmbientPhase } = await import('../haiku-ambient.js?t=util2');
      expect(typeof getAmbientPhase()).toBe('number');
    });
  });
});
