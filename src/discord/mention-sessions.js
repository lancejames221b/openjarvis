/**
 * Shared registry for in-flight non-verbose @mention responses.
 * Keyed by _parentChannelId → AbortController
 * Imported by both index.js and slash/spawn.js so /stop can suppress the reply.
 *
 * Note: this cannot cancel the underlying HTTP call to the gateway, but it
 * suppresses posting the reply back to Discord after the call returns.
 */
export const mentionSessions = new Map();
