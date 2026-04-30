/**
 * Feature: Alert pipeline integration tests
 *
 * Covers the full webhook alert pipeline end-to-end:
 *   - POST /alert: auth, validation, queuing, delivery callback
 *   - alert-queue.js: priority-based ordering
 *   - task-ledger.js: lifecycle, state transitions, terminal-state guard
 *   - POST /speak with taskId: ledger integration
 *   - /test/stt DEV_MODE guard (cross-check; full coverage in fake-stt-endpoint.test.js)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer } from 'node:http';

// Mock fs before any module is imported that touches the filesystem.
// Prevents real disk reads/writes from task-ledger and hud state files,
// and ensures a clean in-memory ledger for every test run.
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => JSON.stringify({ tasks: [] })),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const TEST_TOKEN = process.env.ALERT_WEBHOOK_TOKEN || 'change-me';

import {
  app,
  setPostToTextCallback,
  setSpeakCallback,
  setCancelAllTasksCallback,
} from '../alert-webhook.js';

import {
  queueAlert,
  getPendingAlerts,
  clearAlerts,
} from '../alert-queue.js';

import {
  createTask,
  updateTask,
  getTask,
  markCompleted,
  markFailed,
  TaskState,
} from '../agent/task-ledger.js';

// ── HTTP server lifecycle ─────────────────────────────────────────────

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
  clearAlerts();
  setPostToTextCallback(null);
  setSpeakCallback(null);
  setCancelAllTasksCallback(null);
});

// ── Shared helper ─────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────
// Scenarios 1-3: POST /alert — auth and validation
// ─────────────────────────────────────────────────────────────────────

describe('POST /alert — auth and validation', () => {
  it('returns 200 with ok:true and queued:true when token is valid', async () => {
    const res = await post('/alert', { message: 'server down', source: 'monitor' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.queued).toBe(true);
  });

  it('returns 401 with no Authorization header', async () => {
    const res = await post('/alert', { message: 'test alert' }, null);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
  });

  it('returns 401 with wrong token', async () => {
    const res = await post('/alert', { message: 'test alert' }, 'wrong-token');
    expect(res.status).toBe(401);
  });

  it('returns 400 when message field is missing', async () => {
    const res = await post('/alert', { source: 'monitor', priority: 'normal' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/message/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 4: Alert queued and surfaced via postToTextCallback
// ─────────────────────────────────────────────────────────────────────

describe('POST /alert — queued and surfaced', () => {
  it('alert appears in getPendingAlerts after a successful POST', async () => {
    await post('/alert', { message: 'CPU spike detected', source: 'prometheus' });
    const pending = getPendingAlerts();
    expect(pending.some(a => a.message === 'CPU spike detected')).toBe(true);
  });

  it('wired postToTextCallback is called when ALERTS_ALSO_POST_TEXT is on', async () => {
    const mockNotify = vi.fn();
    setPostToTextCallback(mockNotify);

    // ALERTS_ALSO_POST_TEXT defaults to true (env not set to 'false')
    await post('/alert', { message: 'Disk 90% full', source: 'metrics' });

    expect(mockNotify).toHaveBeenCalled();
    expect(mockNotify.mock.calls[0][0]).toContain('Disk 90% full');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenarios 5-6: Queue priority ordering
// ─────────────────────────────────────────────────────────────────────

describe('alert-queue — priority ordering', () => {
  it('critical alert inserted after a normal alert sorts to the front', () => {
    queueAlert({ message: 'Normal alert', priority: 'normal' });
    queueAlert({ message: 'Critical alert', priority: 'critical' });

    const [first, second] = getPendingAlerts();
    expect(first.message).toBe('Critical alert');
    expect(second.message).toBe('Normal alert');
  });

  it('multiple alerts drain in P1→P2→P3→P4 order regardless of insertion order', () => {
    queueAlert({ message: 'Low',      priority: 'low' });
    queueAlert({ message: 'Normal',   priority: 'normal' });
    queueAlert({ message: 'Urgent',   priority: 'urgent' });
    queueAlert({ message: 'Critical', priority: 'critical' });

    const priorities = getPendingAlerts().map(a => a.priority);
    expect(priorities).toEqual(['critical', 'urgent', 'normal', 'low']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenarios 7-10: Task ledger lifecycle
// ─────────────────────────────────────────────────────────────────────

describe('task ledger — lifecycle', () => {
  let seq = 0;
  const nextId = () => `feat-alert-${Date.now()}-${seq++}`;

  it('createTask stores task with DISPATCHED (pending) status', () => {
    const id = nextId();
    const task = createTask(id, 'check calendar', 'user1');
    expect(task.state).toBe(TaskState.DISPATCHED);
    expect(getTask(id)).not.toBeNull();
  });

  it('updateTask transitions DISPATCHED → STREAMING', () => {
    const id = nextId();
    createTask(id, 'stream task', 'user1');
    const result = updateTask(id, { state: TaskState.STREAMING });
    expect(result.state).toBe(TaskState.STREAMING);
  });

  it('markCompleted sets state to COMPLETED and resultDelivered to true', () => {
    const id = nextId();
    createTask(id, 'complete me', 'user1');
    const result = markCompleted(id, 'voice', 'summary text');
    expect(result.state).toBe(TaskState.COMPLETED);
    expect(result.resultDelivered).toBe(true);
    expect(result.deliveryMethod).toBe('voice');
  });

  it('markFailed transitions to FAILED with error message preserved', () => {
    const id = nextId();
    createTask(id, 'will fail', 'user1');
    const result = markFailed(id, 'Gateway timeout');
    expect(result.state).toBe(TaskState.FAILED);
    expect(result.error).toContain('Gateway timeout');
  });

  it('invalid transition COMPLETED → DISPATCHED is rejected (returns null)', () => {
    const id = nextId();
    createTask(id, 'done task', 'user1');
    markCompleted(id, 'voice', 'done');

    const result = updateTask(id, { state: TaskState.DISPATCHED });
    expect(result).toBeNull();
    expect(getTask(id).state).toBe(TaskState.COMPLETED);
  });

  it('invalid transition FAILED → STREAMING is rejected and task state unchanged', () => {
    const id = nextId();
    createTask(id, 'failed task', 'user1');
    markFailed(id, 'timeout');

    const result = updateTask(id, { state: TaskState.STREAMING });
    expect(result).toBeNull();
    expect(getTask(id).state).toBe(TaskState.FAILED);
  });

  it('getTask returns null for unknown id without throwing', () => {
    expect(getTask('no-such-task-feature-alerts-xyz')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 11: POST /speak with taskId updates the ledger task
// ─────────────────────────────────────────────────────────────────────

describe('POST /speak with taskId — ledger integration', () => {
  let seq = 0;
  const nextId = () => `speak-ledger-${Date.now()}-${seq++}`;

  it('marks the corresponding ledger task as COMPLETED when source=task-complete', async () => {
    const taskId = nextId();
    createTask(taskId, 'task to complete via speak endpoint', 'user1');

    const res = await post('/speak', {
      message: `Task complete! Results for task ${taskId}.`,
      source: 'task-complete',
      taskId,
    });
    expect(res.status).toBe(200);

    const task = getTask(taskId);
    expect(task.state).toBe(TaskState.COMPLETED);
    expect(task.resultDelivered).toBe(true);
    expect(task.deliveryMethod).toMatch(/speak-endpoint/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 12: /test/stt DEV_MODE guard (cross-check only)
// Full coverage lives in fake-stt-endpoint.test.js — not duplicated here.
// ─────────────────────────────────────────────────────────────────────

describe('/test/stt — DEV_MODE guard cross-check', () => {
  it('endpoint returns 404 when DEV_MODE is off (NODE_ENV=production in vitest env)', async () => {
    const devModeOn =
      process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';
    if (devModeOn) {
      // DEV_MODE active — endpoint is registered, skip the 404 assertion
      console.log('[skip] DEV_MODE active — /test/stt is registered, skipping 404 check');
      return;
    }

    const res = await fetch(`${baseUrl}/test/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(404);
  });
});
