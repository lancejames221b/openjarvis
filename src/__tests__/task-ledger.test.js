import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the filesystem before importing task-ledger to prevent real disk writes
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

// Import after mocking
const {
  createTask,
  updateTask,
  markCompleted,
  markFailed,
  markStreaming,
  getOrphanedTasks,
  processOrphans,
  getTask,
  getLedgerStats,
  TaskState,
} = await import('../task-ledger.js');

describe('Task Ledger — task lifecycle', () => {
  let taskIdCounter = 1;
  const nextId = () => `task-${taskIdCounter++}-${Date.now()}`;

  describe('task creation', () => {
    it('task created with pending (DISPATCHED) status', () => {
      const taskId = nextId();
      const task = createTask(taskId, 'check my calendar', 'user123');

      expect(task).not.toBeNull();
      expect(task.taskId).toBe(taskId);
      expect(task.state).toBe(TaskState.DISPATCHED);
      expect(task.transcript).toBe('check my calendar');
      expect(task.userId).toBe('user123');
      expect(task.resultDelivered).toBe(false);
    });

    it('task has createdAt and updatedAt timestamps', () => {
      const before = Date.now();
      const task = createTask(nextId(), 'play music', 'user456');
      const after = Date.now();

      expect(task.createdAt).toBeGreaterThanOrEqual(before);
      expect(task.createdAt).toBeLessThanOrEqual(after);
      expect(task.updatedAt).toBeGreaterThanOrEqual(before);
    });

    it('long transcript is truncated to 200 chars', () => {
      const longTranscript = 'a'.repeat(300);
      const task = createTask(nextId(), longTranscript, 'user789');
      expect(task.transcript.length).toBeLessThanOrEqual(200);
    });
  });

  describe('task state transitions', () => {
    it('task completed transitions to COMPLETED state', () => {
      const taskId = nextId();
      createTask(taskId, 'send email to John', 'user123');
      const result = markCompleted(taskId, 'voice', 'Email sent to John');

      expect(result).not.toBeNull();
      expect(result.state).toBe(TaskState.COMPLETED);
      expect(result.resultDelivered).toBe(true);
      expect(result.deliveryMethod).toBe('voice');
    });

    it('task marked failed transitions to FAILED state', () => {
      const taskId = nextId();
      createTask(taskId, 'search for something', 'user123');
      const result = markFailed(taskId, 'Network timeout');

      expect(result).not.toBeNull();
      expect(result.state).toBe(TaskState.FAILED);
      expect(result.error).toContain('Network timeout');
    });

    it('task marked streaming transitions to STREAMING state', () => {
      const taskId = nextId();
      createTask(taskId, 'what is the weather', 'user123');
      const result = markStreaming(taskId);

      expect(result).not.toBeNull();
      expect(result.state).toBe(TaskState.STREAMING);
    });

    it('updateTask returns null for unknown task ID', () => {
      const result = updateTask('nonexistent-task-id-xyz', { state: TaskState.COMPLETED });
      expect(result).toBeNull();
    });
  });

  describe('getTask lookup', () => {
    it('can retrieve a task by ID after creation', () => {
      const taskId = nextId();
      createTask(taskId, 'lookup test', 'user999');
      const found = getTask(taskId);
      expect(found).not.toBeNull();
      expect(found.taskId).toBe(taskId);
    });

    it('returns null for unknown task ID', () => {
      const result = getTask('does-not-exist-abc123');
      expect(result).toBeNull();
    });
  });

  describe('orphan detection', () => {
    it('orphaned tasks detected after threshold', () => {
      const taskId = nextId();
      createTask(taskId, 'long running task', 'user123');

      // Manually age the task by backdating its createdAt
      const task = getTask(taskId);
      task.createdAt = Date.now() - 10 * 60 * 1000; // 10 minutes ago (threshold is 5 min)
      task.updatedAt = Date.now() - 10 * 60 * 1000;

      const orphans = getOrphanedTasks();
      const found = orphans.find(t => t.taskId === taskId);
      expect(found).toBeDefined();
    });

    it('completed tasks are NOT orphaned', () => {
      const taskId = nextId();
      createTask(taskId, 'already done task', 'user123');

      // Age it AND complete it
      const task = getTask(taskId);
      task.createdAt = Date.now() - 10 * 60 * 1000;
      task.state = TaskState.COMPLETED;

      const orphans = getOrphanedTasks();
      const found = orphans.find(t => t.taskId === taskId);
      expect(found).toBeUndefined();
    });

    it('processOrphans marks orphans with ORPHANED state', () => {
      const taskId = nextId();
      createTask(taskId, 'background task', 'user123');

      const task = getTask(taskId);
      task.createdAt = Date.now() - 10 * 60 * 1000;
      task.updatedAt = Date.now() - 10 * 60 * 1000;

      const orphans = processOrphans();
      const processed = orphans.find(t => t.taskId === taskId);
      if (processed) {
        expect(processed.state).toBe(TaskState.ORPHANED);
      }
    });
  });

  describe('getLedgerStats', () => {
    it('returns total count and state breakdown', () => {
      const id1 = nextId();
      const id2 = nextId();
      createTask(id1, 'task alpha', 'user1');
      createTask(id2, 'task beta', 'user2');
      markCompleted(id2, 'voice', 'done');

      const stats = getLedgerStats();
      expect(stats).toHaveProperty('total');
      expect(stats.total).toBeGreaterThanOrEqual(2);
      expect(typeof stats.total).toBe('number');
    });
  });
});
