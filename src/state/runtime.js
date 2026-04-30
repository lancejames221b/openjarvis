/**
 * runtime.js — Shared mutable runtime state for index.js subsystems.
 *
 * All module-level state that was previously declared in index.js and shared
 * across multiple functions now lives here as a single mutable object or
 * plain exported binding. Any module can import and mutate these directly.
 *
 * Variable mapping from old index.js names:
 *   activeTasks                  → activeTasks (same)
 *   conversations                → conversations (same)
 *   userSpeaking                 → userSpeaking (same)
 *   partialTranscripts           → partialTranscripts (same)
 *   partialInFlight              → partialInFlight (same)
 *   bargeInEvents                → bargeInEvents (same)
 *   bargeInTimers                → bargeInTimers (same)
 *   _verboseThreads              → verboseThreads
 *   _pendingSpeaks               → pendingSpeaks
 *   _spokeLostTrackFor           → spokeLostTrackFor
 *   _staleInlineTasks            → staleInlineTasks
 *   _visualAccumulator           → visualAccumulator
 *   _pendingUtterance            → pendingUtterance (same object shape)
 *   recordMode                   → recordMode (same)
 *   currentConnection            → voiceConn.connection
 *   currentVoiceChannelId        → voiceConn.channelId
 *   _ttsDeliveryActive           → ttsDelivery.active
 *   _speakFlushScheduled         → ttsDelivery.flushScheduled
 *   pendingAlertBriefingForUser  → briefingState.pendingAlertBriefingForUser
 *   taskIdCounter                → taskCounter.value (use ++taskCounter.value)
 *   client                       → discordRef.client
 */

// ── Async task management ─────────────────────────────────────────────
export const activeTasks = new Map(); // taskId -> { controller, transcript, startTime, userId, ... }

// ── Per-user conversation history (local backup) ─────────────────────
export const conversations = new Map(); // userId -> { history: [], lastActive: timestamp }

// ── Voice activity tracking ───────────────────────────────────────────
export const userSpeaking = new Map();
export const partialTranscripts = new Map(); // userId -> { text, ts }
export const partialInFlight = new Map();    // userId -> true

// ── Barge-in tracking ─────────────────────────────────────────────────
export const bargeInEvents = new Set();
export const bargeInTimers = new Map();

// ── Verbose thread registry ───────────────────────────────────────────
// parentChannelId → threadId (cleared only on restart or /newchat)
export const verboseThreads = new Map();

// ── /speak pending queue ──────────────────────────────────────────────
export const pendingSpeaks = []; // { message, speakOpts }

// ── Stall / stale tracking sets ──────────────────────────────────────
export const spokeLostTrackFor = new Set();
export const staleInlineTasks = new Set();

// ── Visual mode accumulator ───────────────────────────────────────────
export const visualAccumulator = new Map(); // taskId → { chunks[], startTime, editMsg, editLock }

// ── Pending utterance debounce state ─────────────────────────────────
export const pendingUtterance = {
  timer: null,
  userId: null,
  parts: [],
  startTime: 0,
  conv: null,
  speakerName: null,
  sentiment: null,
  autoSleepAfterTask: false,
};

// ── Record mode state ─────────────────────────────────────────────────
export const recordMode = {
  active: false,
  thread: null,
  startTime: null,
  filePath: null,
  entryCount: 0,
};

// ── Voice connection wrapper ──────────────────────────────────────────
// ES module exports are live-readable but not externally reassignable,
// so we wrap scalars in objects.
export const voiceConn = {
  connection: null,
  channelId: null,
};

// ── TTS delivery gate ─────────────────────────────────────────────────
export const ttsDelivery = {
  active: false,
  flushScheduled: false,
};

// ── Pending alert briefing ────────────────────────────────────────────
export const briefingState = {
  pendingAlertBriefingForUser: null,
};

// ── Task ID counter ───────────────────────────────────────────────────
export const taskCounter = { value: 0 };

// ── Discord client reference ──────────────────────────────────────────
// Set by bootstrap after the Discord client is created.
export const discordRef = { client: null };

// ── Misc interaction tracking ─────────────────────────────────────────
// These were plain `let` vars in index.js shared across functions.
export const interactionState = {
  userDisconnected: true,
  lastInteractionTime: Date.now(),
  lastUserMessage: '',
  ownerMuted: false,
  authenticatedSession: false,
};
