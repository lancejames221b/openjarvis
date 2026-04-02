import logger from './logger.js';
/**
 * Bot State FSM - 4-state finite state machine replacing binary sleepMode
 *
 * States: ACTIVE, IDLE, SLEEP, ALERT
 * Priority tiers: P1 (critical) through P5 (info)
 *
 * Pure JS module, no dependencies.
 */

// ── States ───────────────────────────────────────────────────────────
export const STATES = Object.freeze({
  ACTIVE: 'ACTIVE',
  IDLE:   'IDLE',
  SLEEP:  'SLEEP',
  ALERT:  'ALERT',
});

// ── Priority Levels ──────────────────────────────────────────────────
export const PRIORITIES = Object.freeze({
  P1: 1,  // Critical: breach, outage, emergency
  P2: 2,  // High: failed, error, degraded
  P3: 3,  // Medium: complete, finished, result
  P4: 4,  // Low
  P5: 5,  // Info
});

// ── Valid Transitions ────────────────────────────────────────────────
const VALID_TRANSITIONS = {
  IDLE:   ['ACTIVE', 'SLEEP', 'ALERT'],
  ACTIVE: ['IDLE', 'SLEEP', 'ALERT'],
  SLEEP:  ['ACTIVE', 'ALERT'],
  ALERT:  ['ACTIVE', 'IDLE', 'SLEEP'],
};

// ── Internal State ───────────────────────────────────────────────────
let _state = STATES.IDLE;           // Boot into IDLE (wake word required)
let _previousState = STATES.IDLE;   // For ALERT return-to
let _lastTransition = Date.now();
let _listeners = [];

// ── Core API ─────────────────────────────────────────────────────────

export function getState() {
  return _state;
}

export function getStateInfo() {
  return {
    state: _state,
    previousState: _previousState,
    since: _lastTransition,
    age: Date.now() - _lastTransition,
  };
}

/**
 * Transition to a new state. Returns true if transition was valid.
 */
export function transition(newState, reason = '') {
  if (newState === _state) return true; // no-op

  const valid = VALID_TRANSITIONS[_state];
  if (!valid || !valid.includes(newState)) {
    logger.warn(`[FSM] Invalid transition: ${_state} -> ${newState} (reason: ${reason})`);
    return false;
  }

  const oldState = _state;

  // Save previous state for ALERT return-to
  if (newState === STATES.ALERT) {
    _previousState = oldState;
  }

  _state = newState;
  _lastTransition = Date.now();

  logger.info(`[FSM] ${oldState} -> ${newState} (${reason})`);

  // Fire listeners
  for (const cb of _listeners) {
    try { cb(oldState, newState, reason); } catch (e) {
      logger.error(`[FSM] Listener error: ${e.message}`);
    }
  }

  return true;
}

/**
 * Register a state change listener: (oldState, newState, reason) => {}
 */
export function onStateChange(cb) {
  _listeners.push(cb);
  return () => { _listeners = _listeners.filter(l => l !== cb); };
}

// ── Priority Classification ──────────────────────────────────────────

/**
 * Classify an alert into P1-P5 based on keywords, source, and explicit fields.
 * Returns a numeric priority level (1-5).
 */
export function classifyAlertPriority(alert) {
  const msg = (alert.message || '').toLowerCase();
  const src = (alert.source || '').toLowerCase();

  // Explicit priority passthrough
  if (alert.priorityLevel) return alert.priorityLevel;
  if (alert.priority === 'critical') return 1;
  if (alert.priority === 'urgent') return 2;

  // Keyword classification
  if (/\b(breach|compromised|down|outage|critical|emergency)\b/.test(msg)) return 1;
  if (/\b(failed|error|degraded|unreachable)\b/.test(msg)) return 2;
  if (/\b(complete|finished|done|result)\b/.test(msg)) return 3;
  if (alert.priority === 'low') return 4;
  if (alert.priority === 'info') return 5;

  // Source-based hints
  if (/security|threat|incident/.test(src)) return 2;
  if (/cron|scheduled|digest/.test(src)) return 4;

  return 3; // Default P3 for backward compat with 'normal'
}

// ── Voice Delivery Decision ──────────────────────────────────────────

/**
 * Can this priority level be delivered via voice in the current state?
 */
export function canDeliverVoiceAlert(priority) {
  switch (_state) {
    case STATES.ACTIVE: return priority <= 3;  // P1-P3 in ACTIVE
    case STATES.IDLE:   return priority <= 2;  // P1-P2 in IDLE
    case STATES.SLEEP:  return priority <= 2;  // P1-P2 break through SLEEP
    case STATES.ALERT:  return priority <= 1;  // Only P1 interrupts active alert
    default: return false;
  }
}

// ── Backward Compatibility Shims ─────────────────────────────────────

/**
 * Legacy compat: returns true if state is SLEEP.
 */
export function isSleepMode() {
  return _state === STATES.SLEEP;
}

/**
 * Legacy compat: set sleep mode on/off.
 */
export function setSleepMode(val) {
  if (val && _state !== STATES.SLEEP) {
    transition(STATES.SLEEP, 'compat-setSleepMode');
  } else if (!val && _state === STATES.SLEEP) {
    transition(STATES.ACTIVE, 'compat-setSleepMode');
  }
}
