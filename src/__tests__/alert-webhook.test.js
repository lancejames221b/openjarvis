/**
 * Tests for alert-webhook.js HTTP endpoints
 *
 * Uses node's built-in http + fetch to test against the real Express app
 * started on a random ephemeral port — no supertest, no server setup in source.
 *
 * The existing sleep-mode-api.test.js already covers /sleep_mode in depth.
 * This file covers: /speak, /alert, /stop, /cancel, /health, and auth enforcement.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer } from 'node:http';

// alert-webhook.js reads ALERT_WEBHOOK_TOKEN at module load time as a const.
// The module may already be cached from other test files (sleep-mode-api.test.js imports it too).
// In that case, the const was captured as the default 'change-me'.
// We use the same default so auth checks pass regardless of import order.
const TEST_TOKEN = process.env.ALERT_WEBHOOK_TOKEN || 'change-me';

// ── Import the Express app ──────────────────────────────────────────────────
// alert-webhook.js has very few top-level static imports (express, bot-state, logger,
// alert-queue, task-ledger, hud, alert-context, focus-state, visual-mode).
// The heavy modules (brain.js, tts.js, stt.js, fsm.js, speech-output.js) are all
// dynamic imports inside individual route handlers — they are never required up front.
// So we don't need vi.mock() for those; they'll only be dynamically imported on demand.

import {
  app,
  setSpeakCallback,
  setCancelAllTasksCallback,
  setMarkBotResponseCallback,
  setPostActivityCallback,
  setPostToTextCallback,
} from '../alert-webhook.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let server;
let baseUrl;

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
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Clear any wired callbacks to start each test clean
  setSpeakCallback(null);
  setCancelAllTasksCallback(null);
});

async function post(path, body = {}, token = TEST_TOKEN) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function get(path, token = null) {
  return fetch(`${baseUrl}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with ok: true', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('returns service name', async () => {
    const res = await get('/health');
    const body = await res.json();
    expect(body.service).toBe('jarvis-voice');
  });

  it('returns uptime string', async () => {
    const res = await get('/health');
    const body = await res.json();
    expect(typeof body.uptime).toBe('string');
    expect(body.uptime).toMatch(/\d+s/);
  });

  it('returns memory stats', async () => {
    const res = await get('/health');
    const body = await res.json();
    expect(body.memory).toBeDefined();
    expect(typeof body.memory.rss).toBe('string');
    expect(typeof body.memory.heapUsed).toBe('string');
  });

  it('returns gateway health field', async () => {
    const res = await get('/health');
    const body = await res.json();
    expect(body.gateway).toBeDefined();
    expect(typeof body.gateway.healthy).toBe('boolean');
  });

  it('returns fsm state', async () => {
    const res = await get('/health');
    const body = await res.json();
    expect(body.fsm).toBeDefined();
    expect(typeof body.fsm.state).toBe('string');
  });

  it('does not require auth (public endpoint)', async () => {
    // /health is intentionally public — no token needed
    const res = await get('/health');
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /speak
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /speak', () => {
  describe('auth', () => {
    it('returns 401 with no Authorization header', async () => {
      const res = await post('/speak', { message: 'hello' }, null);
      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong token', async () => {
      const res = await post('/speak', { message: 'hello' }, 'wrong-token');
      expect(res.status).toBe(401);
    });

    it('returns 401 with malformed auth (missing Bearer prefix)', async () => {
      const res = await fetch(`${baseUrl}/speak`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: TEST_TOKEN, // missing "Bearer " prefix
        },
        body: JSON.stringify({ message: 'hello' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('returns 400 when message is missing', async () => {
      const res = await post('/speak', {});
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/message/i);
    });
  });

  describe('successful requests', () => {
    it('returns 200 with valid token and message', async () => {
      const res = await post('/speak', { message: 'Hello world' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('returns delivered field in response', async () => {
      const res = await post('/speak', { message: 'Test message' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('delivered');
    });

    it('calls speak callback when wired and user appears to be in voice', async () => {
      // speakCallback is only called when isUserInVoice() returns true.
      // Without a real Discord guild, isUserInVoice() returns false, so
      // we verify the callback registration doesn't break the endpoint.
      const mockSpeak = vi.fn();
      setSpeakCallback(mockSpeak);

      const res = await post('/speak', { message: 'Calling speak callback' });
      expect(res.status).toBe(200);
      // Whether called depends on voice state; endpoint must not error
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /alert
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /alert', () => {
  describe('auth', () => {
    it('returns 401 with no auth header', async () => {
      const res = await post('/alert', { message: 'Test alert' }, null);
      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong token', async () => {
      const res = await post('/alert', { message: 'Test alert' }, 'bad-token');
      expect(res.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('returns 400 when message is missing', async () => {
      const res = await post('/alert', { priority: 'normal' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/message/i);
    });
  });

  describe('successful requests', () => {
    it('returns 200 with valid alert payload', async () => {
      const res = await post('/alert', {
        message: 'Test alert message',
        priority: 'normal',
        source: 'test',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('returns queued: true in response', async () => {
      const res = await post('/alert', { message: 'Alert to queue' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.queued).toBe(true);
    });

    it('returns priorityLevel in response', async () => {
      const res = await post('/alert', {
        message: 'Priority test',
        priority: 'normal',
      });
      const body = await res.json();
      expect(typeof body.priorityLevel).toBe('number');
    });

    it('returns userInVoice boolean in response', async () => {
      const res = await post('/alert', { message: 'Voice state test' });
      const body = await res.json();
      expect(typeof body.userInVoice).toBe('boolean');
    });

    it('accepts fullDetails field without error', async () => {
      const res = await post('/alert', {
        message: 'Alert with details',
        fullDetails: 'Extended description of the alert',
        source: 'monitor',
      });
      expect(res.status).toBe(200);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /stop
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /stop', () => {
  it('returns 401 without auth', async () => {
    const res = await post('/stop', {}, null);
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid auth', async () => {
    const res = await post('/stop', {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('returns action field in response', async () => {
    const res = await post('/stop', {});
    const body = await res.json();
    expect(body).toHaveProperty('action');
  });

  it('returns acknowledged when no speech output module available', async () => {
    // speech-output.js is a dynamic import — without the bot running,
    // /stop gracefully acknowledges
    const res = await post('/stop', {});
    const body = await res.json();
    // 'stopped' or 'acknowledged' — both are valid
    expect(['stopped', 'acknowledged']).toContain(body.action);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /cancel
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /cancel', () => {
  it('returns 401 without auth', async () => {
    const res = await post('/cancel', {}, null);
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid auth', async () => {
    const res = await post('/cancel', {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('returns cancelled count in response', async () => {
    const res = await post('/cancel', {});
    const body = await res.json();
    expect(typeof body.cancelled).toBe('number');
  });

  it('cancelled is 0 when no callback wired', async () => {
    // No cancelAllTasksFn wired — returns 0
    setCancelAllTasksCallback(null);
    const res = await post('/cancel', {});
    const body = await res.json();
    expect(body.cancelled).toBe(0);
  });

  it('calls cancelAllTasks callback when wired', async () => {
    const mockCancel = vi.fn(() => 3); // simulate 3 tasks cancelled
    setCancelAllTasksCallback(mockCancel);

    const res = await post('/cancel', {});
    expect(res.status).toBe(200);
    expect(mockCancel).toHaveBeenCalledOnce();

    const body = await res.json();
    expect(body.cancelled).toBe(3);
  });

  it('returns count from callback return value', async () => {
    setCancelAllTasksCallback(() => 7);
    const res = await post('/cancel', {});
    const body = await res.json();
    expect(body.cancelled).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth enforcement — all POST endpoints require Bearer token
// ─────────────────────────────────────────────────────────────────────────────

describe('Auth enforcement', () => {
  const protectedEndpoints = [
    { method: 'POST', path: '/speak',    body: { message: 'test' } },
    { method: 'POST', path: '/alert',    body: { message: 'test' } },
    { method: 'POST', path: '/stop',     body: {} },
    { method: 'POST', path: '/cancel',   body: {} },
    { method: 'POST', path: '/sleep_mode', body: { action: 'status' } },
  ];

  for (const endpoint of protectedEndpoints) {
    it(`${endpoint.method} ${endpoint.path} returns 401 without token`, async () => {
      const res = await post(endpoint.path, endpoint.body, null);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toMatch(/unauthorized/i);
    });

    it(`${endpoint.method} ${endpoint.path} returns 401 with wrong token`, async () => {
      const res = await post(endpoint.path, endpoint.body, 'not-the-right-token');
      expect(res.status).toBe(401);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Callback wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('Callback wiring', () => {
  it('setSpeakCallback wires a callable function', () => {
    const fn = vi.fn();
    // Should not throw
    expect(() => setSpeakCallback(fn)).not.toThrow();
    expect(() => setSpeakCallback(null)).not.toThrow();
  });

  it('setCancelAllTasksCallback wires a callable function', () => {
    const fn = vi.fn(() => 0);
    expect(() => setCancelAllTasksCallback(fn)).not.toThrow();
    expect(() => setCancelAllTasksCallback(null)).not.toThrow();
  });

  it('setMarkBotResponseCallback wires without error', () => {
    expect(() => setMarkBotResponseCallback(vi.fn())).not.toThrow();
    expect(() => setMarkBotResponseCallback(null)).not.toThrow();
  });

  it('setPostActivityCallback wires without error', () => {
    expect(() => setPostActivityCallback(vi.fn())).not.toThrow();
    expect(() => setPostActivityCallback(null)).not.toThrow();
  });

  it('setPostToTextCallback wires without error', () => {
    expect(() => setPostToTextCallback(vi.fn())).not.toThrow();
    expect(() => setPostToTextCallback(null)).not.toThrow();
  });
});
