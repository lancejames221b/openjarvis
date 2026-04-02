/**
 * alert-context.js — Shared alert context state
 * Tracks the most recent /speak alert so voice turns can inject it as context.
 * TTL: 5 minutes (alert context expires if not responded to)
 */

const TTL_MS = 5 * 60 * 1000; // 5 minutes

let _alert = null; // { text, ts }

export function setActiveAlert(text) {
  _alert = { text, ts: Date.now() };
}

export function getActiveAlert() {
  if (!_alert) return null;
  if (Date.now() - _alert.ts > TTL_MS) {
    _alert = null;
    return null;
  }
  return _alert.text;
}

export function clearActiveAlert() {
  _alert = null;
}
