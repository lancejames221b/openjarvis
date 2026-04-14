/**
 * Tests for the /test/stt endpoint in alert-webhook.js
 *
 * The endpoint is conditionally registered when DEV_MODE=true or NODE_ENV=development.
 * These tests exercise both the dev-mode-enabled and dev-mode-disabled paths.
 *
 * Part A (endpoint code) was added to alert-webhook.js.
 * Part B (these tests) verify correct behavior.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer } from 'node:http';

// The ALERT_WEBHOOK_TOKEN is captured at module load as a const.
// alert-webhook.js is already imported/cached by other test files, so the token
// is whatever was captured first. Use the same default 'change-me'.
const TEST_TOKEN = process.env.ALERT_WEBHOOK_TOKEN || 'change-me';

import { app, setHandleFakeSttCallback } from '../alert-webhook.js';

let server;
let baseUrl;
let endpointActive = false; // detected in beforeAll

beforeAll(async () => {
  await new Promise((resolve, reject) => {
    server = createServer(app);
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Probe whether /test/stt was registered (DEV_MODE=true at module load time)
  // With no auth: if endpoint exists → 401; if not registered → 404
  try {
    const probe = await fetch(`${baseUrl}/test/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    endpointActive = probe.status !== 404;
  } catch {
    endpointActive = false;
  }
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  setHandleFakeSttCallback(null);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function sttPost(body = {}, token = TEST_TOKEN) {
  return fetch(`${baseUrl}/test/stt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported setter — always available regardless of DEV_MODE
// ─────────────────────────────────────────────────────────────────────────────

describe('setHandleFakeSttCallback export', () => {
  it('is exported and callable', () => {
    expect(typeof setHandleFakeSttCallback).toBe('function');
  });

  it('accepts a function without throwing', () => {
    expect(() => setHandleFakeSttCallback(vi.fn())).not.toThrow();
  });

  it('accepts null to clear the handler without throwing', () => {
    expect(() => setHandleFakeSttCallback(null)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint availability — reflects DEV_MODE setting at module load
// ─────────────────────────────────────────────────────────────────────────────

describe('/test/stt endpoint availability', () => {
  it('returns 404 when DEV_MODE is off (endpoint not registered)', async () => {
    if (endpointActive) {
      // DEV_MODE is on in this environment — endpoint exists, skip 404 check
      console.log('[skip] DEV_MODE is active — endpoint registered, skipping 404 test');
      return;
    }
    // Endpoint not registered → Express returns 404 for unknown routes
    const res = await sttPost({ text: 'hello' });
    expect(res.status).toBe(404);
  });

  it('is accessible when DEV_MODE is on', async () => {
    if (!endpointActive) {
      // DEV_MODE is off — skip
      console.log('[skip] DEV_MODE is off — endpoint not registered, skipping accessibility test');
      return;
    }
    // Endpoint registered: with no auth should return 401, not 404
    const res = await sttPost({ text: 'hello' }, null);
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth tests — only meaningful when endpoint is registered
// ─────────────────────────────────────────────────────────────────────────────

describe('/test/stt auth', () => {
  it('returns 401 without Authorization header', async () => {
    if (!endpointActive) {
      console.log('[skip] DEV_MODE off — endpoint not registered');
      return;
    }
    const res = await sttPost({ text: 'hello jarvis' }, null);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
  });

  it('returns 401 with wrong token', async () => {
    if (!endpointActive) return;
    const res = await sttPost({ text: 'hello jarvis' }, 'wrong-token');
    expect(res.status).toBe(401);
  });

  it('returns 401 with missing Bearer prefix', async () => {
    if (!endpointActive) return;
    const res = await fetch(`${baseUrl}/test/stt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: TEST_TOKEN, // no "Bearer " prefix
      },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation tests — only when endpoint is registered
// ─────────────────────────────────────────────────────────────────────────────

describe('/test/stt validation', () => {
  it('returns 400 when text is missing', async () => {
    if (!endpointActive) return;
    const res = await sttPost({ userId: 'user123' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/text/i);
  });

  it('returns 400 when body is empty object', async () => {
    if (!endpointActive) return;
    const res = await sttPost({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when text is empty string', async () => {
    if (!endpointActive) return;
    const res = await sttPost({ text: '' });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Handler behavior — only when endpoint is registered
// ─────────────────────────────────────────────────────────────────────────────

describe('/test/stt handler behavior', () => {
  it('returns 200 with "not wired" note when no handler registered', async () => {
    if (!endpointActive) return;
    setHandleFakeSttCallback(null);
    const res = await sttPost({ text: 'play some music' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.note).toMatch(/not wired/i);
  });

  it('calls handler with text when wired', async () => {
    if (!endpointActive) return;
    const mockHandler = vi.fn(async (text, userId) => ({
      type: 'command',
      wakeWord: true,
      transcript: text,
    }));
    setHandleFakeSttCallback(mockHandler);

    const res = await sttPost({ text: 'jarvis play music' });
    expect(res.status).toBe(200);
    expect(mockHandler).toHaveBeenCalledOnce();
    expect(mockHandler).toHaveBeenCalledWith('jarvis play music', undefined);
  });

  it('passes userId to handler when provided', async () => {
    if (!endpointActive) return;
    const mockHandler = vi.fn(async (text, userId) => ({ type: 'command', userId }));
    setHandleFakeSttCallback(mockHandler);

    await sttPost({ text: 'hello', userId: 'user-456' });
    expect(mockHandler).toHaveBeenCalledWith('hello', 'user-456');
  });

  it('spreads handler result into response body', async () => {
    if (!endpointActive) return;
    const mockHandler = vi.fn(async () => ({
      type: 'voice_command',
      wakeWord: true,
      transcript: 'jarvis check my email',
      dispatch: { type: 'agent' },
    }));
    setHandleFakeSttCallback(mockHandler);

    const res = await sttPost({ text: 'jarvis check my email' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.type).toBe('voice_command');
    expect(body.wakeWord).toBe(true);
    expect(body.transcript).toBe('jarvis check my email');
  });

  it('returns 500 when handler throws', async () => {
    if (!endpointActive) return;
    const mockHandler = vi.fn(async () => {
      throw new Error('Pipeline processing failed');
    });
    setHandleFakeSttCallback(mockHandler);

    const res = await sttPost({ text: 'something that breaks' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/pipeline processing failed/i);
  });

  it('userId is undefined when not provided in request', async () => {
    if (!endpointActive) return;
    const mockHandler = vi.fn(async (text, userId) => ({
      type: 'command',
      gotUserId: userId,
    }));
    setHandleFakeSttCallback(mockHandler);

    await sttPost({ text: 'no user id' });
    expect(mockHandler).toHaveBeenCalledWith('no user id', undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEV_MODE behavioral summary test
// ─────────────────────────────────────────────────────────────────────────────

describe('/test/stt DEV_MODE guard', () => {
  it('endpoint registered iff DEV_MODE=true or NODE_ENV=development', async () => {
    const devModeOn = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';

    if (devModeOn) {
      expect(endpointActive).toBe(true);
    } else {
      expect(endpointActive).toBe(false);
    }
  });
});
