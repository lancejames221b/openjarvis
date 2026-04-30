/**
 * Task Ledger — Persistent promise tracking for voice tasks
 * 
 * Every voice command creates a ledger entry. The entry tracks:
 * - What was asked
 * - When it was dispatched
 * - Whether a result was delivered
 * - How it was delivered (voice, text, DM)
 * 
 * On startup, checks for orphaned tasks (dispatched but never completed)
 * and escalates them.
 * 
 * Storage: JSON file (simple, no deps, survives restarts)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const LEDGER_PATH = join(DATA_DIR, 'task-ledger.json');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// Task states
export const TaskState = {
  DISPATCHED: 'dispatched',     // Sent to gateway, awaiting response
  STREAMING: 'streaming',       // Receiving streaming response
  STREAM_DONE: 'stream_done',   // Streaming complete (ack spoken)
  WORKING: 'working',           // Gateway doing tool calls (post-stream)
  COMPLETED: 'completed',       // Result delivered to user
  FAILED: 'failed',             // Task failed
  ORPHANED: 'orphaned',         // Found on startup with no completion
  ESCALATED: 'escalated',       // Orphan escalated to user
};

// Tiered orphan thresholds based on task state (Issue #5)
// DISPATCHED = gateway never acked → something is wrong fast
// STREAM_DONE = ack spoken but no result → standard timeout
// WORKING = confirmed background work (sub-agents, research) → long timeout
const DISPATCHED_ORPHAN_MS = parseInt(process.env.TASK_DISPATCHED_ORPHAN_MS ?? '120000');   // 2 min
const ORPHAN_THRESHOLD_MS = parseInt(process.env.TASK_ORPHAN_THRESHOLD_MS ?? '300000');      // 5 min
const WORKING_ORPHAN_MS = parseInt(process.env.TASK_WORKING_ORPHAN_MS ?? '1800000');         // 30 min
// How long to keep completed tasks in ledger (1 hour)
const COMPLETED_TTL_MS = 60 * 60 * 1000;
// Max ledger entries to prevent unbounded growth
const MAX_ENTRIES = parseInt(process.env.TASK_LEDGER_MAX ?? '100');

let ledger = loadLedger();

/**
 * Load ledger from disk
 */
function loadLedger() {
  try {
    if (existsSync(LEDGER_PATH)) {
      const data = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
      return data.tasks || [];
    }
  } catch (err) {
    logger.error('Failed to load task ledger:', err.message);
  }
  return [];
}

/**
 * Save ledger to disk (debounced)
 */
let saveTimeout = null;
function saveLedger() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      writeFileSync(LEDGER_PATH, JSON.stringify({ tasks: ledger, savedAt: new Date().toISOString() }, null, 2));
    } catch (err) {
      logger.error('Failed to save task ledger:', err.message);
    }
  }, 500);
}

/**
 * Prune old completed/escalated entries
 */
function pruneOld() {
  const now = Date.now();
  const before = ledger.length;
  ledger = ledger.filter(t => {
    if (t.state === TaskState.COMPLETED || t.state === TaskState.ESCALATED || t.state === TaskState.FAILED) {
      return now - t.updatedAt < COMPLETED_TTL_MS;
    }
    // Orphaned and working tasks also expire (after 2x the completed TTL)
    if (t.state === TaskState.ORPHANED || t.state === TaskState.WORKING) {
      return now - t.updatedAt < COMPLETED_TTL_MS * 2;
    }
    return true;
  });
  // Hard cap: when over limit, prefer dropping orphaned/working entries first
  if (ledger.length > MAX_ENTRIES) {
    const pruneable = ledger.filter(t => t.state === TaskState.ORPHANED || t.state === TaskState.WORKING);
    const keepers = ledger.filter(t => t.state !== TaskState.ORPHANED && t.state !== TaskState.WORKING);
    if (keepers.length <= MAX_ENTRIES) {
      // Drop orphaned/working to fit, then hard-slice keepers if still over
      ledger = keepers.concat(pruneable.slice(-(MAX_ENTRIES - keepers.length)));
    } else {
      ledger = keepers.slice(-MAX_ENTRIES);
    }
  }
  if (ledger.length !== before) saveLedger();
}

/**
 * Create a new task entry when a voice command is dispatched
 */
export function createTask(taskId, transcript, userId) {
  const entry = {
    taskId,
    transcript: transcript.substring(0, 200),
    userId,
    state: TaskState.DISPATCHED,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    streamComplete: false,
    resultDelivered: false,
    deliveryMethod: null,     // 'voice', 'text', 'dm', 'speak-endpoint'
    resultSummary: null,
    error: null,
  };
  ledger.push(entry);
  saveLedger();
  logger.info(`📋 Ledger: Task #${taskId} created — "${transcript.substring(0, 60)}..."`);
  return entry;
}

/**
 * Update task state
 */
export function updateTask(taskId, updates) {
  const task = ledger.find(t => t.taskId === taskId);
  if (!task) {
    logger.warn(`📋 Ledger: Task #${taskId} not found for update`);
    return null;
  }
  Object.assign(task, updates, { updatedAt: Date.now() });
  saveLedger();
  return task;
}

/**
 * Mark task as streaming (first tokens received)
 */
export function markStreaming(taskId) {
  return updateTask(taskId, { state: TaskState.STREAMING });
}

/**
 * Mark streaming done — the spoken ack has been delivered
 * But the gateway may still be doing tool calls
 */
export function markStreamDone(taskId, spokenText) {
  return updateTask(taskId, {
    state: TaskState.STREAM_DONE,
    streamComplete: true,
    resultSummary: spokenText?.substring(0, 300),
  });
}

/**
 * Check if the streaming response was just an acknowledgment
 * (short response suggesting work is happening in background)
 */
export function isJustAck(text) {
  if (!text) return true;
  const clean = text.trim();
  
  // Very short responses are likely acks — but only below the micro-answer threshold.
  // Raised from 80→40: answers like "The capital is Paris." are complete, not acks.
  if (clean.length < 40) return true;
  
  // Short responses with explicit delegation/async-work language.
  // Intentionally narrow: "I'll keep that in mind" and "I'm creating X" are NOT acks.
  // Retained words only trigger if they indicate spawned background work, not inline info.
  if (clean.length < 200 && /\b(on it|working on it|let me check|let me look|let me find|let me get|setting up|installing)\b/i.test(clean)) {
    return true;
  }
  // "I'll" only counts as an ack when paired with a specific callback verb
  if (clean.length < 200 && /\bi'll\s+(ping|let you know|notify|report|get back|circle back|check on|look into|follow up)\b/i.test(clean)) {
    return true;
  }
  
  // Future-tense promise detection — regardless of length
  // Catches "Phase 2's running. I'll ping you when it's done" (>200 chars but still an ack)
  const PROMISE_PATTERNS = [
    /\bi'll\s+(ping|let you know|notify|report|get back|update you|circle back)\b/i,
    /\b(ping|notify|update)\s+you\s+when\b/i,
    /\bwhen\s+(it's|its|it is)\s+(done|ready|complete|finished)\b/i,
    /\b(kicked? off|running|spawned|dispatched|started)\b.*\b(now|right now|phase)\b/i,
    /\b(kicking off|spinning up|firing up|launching)\b/i,
  ];
  
  const hasPromise = PROMISE_PATTERNS.some(p => p.test(clean));
  
  // If it contains a future promise AND no actual data/results, it's an ack
  // "Actual results" = code blocks, bullet lists, specific data
  if (hasPromise) {
    const hasResults = /```|^\s*[-*]\s+\S/m.test(clean) || clean.length > 800;
    if (!hasResults) return true;
  }
  
  return false;
}

/**
 * Mark task as having a pending background operation
 * (streaming response was just an ack, real work is still happening)
 */
export function markWorking(taskId) {
  return updateTask(taskId, { state: TaskState.WORKING });
}

/**
 * Mark task as completed with result delivered
 */
export function markCompleted(taskId, deliveryMethod, resultSummary) {
  return updateTask(taskId, {
    state: TaskState.COMPLETED,
    resultDelivered: true,
    deliveryMethod,
    resultSummary: resultSummary?.substring(0, 300),
  });
}

/**
 * Mark task as failed
 */
export function markFailed(taskId, error) {
  return updateTask(taskId, {
    state: TaskState.FAILED,
    error: error?.substring(0, 200),
  });
}

/**
 * Get all tasks that look orphaned (dispatched/working but no result after threshold).
 *
 * Grace delay: also requires updatedAt to be stale by GRACE_MS. A task that just
 * got a streaming delta or state update is almost certainly still alive — the
 * completion handler is probably milliseconds away from landing. Firing "Lost
 * task" in that window caused false positives that posted right before or after
 * the actual completion message.
 */
const ORPHAN_GRACE_MS = parseInt(process.env.TASK_ORPHAN_GRACE_MS ?? '15000'); // 15s

export function getOrphanedTasks() {
  const now = Date.now();
  return ledger.filter(t => {
    if (t.state === TaskState.COMPLETED || t.state === TaskState.FAILED ||
        t.state === TaskState.ESCALATED || t.state === TaskState.ORPHANED) {
      return false;
    }
    // Require stale updatedAt — even if createdAt is old, a recent update
    // (streaming delta, state transition) means the task is actively progressing.
    if (now - (t.updatedAt || t.createdAt) < ORPHAN_GRACE_MS) return false;

    // Tiered thresholds based on task state (Issue #5)
    const age = now - t.createdAt;
    switch (t.state) {
      case TaskState.DISPATCHED:
        // Gateway never responded — 2 min is plenty
        return age > DISPATCHED_ORPHAN_MS;
      case TaskState.WORKING:
        // Confirmed background work (sub-agents, research) — 30 min
        return age > WORKING_ORPHAN_MS;
      case TaskState.STREAMING:
      case TaskState.STREAM_DONE:
      default:
        // Standard threshold — 5 min
        return age > ORPHAN_THRESHOLD_MS;
    }
  });
}

/**
 * Get tasks that are in STREAM_DONE state and the response was just an ack
 * These need follow-up — the gateway said "On it" but we never got results
 */
export function getPendingFollowups() {
  const now = Date.now();
  const FOLLOWUP_THRESHOLD_MS = parseInt(process.env.TASK_FOLLOWUP_THRESHOLD_MS ?? '120000');
  return ledger.filter(t => {
    if (t.state !== TaskState.STREAM_DONE && t.state !== TaskState.WORKING) return false;
    return now - t.updatedAt > FOLLOWUP_THRESHOLD_MS;
  });
}

/**
 * Mark orphaned tasks and return them for escalation.
 *
 * Double-checks each candidate's state right before mutating, so a completion
 * that landed between getOrphanedTasks() and the state write doesn't get
 * stomped. Only candidates still in a non-terminal state get flipped to
 * ORPHANED and returned to the caller for user notification.
 */
export function processOrphans() {
  const candidates = getOrphanedTasks();
  const orphans = [];
  for (const task of candidates) {
    // Re-check: task may have completed between filter and mutation
    if (task.state === TaskState.COMPLETED || task.state === TaskState.FAILED ||
        task.state === TaskState.ESCALATED || task.state === TaskState.ORPHANED) {
      continue;
    }
    task.state = TaskState.ORPHANED;
    task.updatedAt = Date.now();
    orphans.push(task);
  }
  if (orphans.length > 0) saveLedger();
  return orphans;
}

/**
 * Mark a task as escalated (user was notified about the orphan)
 */
export function markEscalated(taskId) {
  return updateTask(taskId, { state: TaskState.ESCALATED });
}

/**
 * Get active tasks (not completed, failed, or escalated)
 */
export function getActiveTasks() {
  return ledger.filter(t => 
    t.state !== TaskState.COMPLETED && 
    t.state !== TaskState.FAILED && 
    t.state !== TaskState.ESCALATED
  );
}

/**
 * Get task by ID
 */
export function getTask(taskId) {
  return ledger.find(t => t.taskId === taskId) || null;
}

/**
 * Get ledger stats
 */
export function getLedgerStats() {
  const counts = {};
  for (const task of ledger) {
    counts[task.state] = (counts[task.state] || 0) + 1;
  }
  return { total: ledger.length, ...counts };
}

/**
 * Startup reconciliation — find orphans from previous run
 */
export function reconcileOnStartup() {
  pruneOld();
  const orphans = processOrphans();
  const pending = getPendingFollowups();
  
  if (orphans.length > 0) {
    logger.info(`📋 Ledger: Found ${orphans.length} orphaned tasks from previous run`);
    for (const task of orphans) {
      logger.info(`  ❗ Task #${task.taskId}: "${task.transcript}" (${task.state})`);
    }
  }
  
  if (pending.length > 0) {
    logger.info(`📋 Ledger: Found ${pending.length} tasks awaiting follow-up`);
    for (const task of pending) {
      logger.info(`  ⏳ Task #${task.taskId}: "${task.transcript}" (${task.state})`);
    }
  }
  
  return { orphans, pending };
}
