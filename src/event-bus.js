/**
 * event-bus.js — lightweight structured event emitter for the activity feed.
 *
 * emit(tag, msg, meta?)  — fire an event to all live SSE clients + ring buffer
 * Tags: VERIFY WAKE STT BRAIN TTS LEARN PERSONA MODEL GATE SVC
 */

import { EventEmitter } from 'events';

const RING_SIZE = 500;
const ring = [];
const bus = new EventEmitter();
bus.setMaxListeners(50);

function _now() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

export function emit(tag, msg, meta = {}) {
  const ev = { t: _now(), tag: String(tag).toUpperCase(), msg: String(msg), meta };
  ring.push(ev);
  if (ring.length > RING_SIZE) ring.shift();
  bus.emit('event', ev);
}

/** Returns a copy of the ring buffer (oldest first). */
export function getRingBuffer() {
  return ring.slice();
}

/** Subscribe to new events. Returns an unsubscribe function. */
export function subscribe(fn) {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}
