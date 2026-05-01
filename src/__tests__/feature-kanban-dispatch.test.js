import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks must be declared before imports ────────────────────────────
vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../focus-state.js', () => ({
  isKanbanChannel: vi.fn(() => false),
  getKanbanPath: vi.fn(() => null),
}));

import { tryKanbanDispatch } from '../kanban-dispatch.js';
import * as focusState from '../focus-state.js';

const KANBAN_CHANNEL = 'chan-kanban';
const NON_KANBAN_CHANNEL = 'chan-other';
const PROJECT_PATH = '/home/yari/Dev/example';

function makeExecMock(stdout, stderr = '') {
  return vi.fn(async () => ({ stdout, stderr }));
}

function makeFailingExecMock(stderrText) {
  return vi.fn(async () => {
    const err = new Error('exec failed');
    err.stdout = '';
    err.stderr = stderrText;
    throw err;
  });
}

describe('kanban-dispatch — tryKanbanDispatch()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    focusState.isKanbanChannel.mockImplementation((id) => id === KANBAN_CHANNEL);
    focusState.getKanbanPath.mockImplementation((id) =>
      id === KANBAN_CHANNEL ? PROJECT_PATH : null
    );
  });

  // ── Non-Kanban channel: never handles ─────────────────────────────
  describe('non-Kanban channel', () => {
    it('returns handled=false for "create a task: foo" in non-Kanban channel', async () => {
      const exec = makeExecMock('');
      const result = await tryKanbanDispatch(
        'create a task: fix the login bug',
        NON_KANBAN_CHANNEL,
        { exec }
      );
      expect(result.handled).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });

    it('returns handled=false for "show the board" in non-Kanban channel', async () => {
      const exec = makeExecMock('');
      const result = await tryKanbanDispatch('show the board', NON_KANBAN_CHANNEL, { exec });
      expect(result.handled).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });

    it('returns handled=false even for unrecognized text in non-Kanban channel', async () => {
      const exec = makeExecMock('');
      const result = await tryKanbanDispatch('what is the weather', NON_KANBAN_CHANNEL, { exec });
      expect(result.handled).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });
  });

  // ── Kanban channel: create task ───────────────────────────────────
  describe('create task', () => {
    it('"create a task: fix the login bug" → handled=true, CLI called with correct args', async () => {
      const cliJson = JSON.stringify({ ok: true, task: { id: 'abc12', prompt: 'fix the login bug' } });
      const exec = makeExecMock(cliJson);
      const result = await tryKanbanDispatch(
        'create a task: fix the login bug',
        KANBAN_CHANNEL,
        { exec }
      );

      expect(result.handled).toBe(true);
      expect(exec).toHaveBeenCalledOnce();
      const [bin, args] = exec.mock.calls[0];
      expect(bin).toBe('node');
      expect(args).toContain('task');
      expect(args).toContain('create');
      const titleIdx = args.indexOf('--title');
      expect(args[titleIdx + 1]).toBe('fix the login bug');
      const promptIdx = args.indexOf('--prompt');
      expect(args[promptIdx + 1]).toBe('fix the login bug');
      const projIdx = args.indexOf('--project-path');
      expect(args[projIdx + 1]).toBe(PROJECT_PATH);

      expect(result.result).toContain('Task created');
      expect(result.result).toContain('fix the login bug');
      expect(result.result).toContain('abc12');
    });

    it('"new task: write docs" matches the create pattern', async () => {
      const cliJson = JSON.stringify({ ok: true, task: { id: 'xyz99', prompt: 'write docs' } });
      const exec = makeExecMock(cliJson);
      const result = await tryKanbanDispatch('new task: write docs', KANBAN_CHANNEL, { exec });

      expect(result.handled).toBe(true);
      const [, args] = exec.mock.calls[0];
      expect(args[args.indexOf('--title') + 1]).toBe('write docs');
    });

    it('"create task: foo" (without "a") matches the create pattern', async () => {
      const cliJson = JSON.stringify({ ok: true, task: { id: 'foo01', prompt: 'foo' } });
      const exec = makeExecMock(cliJson);
      const result = await tryKanbanDispatch('create task: foo', KANBAN_CHANNEL, { exec });

      expect(result.handled).toBe(true);
    });

    it('exposes a brief voice summary for the create result', async () => {
      const cliJson = JSON.stringify({ ok: true, task: { id: 'abc12', prompt: 'fix the login bug' } });
      const exec = makeExecMock(cliJson);
      const result = await tryKanbanDispatch(
        'create a task: fix the login bug',
        KANBAN_CHANNEL,
        { exec }
      );
      expect(result.voice).toBe('Created task: fix the login bug');
    });
  });

  // ── Kanban channel: list / show board ─────────────────────────────
  describe('show board', () => {
    const sampleBoard = JSON.stringify({
      ok: true,
      tasks: [
        { id: 'a1', prompt: 'do thing one', column: 'backlog' },
        { id: 'b2', prompt: 'do thing two', column: 'in_progress' },
        { id: 'c3', prompt: 'do thing three', column: 'review' },
        { id: 'd4', prompt: 'old thing', column: 'trash' },
      ],
    });

    it('"show the board" → handled=true, CLI called with task list', async () => {
      const exec = makeExecMock(sampleBoard);
      const result = await tryKanbanDispatch('show the board', KANBAN_CHANNEL, { exec });

      expect(result.handled).toBe(true);
      expect(exec).toHaveBeenCalledOnce();
      const [, args] = exec.mock.calls[0];
      expect(args).toContain('task');
      expect(args).toContain('list');
      expect(args).not.toContain('--column');
    });

    it('list output includes Backlog / In Progress / Review / Trash sections', async () => {
      const exec = makeExecMock(sampleBoard);
      const result = await tryKanbanDispatch('show the board', KANBAN_CHANNEL, { exec });

      expect(result.result).toContain('Backlog');
      expect(result.result).toContain('In Progress');
      expect(result.result).toContain('Review');
      expect(result.result).toContain('Trash');
      expect(result.result).toContain('do thing one');
      expect(result.result).toContain('do thing two');
    });

    it('list output is wrapped in a Discord code block', async () => {
      const exec = makeExecMock(sampleBoard);
      const result = await tryKanbanDispatch('show the board', KANBAN_CHANNEL, { exec });
      expect(result.result.startsWith('```')).toBe(true);
      expect(result.result.endsWith('```')).toBe(true);
    });

    it('"kanban status" matches the list pattern', async () => {
      const exec = makeExecMock(sampleBoard);
      const result = await tryKanbanDispatch('kanban status', KANBAN_CHANNEL, { exec });
      expect(result.handled).toBe(true);
    });

    it('"board status" matches the list pattern', async () => {
      const exec = makeExecMock(sampleBoard);
      const result = await tryKanbanDispatch('board status', KANBAN_CHANNEL, { exec });
      expect(result.handled).toBe(true);
    });

    it('"list tasks" matches the list pattern', async () => {
      const exec = makeExecMock(sampleBoard);
      const result = await tryKanbanDispatch('list tasks', KANBAN_CHANNEL, { exec });
      expect(result.handled).toBe(true);
    });
  });

  // ── Kanban channel: column-filtered list ──────────────────────────
  describe('column-filtered list', () => {
    it('"show backlog" → CLI called with --column backlog', async () => {
      const exec = makeExecMock(JSON.stringify({ ok: true, tasks: [] }));
      const result = await tryKanbanDispatch('show backlog', KANBAN_CHANNEL, { exec });

      expect(result.handled).toBe(true);
      const [, args] = exec.mock.calls[0];
      const colIdx = args.indexOf('--column');
      expect(args[colIdx + 1]).toBe('backlog');
    });

    it('"what\'s in backlog" matches the backlog pattern', async () => {
      const exec = makeExecMock(JSON.stringify({ ok: true, tasks: [] }));
      const result = await tryKanbanDispatch("what's in backlog", KANBAN_CHANNEL, { exec });
      expect(result.handled).toBe(true);
      const [, args] = exec.mock.calls[0];
      expect(args[args.indexOf('--column') + 1]).toBe('backlog');
    });

    it('"what\'s in progress" → CLI called with --column in_progress', async () => {
      const exec = makeExecMock(JSON.stringify({ ok: true, tasks: [] }));
      const result = await tryKanbanDispatch("what's in progress", KANBAN_CHANNEL, { exec });
      expect(result.handled).toBe(true);
      const [, args] = exec.mock.calls[0];
      expect(args[args.indexOf('--column') + 1]).toBe('in_progress');
    });

    it('"active tasks" matches the in-progress pattern', async () => {
      const exec = makeExecMock(JSON.stringify({ ok: true, tasks: [] }));
      const result = await tryKanbanDispatch('active tasks', KANBAN_CHANNEL, { exec });
      expect(result.handled).toBe(true);
      const [, args] = exec.mock.calls[0];
      expect(args[args.indexOf('--column') + 1]).toBe('in_progress');
    });
  });

  // ── Kanban channel: start task ────────────────────────────────────
  describe('start task', () => {
    it('"start task abc12" → CLI called with --task-id abc12', async () => {
      const exec = makeExecMock(JSON.stringify({ ok: true, task: { id: 'abc12', prompt: 'fix login' } }));
      const result = await tryKanbanDispatch('start task abc12', KANBAN_CHANNEL, { exec });

      expect(result.handled).toBe(true);
      const [, args] = exec.mock.calls[0];
      expect(args).toContain('start');
      expect(args[args.indexOf('--task-id') + 1]).toBe('abc12');
      expect(result.result).toContain('Started task');
      expect(result.result).toContain('fix login');
    });
  });

  // ── Kanban channel: trash task ────────────────────────────────────
  describe('trash task', () => {
    it('"trash task abc12" → CLI called with trash --task-id abc12', async () => {
      const exec = makeExecMock(JSON.stringify({ ok: true }));
      const result = await tryKanbanDispatch('trash task abc12', KANBAN_CHANNEL, { exec });

      expect(result.handled).toBe(true);
      const [, args] = exec.mock.calls[0];
      expect(args).toContain('trash');
      expect(args[args.indexOf('--task-id') + 1]).toBe('abc12');
    });

    it('"done with task abc12" matches the trash pattern', async () => {
      const exec = makeExecMock(JSON.stringify({ ok: true }));
      const result = await tryKanbanDispatch('done with task abc12', KANBAN_CHANNEL, { exec });
      expect(result.handled).toBe(true);
      const [, args] = exec.mock.calls[0];
      expect(args).toContain('trash');
      expect(args[args.indexOf('--task-id') + 1]).toBe('abc12');
    });
  });

  // ── Falls through on unrecognized input ───────────────────────────
  describe('unrecognized input', () => {
    it('"hello there" in Kanban channel → handled=false', async () => {
      const exec = makeExecMock('');
      const result = await tryKanbanDispatch('hello there', KANBAN_CHANNEL, { exec });
      expect(result.handled).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });

    it('empty transcript → handled=false', async () => {
      const exec = makeExecMock('');
      const result = await tryKanbanDispatch('   ', KANBAN_CHANNEL, { exec });
      expect(result.handled).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });

    it('"create a task" with no colon/title → handled=false', async () => {
      const exec = makeExecMock('');
      const result = await tryKanbanDispatch('create a task', KANBAN_CHANNEL, { exec });
      expect(result.handled).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });
  });

  // ── CLI failure handling ──────────────────────────────────────────
  describe('CLI failure', () => {
    it('CLI error returns handled=true with an error message (still consumed)', async () => {
      const exec = makeFailingExecMock('boom');
      const result = await tryKanbanDispatch(
        'create a task: foo',
        KANBAN_CHANNEL,
        { exec }
      );
      expect(result.handled).toBe(true);
      expect(result.result.toLowerCase()).toContain('failed');
    });

    it('CLI returns ok=false JSON → handled=true with error', async () => {
      const exec = makeExecMock(JSON.stringify({ ok: false, error: 'workspace not registered' }));
      const result = await tryKanbanDispatch(
        'create a task: foo',
        KANBAN_CHANNEL,
        { exec }
      );
      expect(result.handled).toBe(true);
      expect(result.result.toLowerCase()).toContain('workspace not registered');
    });
  });
});
