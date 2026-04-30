/**
 * Tests for POST /sleep_mode endpoint in alert-webhook.js
 *
 * Starts the express app on a random port for isolation.
 * Resets FSM state between tests to prevent cross-test bleed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { app } from '../alert-webhook.js';
import { getState, transition } from '../state/bot-state.js';

// alert-webhook reads ALERT_WEBHOOK_TOKEN at module load as a const.
// Vitest env in package.json does not set it, so it falls back to 'change-me'.
// Use that default here to match.
const TEST_TOKEN = process.env.ALERT_WEBHOOK_TOKEN || 'change-me';

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
  // Reset FSM to ACTIVE before each test for clean state
  transition('ACTIVE', 'test-reset');
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function sleepMode(action, token = TEST_TOKEN) {
  return fetch(`${baseUrl}/sleep_mode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action }),
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('POST /sleep_mode — auth', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await sleepMode('status', null);
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is wrong', async () => {
    const res = await sleepMode('status', 'wrong-token');
    expect(res.status).toBe(401);
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('POST /sleep_mode — validation', () => {
  it('returns 400 for unknown action', async () => {
    const res = await sleepMode('invalid');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/invalid action/i);
  });

  it('returns 400 when action is missing', async () => {
    const res = await fetch(`${baseUrl}/sleep_mode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ── Status ────────────────────────────────────────────────────────────────────

describe('POST /sleep_mode — status', () => {
  it('returns current FSM state', async () => {
    const res = await sleepMode('status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.state).toBe('string');
    expect(body.state.length).toBeGreaterThan(0);
  });

  it('reflects ACTIVE state correctly', async () => {
    transition('ACTIVE', 'test');
    const res = await sleepMode('status');
    const body = await res.json();
    expect(body.state).toBe('ACTIVE');
  });

  it('reflects SLEEP state correctly', async () => {
    transition('SLEEP', 'test');
    const res = await sleepMode('status');
    const body = await res.json();
    expect(body.state).toBe('SLEEP');
  });
});

// ── Sleep ─────────────────────────────────────────────────────────────────────

describe('POST /sleep_mode — sleep', () => {
  it('transitions FSM to SLEEP and returns 200', async () => {
    const res = await sleepMode('sleep');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state).toBe('SLEEP');
    expect(typeof body.previous).toBe('string');
  });

  it('FSM state is SLEEP after the call', async () => {
    await sleepMode('sleep');
    expect(getState()).toBe('SLEEP');
  });

  it('reports previous state in response', async () => {
    transition('ACTIVE', 'test');
    const res = await sleepMode('sleep');
    const body = await res.json();
    expect(body.previous).toBe('ACTIVE');
  });
});

// ── Wake ──────────────────────────────────────────────────────────────────────

describe('POST /sleep_mode — wake', () => {
  beforeEach(() => {
    transition('SLEEP', 'pre-wake-test');
  });

  it('transitions FSM to ACTIVE and returns 200', async () => {
    const res = await sleepMode('wake');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state).toBe('ACTIVE');
  });

  it('FSM state is ACTIVE after the call', async () => {
    await sleepMode('wake');
    expect(getState()).toBe('ACTIVE');
  });

  it('reports previous SLEEP state in response', async () => {
    const res = await sleepMode('wake');
    const body = await res.json();
    expect(body.previous).toBe('SLEEP');
  });
});

// ── Roundtrip ─────────────────────────────────────────────────────────────────

describe('POST /sleep_mode — roundtrip', () => {
  it('sleep then wake returns to ACTIVE', async () => {
    await sleepMode('sleep');
    const wakeRes = await sleepMode('wake');
    const body = await wakeRes.json();
    expect(body.state).toBe('ACTIVE');
    expect(getState()).toBe('ACTIVE');
  });
});
