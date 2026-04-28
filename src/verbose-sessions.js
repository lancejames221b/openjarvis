/**
 * Shared registry for in-flight verbose text-channel streams.
 * Keyed by parentChannelId → { ac: AbortController, ls: LiveStream }
 * Imported by both index.js and slash/spawn.js so /stop can cancel them.
 */
export const verboseSessions = new Map();
