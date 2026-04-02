import { describe, it, expect, beforeEach } from 'vitest';
import { getState, transition, onStateChange, STATES } from '../bot-state.js';

// Reset FSM state before each test by forcing transition to a known state
function resetToState(targetState) {
  // Force reset via internal transitions — go to SLEEP first (always valid from ACTIVE/IDLE)
  const current = getState();
  if (current === targetState) return;

  // Build a path to IDLE as a neutral starting point
  if (current === 'SLEEP') {
    transition('ACTIVE', 'test-reset');
    transition('IDLE', 'test-reset');
  } else if (current === 'ACTIVE') {
    transition('IDLE', 'test-reset');
  } else if (current === 'ALERT') {
    transition('ACTIVE', 'test-reset');
    transition('IDLE', 'test-reset');
  }

  if (getState() !== targetState) {
    transition(targetState, 'test-reset');
  }
}

describe('FSM — bot-state.js', () => {
  beforeEach(() => {
    resetToState('IDLE');
  });

  describe('valid transitions', () => {
    it('IDLE → ACTIVE (wake word)', () => {
      expect(getState()).toBe('IDLE');
      const result = transition('ACTIVE', 'wake-word');
      expect(result).toBe(true);
      expect(getState()).toBe('ACTIVE');
    });

    it('ACTIVE → SLEEP (sleep command)', () => {
      transition('ACTIVE', 'wake-word');
      const result = transition('SLEEP', 'sleep-command');
      expect(result).toBe(true);
      expect(getState()).toBe('SLEEP');
    });

    it('IDLE → SLEEP (inactivity timeout)', () => {
      expect(getState()).toBe('IDLE');
      const result = transition('SLEEP', 'idle-timeout');
      expect(result).toBe(true);
      expect(getState()).toBe('SLEEP');
    });

    it('SLEEP → ACTIVE (wake from sleep)', () => {
      transition('SLEEP', 'test');
      const result = transition('ACTIVE', 'wake-word');
      expect(result).toBe(true);
      expect(getState()).toBe('ACTIVE');
    });

    it('ACTIVE → IDLE (active timeout)', () => {
      transition('ACTIVE', 'test');
      const result = transition('IDLE', 'active-timeout');
      expect(result).toBe(true);
      expect(getState()).toBe('IDLE');
    });
  });

  describe('invalid transitions are rejected', () => {
    it('SLEEP → IDLE is not a valid direct transition', () => {
      transition('SLEEP', 'test');
      const result = transition('IDLE', 'invalid');
      expect(result).toBe(false);
      expect(getState()).toBe('SLEEP');
    });

    it('transition to same state is a no-op (returns true)', () => {
      expect(getState()).toBe('IDLE');
      const result = transition('IDLE', 'no-op');
      expect(result).toBe(true);
      expect(getState()).toBe('IDLE');
    });

    it('unknown state is rejected', () => {
      const result = transition('UNKNOWN_STATE', 'invalid');
      expect(result).toBe(false);
      expect(getState()).toBe('IDLE');
    });
  });

  describe('transition callbacks', () => {
    it('fires listener on valid transition', () => {
      let fired = false;
      let capturedOld, capturedNew, capturedReason;

      const unsubscribe = onStateChange((old, next, reason) => {
        fired = true;
        capturedOld = old;
        capturedNew = next;
        capturedReason = reason;
      });

      transition('ACTIVE', 'test-callback');

      expect(fired).toBe(true);
      expect(capturedOld).toBe('IDLE');
      expect(capturedNew).toBe('ACTIVE');
      expect(capturedReason).toBe('test-callback');

      unsubscribe();
    });

    it('does NOT fire listener on invalid transition', () => {
      let fired = false;
      const unsubscribe = onStateChange(() => { fired = true; });

      transition('SLEEP', 'setup');
      fired = false; // reset after setup transition
      transition('IDLE', 'invalid'); // SLEEP → IDLE is invalid

      expect(fired).toBe(false);
      unsubscribe();
    });

    it('does NOT fire listener on same-state no-op', () => {
      let fireCount = 0;
      const unsubscribe = onStateChange(() => { fireCount++; });

      transition('IDLE', 'no-op');

      expect(fireCount).toBe(0);
      unsubscribe();
    });

    it('unsubscribe removes the listener', () => {
      let fireCount = 0;
      const unsubscribe = onStateChange(() => { fireCount++; });

      transition('ACTIVE', 'first');
      expect(fireCount).toBe(1);

      unsubscribe();

      transition('IDLE', 'second');
      expect(fireCount).toBe(1); // no additional fires
    });
  });

  describe('ALERT state', () => {
    it('ACTIVE → ALERT is valid', () => {
      transition('ACTIVE', 'test');
      const result = transition('ALERT', 'p1-alert');
      expect(result).toBe(true);
      expect(getState()).toBe('ALERT');
    });

    it('IDLE → ALERT is valid', () => {
      const result = transition('ALERT', 'p2-alert');
      expect(result).toBe(true);
      expect(getState()).toBe('ALERT');
    });

    it('ALERT → ACTIVE returns to normal', () => {
      transition('ALERT', 'test');
      const result = transition('ACTIVE', 'alert-cleared');
      expect(result).toBe(true);
      expect(getState()).toBe('ACTIVE');
    });
  });
});
