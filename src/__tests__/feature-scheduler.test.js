import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Shared disk state — mutated per test to control what loadSchedules() sees
const { disk } = vi.hoisted(() => ({ disk: { schedules: [] } }));

vi.mock('fs', () => ({
  existsSync: vi.fn((p) =>
    typeof p === 'string' && p.endsWith('schedules.json') ? disk.schedules.length > 0 : false
  ),
  readFileSync: vi.fn((p) =>
    typeof p === 'string' && p.endsWith('schedules.json')
      ? JSON.stringify({ schedules: disk.schedules })
      : ''
  ),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const TICK = 50; // scheduler tick interval used by all tests

async function freshMod() {
  vi.resetModules();
  process.env.SCHEDULER_TICK_MS = String(TICK);
  return import('../task-scheduler.js');
}

async function freshFs() {
  return import('fs');
}

beforeEach(() => {
  disk.schedules = [];
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ─── 1. createSchedule stores job ────────────────────────────────────────────
describe('createSchedule', () => {
  it('stores job with correct fields and nextRunAt at t + intervalMs', async () => {
    const { createSchedule } = await freshMod();

    const sched = createSchedule({
      prompt: 'check health',
      intervalMs: 300_000,
      channelId: 'ch1',
      userId: 'u1',
    });

    expect(sched.id).toMatch(/^sched_/);
    expect(sched.enabled).toBe(true);
    expect(sched.intervalMs).toBe(300_000);
    expect(sched.nextRunAt).toBe(300_000); // t=0 + 300_000
    expect(sched.runCount).toBe(0);
    expect(sched.channelId).toBe('ch1');
    expect(sched.prompt).toBe('check health');
  });
});

// ─── 2. First fire at t + intervalMs ─────────────────────────────────────────
describe('tick dispatch', () => {
  it('dispatches job after intervalMs has elapsed', async () => {
    const { createSchedule, initScheduler } = await freshMod();
    const dispatch = vi.fn().mockResolvedValue({ text: '' });
    initScheduler(dispatch);

    createSchedule({ prompt: 'ping', intervalMs: 5_000, channelId: 'ch1', userId: 'u1' });

    // Not yet due
    await vi.advanceTimersByTimeAsync(4_900);
    expect(dispatch).not.toHaveBeenCalled();

    // Past due — tick sees nextRunAt <= now
    await vi.advanceTimersByTimeAsync(200);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'ping' }));
  });
});

// ─── 3. maxRuns=3 fires exactly 3 times then self-deletes ────────────────────
describe('maxRuns limit', () => {
  it('fires exactly maxRuns times then removes the schedule', async () => {
    const { createSchedule, initScheduler, listSchedules } = await freshMod();
    const dispatch = vi.fn().mockResolvedValue({ text: '' });
    initScheduler(dispatch);

    const sched = createSchedule({
      prompt: 'status check',
      intervalMs: 1_000,
      channelId: 'ch1',
      userId: 'u1',
      maxRuns: 3,
    });

    await vi.advanceTimersByTimeAsync(3_100);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(listSchedules().find((s) => s.id === sched.id)).toBeUndefined();

    // No further fires after deletion
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });
});

// ─── 4. Duration-based: maxRuns computed from total duration, fires then stops
describe('duration-based schedule', () => {
  it('fires for computed maxRuns (duration / interval) then expires', async () => {
    const { createSchedule, initScheduler, listSchedules } = await freshMod();
    const dispatch = vi.fn().mockResolvedValue({ text: '' });
    initScheduler(dispatch);

    const intervalMs = 500;
    // Represents "for the next 2 hours" scaled down: 2500ms represents 2h, 500ms represents interval
    const durationMs = 2_500;
    const maxRuns = Math.floor(durationMs / intervalMs); // 5

    const sched = createSchedule({
      prompt: 'memory check',
      intervalMs,
      channelId: 'ch1',
      userId: 'u1',
      maxRuns,
    });

    await vi.advanceTimersByTimeAsync(durationMs + 200);
    expect(dispatch).toHaveBeenCalledTimes(maxRuns);
    expect(listSchedules().find((s) => s.id === sched.id)).toBeUndefined();
  });
});

// ─── 5. Shell mode: dispatch receives mode=shell schedule with shellCmd ───────
describe('shell mode schedule', () => {
  it('dispatch receives mode=shell and shellCmd when schedule is shell type', async () => {
    const { createSchedule, initScheduler } = await freshMod();
    const dispatch = vi.fn().mockResolvedValue({ text: '' });
    initScheduler(dispatch);

    createSchedule({
      prompt: 'disk check',
      intervalMs: 1_000,
      channelId: 'ch1',
      userId: 'u1',
      mode: 'shell',
      shellCmd: 'df -h | grep -v tmpfs',
    });

    await vi.advanceTimersByTimeAsync(1_100);
    expect(dispatch).toHaveBeenCalledOnce();
    const [passedSched] = dispatch.mock.calls[0];
    expect(passedSched.mode).toBe('shell');
    expect(passedSched.shellCmd).toBe('df -h | grep -v tmpfs');
  });
});

// ─── 6. LLM haiku mode: dispatch receives mode=llm, model=haiku ──────────────
describe('LLM haiku mode schedule', () => {
  it('dispatch receives mode=llm and model=haiku when schedule is llm type', async () => {
    const { createSchedule, initScheduler } = await freshMod();
    const dispatch = vi.fn().mockResolvedValue({ text: '' });
    initScheduler(dispatch);

    createSchedule({
      prompt: 'summarize the news',
      intervalMs: 1_000,
      channelId: 'ch1',
      userId: 'u1',
      mode: 'llm',
      model: 'haiku',
    });

    await vi.advanceTimersByTimeAsync(1_100);
    expect(dispatch).toHaveBeenCalledOnce();
    const [passedSched] = dispatch.mock.calls[0];
    expect(passedSched.mode).toBe('llm');
    expect(passedSched.model).toBe('haiku');
  });
});

// ─── 7. Auto-detect: no explicit mode → defaults to llm + haiku ──────────────
describe('mode defaults (auto-detect)', () => {
  it('defaults mode to llm and model to haiku when neither is specified', async () => {
    const { createSchedule } = await freshMod();

    const sched = createSchedule({
      prompt: 'what is the meaning of life',
      intervalMs: 60_000,
      channelId: 'ch1',
      userId: 'u1',
    });

    expect(sched.mode).toBe('llm');
    expect(sched.model).toBe('haiku');
    expect(sched.shellCmd).toBeNull();
  });
});

// ─── 8. Crash-safe: serialize to disk + reload from disk ─────────────────────
describe('crash-safe persistence', () => {
  it('writes serialized schedules to disk after creation', async () => {
    const { createSchedule } = await freshMod();
    const { writeFileSync } = await freshFs();

    createSchedule({ prompt: 'health ping', intervalMs: 60_000, channelId: 'ch1', userId: 'u1' });
    // saveSchedules debounces with setTimeout(500ms)
    await vi.advanceTimersByTimeAsync(600);

    expect(writeFileSync).toHaveBeenCalled();
    const lastCall = writeFileSync.mock.calls[writeFileSync.mock.calls.length - 1];
    const saved = JSON.parse(lastCall[1]);
    expect(saved.schedules).toHaveLength(1);
    expect(saved.schedules[0].prompt).toBe('health ping');
    expect(saved.savedAt).toBeDefined();
  });

  it('loads persisted schedules from disk on module startup', async () => {
    disk.schedules = [
      {
        id: 'sched_saved_1',
        prompt: 'persisted job',
        mode: 'llm',
        model: 'haiku',
        shellCmd: null,
        intervalMs: 60_000,
        nextRunAt: 60_000,
        channelId: 'ch1',
        userId: 'u1',
        createdAt: 0,
        lastRunAt: null,
        runCount: 0,
        maxRuns: 0,
        terminationPhrase: null,
        enabled: true,
      },
    ];

    const { listSchedules } = await freshMod();
    const loaded = listSchedules();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('sched_saved_1');
    expect(loaded[0].prompt).toBe('persisted job');
  });
});

// ─── 9. Overdue job fires on first tick after restart ────────────────────────
describe('overdue job after restart', () => {
  it('dispatches an overdue job on the first tick after module reload', async () => {
    disk.schedules = [
      {
        id: 'sched_overdue',
        prompt: 'missed check',
        mode: 'llm',
        model: 'haiku',
        shellCmd: null,
        intervalMs: 60_000,
        nextRunAt: -1_000, // was due 1s before t=0 (the fake epoch start)
        channelId: 'ch1',
        userId: 'u1',
        createdAt: -70_000,
        lastRunAt: null,
        runCount: 0,
        maxRuns: 0,
        terminationPhrase: null,
        enabled: true,
      },
    ];

    const { initScheduler, listSchedules } = await freshMod();
    expect(listSchedules()).toHaveLength(1); // confirmed loaded from disk

    const dispatch = vi.fn().mockResolvedValue({ text: '' });
    initScheduler(dispatch);

    // Advance one tick — the overdue job's nextRunAt(-1000) <= now(50) fires immediately
    await vi.advanceTimersByTimeAsync(TICK + 10);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'sched_overdue' }));
  });
});

// ─── 10. cancelSchedule (deleteSchedule) stops further firing ────────────────
describe('deleteSchedule', () => {
  it('removes the schedule and prevents any further dispatch', async () => {
    const { createSchedule, initScheduler, deleteSchedule, listSchedules } = await freshMod();
    const dispatch = vi.fn().mockResolvedValue({ text: '' });
    initScheduler(dispatch);

    const sched = createSchedule({ prompt: 'status', intervalMs: 1_000, channelId: 'c1', userId: 'u1' });
    deleteSchedule(sched.id);

    expect(listSchedules().find((s) => s.id === sched.id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

// ─── 11. listSchedules returns all active with nextRunAt ─────────────────────
describe('listSchedules', () => {
  it('returns all active schedules with correct nextRunAt', async () => {
    const { createSchedule, listSchedules } = await freshMod();

    createSchedule({ prompt: 'job A', intervalMs: 60_000, channelId: 'c1', userId: 'u1' });
    createSchedule({ prompt: 'job B', intervalMs: 120_000, channelId: 'c2', userId: 'u2' });

    const all = listSchedules();
    expect(all).toHaveLength(2);
    expect(all.find((s) => s.prompt === 'job A')?.nextRunAt).toBe(60_000); // t=0 + 60s
    expect(all.find((s) => s.prompt === 'job B')?.nextRunAt).toBe(120_000); // t=0 + 120s
  });
});

// ─── 12. Two overlapping schedules fire independently ────────────────────────
describe('concurrent schedules', () => {
  it('two schedules with different intervals fire independently without interfering', async () => {
    const { createSchedule, initScheduler } = await freshMod();
    const dispatch = vi.fn().mockResolvedValue({ text: '' });
    initScheduler(dispatch);

    const schedA = createSchedule({ prompt: 'A', intervalMs: 1_000, channelId: 'c1', userId: 'u1' });
    const schedB = createSchedule({ prompt: 'B', intervalMs: 3_000, channelId: 'c2', userId: 'u2' });

    // At t≈1.1s: A fires once (at t=1000), B hasn't (nextRunAt=3000)
    await vi.advanceTimersByTimeAsync(1_100);
    expect(dispatch.mock.calls.filter((c) => c[0].id === schedA.id)).toHaveLength(1);
    expect(dispatch.mock.calls.filter((c) => c[0].id === schedB.id)).toHaveLength(0);

    // At t≈3.1s: A fires twice more (at t=2000, t=3000), B fires once (at t=3000)
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dispatch.mock.calls.filter((c) => c[0].id === schedA.id)).toHaveLength(3);
    expect(dispatch.mock.calls.filter((c) => c[0].id === schedB.id)).toHaveLength(1);
  });
});
