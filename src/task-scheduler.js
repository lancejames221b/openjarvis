import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const SCHEDULES_PATH = join(DATA_DIR, 'schedules.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

let schedules = loadSchedules();
let _dispatchFn = null;

function loadSchedules() {
  try {
    if (existsSync(SCHEDULES_PATH)) {
      const data = JSON.parse(readFileSync(SCHEDULES_PATH, 'utf8'));
      return data.schedules || [];
    }
  } catch (err) {
    logger.error('[scheduler] Failed to load schedules:', err.message);
  }
  return [];
}

let _saveTimeout = null;
function saveSchedules() {
  if (_saveTimeout) clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => {
    try {
      writeFileSync(SCHEDULES_PATH, JSON.stringify({ schedules, savedAt: new Date().toISOString() }, null, 2));
    } catch (err) {
      logger.error('[scheduler] Failed to save schedules:', err.message);
    }
  }, 500);
}

async function tick() {
  const now = Date.now();
  const due = schedules.filter(s => s.enabled && s.nextRunAt <= now);
  for (const sched of due) {
    sched.nextRunAt = now + sched.intervalMs;
    sched.lastRunAt = now;
    sched.runCount++;
    saveSchedules();
    try {
      const result = await _dispatchFn(sched);
      if (sched.terminationPhrase && result?.text?.toLowerCase().includes(sched.terminationPhrase.toLowerCase())) {
        deleteSchedule(sched.id);
        return;
      }
      if (sched.maxRuns > 0 && sched.runCount >= sched.maxRuns) {
        deleteSchedule(sched.id);
      }
    } catch (err) {
      logger.warn(`[scheduler] tick error ${sched.id}: ${err.message}`);
    }
  }
}

export function initScheduler(dispatchFn) {
  _dispatchFn = dispatchFn;
  const tickMs = parseInt(process.env.SCHEDULER_TICK_MS || '30000');
  setInterval(tick, tickMs);
  logger.info(`[scheduler] started — ${schedules.length} schedule(s) loaded, tick every ${tickMs}ms`);
}

export function createSchedule({ prompt, intervalMs, channelId, userId, terminationPhrase, maxRuns, mode, model, shellCmd }) {
  const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const entry = {
    id,
    prompt,
    mode: mode || 'llm',           // 'shell' | 'llm'
    model: model || 'haiku',       // gateway model alias for llm mode
    shellCmd: shellCmd || null,    // shell command string for shell mode
    intervalMs,
    nextRunAt: Date.now() + intervalMs,
    channelId,
    userId,
    createdAt: Date.now(),
    lastRunAt: null,
    runCount: 0,
    maxRuns: maxRuns || 0,
    terminationPhrase: terminationPhrase || null,
    enabled: true,
  };
  schedules.push(entry);
  saveSchedules();
  logger.info(`[scheduler] created ${id} — every ${intervalMs}ms, prompt: "${prompt.substring(0, 60)}"`);
  return entry;
}

export function listSchedules() {
  return schedules;
}

export function deleteSchedule(id) {
  const before = schedules.length;
  schedules = schedules.filter(s => s.id !== id);
  if (schedules.length !== before) {
    saveSchedules();
    logger.info(`[scheduler] deleted ${id}`);
  }
}

export function pauseSchedule(id) {
  const s = schedules.find(s => s.id === id);
  if (s) { s.enabled = false; saveSchedules(); }
}

export function resumeSchedule(id) {
  const s = schedules.find(s => s.id === id);
  if (s) { s.enabled = true; saveSchedules(); }
}
