/**
 * Shared registry for in-flight voice-initiated tasks.
 * Keyed by taskId → { controller: AbortController, transcript, startTime, userId }
 * Imported by both index.js (to register tasks) and slash/spawn.js (so /stop can cancel them).
 */
export const voiceTasks = new Map();

/** Abort all active voice tasks. Returns count aborted. */
export function abortAllVoiceTasks() {
  let count = 0;
  for (const [, meta] of voiceTasks) {
    try { meta.controller.abort(); } catch {}
    count++;
  }
  voiceTasks.clear();
  return count;
}
