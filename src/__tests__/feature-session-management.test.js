/**
 * feature-session-management.test.js
 *
 * Claude chatId session lifecycle — getOrCreateChatId, persistence, rotation,
 * haivemind summary on rotation, multi-channel isolation, concurrent safety.
 *
 * All state is redirected to a temp dir; no real ~/.local/state files are touched.
 * Haivemind HTTP calls are intercepted via a stubbed global fetch.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';

// ── Temp state dir — must exist before env vars are set ──────────────────────
const tmpDir = join(tmpdir(), `sm-session-test-${process.pid}`);
mkdirSync(tmpDir, { recursive: true });
const SESSION_STORE = join(tmpDir, 'sessions.json');

// ── Env config — must happen before module import ────────────────────────────
// Vitest evaluates top-level code synchronously before any dynamic import,
// so env vars set here are visible when the module initialises.
process.env.SESSION_CHAT_STORE   = SESSION_STORE;
process.env.JARVIS_MAX_TURNS     = '3';    // tiny budget for rotation tests
process.env.JARVIS_MAX_AGE_MS    = '150';  // 150 ms for age-rotation tests
process.env.HAIVEMIND_URL        = 'http://fake-haivemind:19999';
process.env.VOICE_MEMORY_ENABLED = 'true';

// ── Mock fetch — intercept haivemind HTTP calls ───────────────────────────────
const fetchMock = vi.fn().mockResolvedValue({
  ok: true,
  text: async () => 'data: {"result":{"content":[{"text":"ok"}]}}\n',
});
vi.stubGlobal('fetch', fetchMock);

// ── Import the module under test ──────────────────────────────────────────────
const { getOrCreateChatId, incrementChatTurns, _resetChatState } =
  await import('../agent/session-manager.js');

// UUID v4 regex
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Between-test teardown ─────────────────────────────────────────────────────
afterEach(() => {
  _resetChatState();               // wipe in-memory session cache
  fetchMock.mockClear();
  writeFileSync(SESSION_STORE, '{}');  // reset state file
});

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — new channelKey generates a UUID and persists it to state file
// ─────────────────────────────────────────────────────────────────────────────
it('new channelKey generates a UUID and persists it to the state file', async () => {
  const chatId = await getOrCreateChatId('chan-new-1');

  expect(chatId).toMatch(UUID_RE);

  const stored = JSON.parse(readFileSync(SESSION_STORE, 'utf8'));
  expect(stored['chan-new-1']).toBeDefined();
  expect(stored['chan-new-1'].chatId).toBe(chatId);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — same channelKey returns same chatId (idempotent)
// ─────────────────────────────────────────────────────────────────────────────
it('same channelKey returns the identical chatId on repeat calls', async () => {
  const first  = await getOrCreateChatId('chan-idempotent');
  const second = await getOrCreateChatId('chan-idempotent');
  const third  = await getOrCreateChatId('chan-idempotent');

  expect(second).toBe(first);
  expect(third).toBe(first);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — session state survives a module reset (simulated reload)
// ─────────────────────────────────────────────────────────────────────────────
it('chatId survives an in-memory cache wipe (simulated module reload)', async () => {
  const original = await getOrCreateChatId('chan-persist');

  _resetChatState(); // wipe in-memory cache — next call must reload from file

  const restored = await getOrCreateChatId('chan-persist');
  expect(restored).toBe(original);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 — turn-based rotation: after N turns, new chatId is created
// ─────────────────────────────────────────────────────────────────────────────
it('session rotates after N turns and yields a new chatId', async () => {
  const original = await getOrCreateChatId('chan-turns');

  // Exhaust budget (JARVIS_MAX_TURNS = 3)
  incrementChatTurns('chan-turns');
  incrementChatTurns('chan-turns');
  incrementChatTurns('chan-turns');

  const rotated = await getOrCreateChatId('chan-turns');
  expect(rotated).not.toBe(original);
  expect(rotated).toMatch(UUID_RE);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 — age-based rotation: after T ms, new chatId is created
// ─────────────────────────────────────────────────────────────────────────────
it('session rotates after T ms and yields a new chatId', async () => {
  const original = await getOrCreateChatId('chan-age');

  // Wait past JARVIS_MAX_AGE_MS (150 ms)
  await new Promise(r => setTimeout(r, 200));

  const rotated = await getOrCreateChatId('chan-age');
  expect(rotated).not.toBe(original);
  expect(rotated).toMatch(UUID_RE);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6 — after rotation, channelKey consistently returns new chatId
// ─────────────────────────────────────────────────────────────────────────────
it('after turn-based rotation channelKey returns new stable chatId', async () => {
  const original = await getOrCreateChatId('chan-post-rotate');

  incrementChatTurns('chan-post-rotate');
  incrementChatTurns('chan-post-rotate');
  incrementChatTurns('chan-post-rotate');

  const newId1 = await getOrCreateChatId('chan-post-rotate');
  const newId2 = await getOrCreateChatId('chan-post-rotate');

  expect(newId1).not.toBe(original);
  expect(newId2).toBe(newId1);  // the new session is stable
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 7 — haivemind summary is posted on rotation with channelKey + old ID
// ─────────────────────────────────────────────────────────────────────────────
it('rotation posts a summary to haivemind containing channelKey and old chatId', async () => {
  const channelKey = 'agent:main:discord:channel:999001';
  const oldId = await getOrCreateChatId(channelKey);

  incrementChatTurns(channelKey);
  incrementChatTurns(channelKey);
  incrementChatTurns(channelKey);

  await getOrCreateChatId(channelKey); // triggers rotation + fire-and-forget haivemind call

  // Fire-and-forget — wait for the async fetch to settle
  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalled();
  }, { timeout: 500 });

  const bodies = fetchMock.mock.calls.map(([, opts]) => {
    try { return opts?.body ?? ''; } catch { return ''; }
  });

  const summaryBody = bodies.find(b =>
    b.includes('SESSION ROTATION') && b.includes(channelKey)
  );

  expect(summaryBody).toBeDefined();
  expect(summaryBody).toContain(oldId);  // old chatId must appear in the summary
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 8 — multiple channelKeys are stored independently
// ─────────────────────────────────────────────────────────────────────────────
it('rotating one channelKey does not affect another', async () => {
  const idA = await getOrCreateChatId('chan-isolate-A');
  const idB = await getOrCreateChatId('chan-isolate-B');

  // Rotate A
  incrementChatTurns('chan-isolate-A');
  incrementChatTurns('chan-isolate-A');
  incrementChatTurns('chan-isolate-A');
  const newIdA = await getOrCreateChatId('chan-isolate-A');

  // B must be unchanged
  const idBAfter = await getOrCreateChatId('chan-isolate-B');

  expect(newIdA).not.toBe(idA);
  expect(idBAfter).toBe(idB);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 9 — corrupt/missing state file → starts fresh without crashing
// ─────────────────────────────────────────────────────────────────────────────
it('corrupt state file on startup does not throw and starts a fresh session', async () => {
  writeFileSync(SESSION_STORE, 'NOT_VALID_JSON{{{');
  _resetChatState(); // force file re-read on next call

  const chatId = await getOrCreateChatId('chan-corrupt');
  expect(chatId).toMatch(UUID_RE);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 10 — concurrent calls for same key return the same chatId
// ─────────────────────────────────────────────────────────────────────────────
it('concurrent getOrCreateChatId calls for the same key resolve to one chatId', async () => {
  const [id1, id2, id3] = await Promise.all([
    getOrCreateChatId('chan-concurrent'),
    getOrCreateChatId('chan-concurrent'),
    getOrCreateChatId('chan-concurrent'),
  ]);

  expect(id1).toMatch(UUID_RE);
  expect(id2).toBe(id1);
  expect(id3).toBe(id1);

  // Only one entry should exist in the store
  const stored = JSON.parse(readFileSync(SESSION_STORE, 'utf8'));
  const keys = Object.keys(stored).filter(k => k === 'chan-concurrent');
  expect(keys).toHaveLength(1);
});
