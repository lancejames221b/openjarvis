/**
 * Jarvis Voice Bot - Discord Real-Time Voice Assistant
 * 
 * Thin voice I/O layer: Discord mic → Whisper STT → Clawdbot Gateway → TTS → Discord speaker
 * Same agent, same session, same tools as text chat. Voice is just another input method.
 */

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import { createWriteStream, mkdirSync, existsSync, unlinkSync, readFileSync, writeFileSync, appendFileSync, promises as fsPromises } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { transcribeAudio, transcribeWhisperOnly } from './stt.js';
import { generateResponse, generateResponseStreaming, generateTextResponse, generateAck, generateContextualAck, generateContextualInterim, trimForVoice, isGatewayCircuitOpen, dispatchViaWebhook } from './brain.js';
import { synthesizeSpeech, splitIntoSentences, isTTSAvailable } from './tts.js';
import { OpusDecoder } from './opus-decoder.js';
import { checkWakeWord, markBotResponse, endConversationWindow, setOthersPresent, isOthersPresent, isContinuationPhrase, isFollowUpExpected, hasRecentContext, getEffectiveWindowMs, WAKE_WORD_ENABLED, WAKE_WORD_FUZZY } from './wakeword.js';
import { queueAlert, hasPendingAlerts, getPendingAlerts, getAlertsByPriority, clearAlerts } from './alert-queue.js';
import { isHallucination, shouldSleep, shouldDismiss, isSideTalk, classifyIntent, hasTaskContent, setFollowUpExpectedCallback } from './intent-classifier.js';
import { startAlertWebhook, initAlertWebhook, setCurrentVoiceChannelId, setSpeakCallback, setMarkBotResponseCallback, setPostActivityCallback, setPostToTextCallback, hasPendingHandoffs, getPendingHandoffs, clearHandoffs, updateHealthState, endAllSessionPins, setDedupCallback } from './alert-webhook.js';
import { getTTSHealth } from './tts.js';
import { getSTTHealth } from './stt.js';
import { isTldrToggleCommand, setTldrMode, isTldrModeEnabled, generateTldr, isTranscriptToggleCommand, setTranscriptMode, isTranscriptModeEnabled, isAskModeToggleCommand, setAskMode, isAskModeEnabled } from './tldr-mode.js';
import { isMobileModeToggle, setMobileMode, isMobileModeEnabled } from './mobile-mode.js';
import { isTtsToggleCommand, setTtsProvider, getCurrentTtsProvider } from './tts-toggle.js';
import { TtsPipeline } from './tts-pipeline.js';
import { getState, transition, STATES, canDeliverVoiceAlert, classifyAlertPriority, getStateInfo } from './bot-state.js';
// Task ledger stripped — voice bot is a thin pipe, no ack tracking needed
import { getPlayer, setPlayer, audioQueue as speechAudioQueue, playAudio as speechPlayAudio, speakAndWait, speakPhrase, speakText, enforceOutputLength, getIsSpeaking, setIsSpeaking, setVoiceConnection } from './speech-output.js';
import { activate as muteQueueActivate, deactivate as muteQueueDeactivate, isActive as isMuteQueueActive, addEntry as muteQueueAdd, hasEntries as muteQueueHasEntries, getSummary as muteQueueSummary, getDebriefText as muteQueueDebrief, getContextBlock as muteQueueContext, clear as muteQueueClear, getCount as muteQueueCount } from './mute-queue.js';

const GATEWAY_URL = process.env.CLAWDBOT_GATEWAY_URL || 'http://127.0.0.1:22100';
// Webhook server bind address — matches TAILSCALE_IP in alert-webhook.js (defaults to localhost for non-Tailscale users)
const WEBHOOK_HOST = process.env.TAILSCALE_IP || process.env.ALERT_WEBHOOK_HOST || 'localhost';
const WEBHOOK_PORT = process.env.ALERT_WEBHOOK_PORT || 3335;
const WEBHOOK_BASE_URL = `http://${WEBHOOK_HOST}:${WEBHOOK_PORT}`;
const GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN;

// ── Gateway Health Check ─────────────────────────────────────────────

let _gatewayHealthy = false;
let _healthCheckInterval = null;

export function isGatewayHealthy() {
  return _gatewayHealthy;
}

async function checkGatewayHealth() {
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${GATEWAY_TOKEN}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      // 4xx (auth issues) and 5xx are both unhealthy
      throw new Error(`Gateway ${res.status}`);
    }
    if (!_gatewayHealthy) console.log('🟢 Gateway is healthy');
    _gatewayHealthy = true;
    return true;
  } catch (err) {
    _gatewayHealthy = false;
    console.warn(`🔴 Gateway health check failed: ${err.message}`);
    return false;
  }
}

// ── Startup Cleanup ──────────────────────────────────────────────────
// Remove stale TTS audio files from /tmp left by previous crashed/interrupted runs.
// These cause event-loop blocking when the audio queue tries to drain them.
async function cleanupStaleTmpAudio() {
  try {
    const files = (await fsPromises.readdir('/tmp')).filter(f => f.endsWith('.wav') || f.endsWith('.mp3'));
    let removed = 0;
    for (const f of files) {
      try {
        const age = Date.now() - (await fsPromises.stat(`/tmp/${f}`)).mtimeMs;
        if (age > 60_000) { await fsPromises.unlink(`/tmp/${f}`); removed++; } // older than 1 min = stale
      } catch {}
    }
    if (removed > 0) console.log(`🧹 Cleaned up ${removed} stale audio file(s) from /tmp`);
  } catch {}
}

async function startGatewayHealthCheck() {
  await cleanupStaleTmpAudio(); // Remove leftover TTS files from previous crashed runs
  console.log('🏥 Running initial gateway health check...');
  const healthy = await checkGatewayHealth();
  if (healthy) {
    console.log('✅ Gateway reachable on startup');
  } else {
    console.warn('⚠️  Gateway unreachable on startup — will retry every 10s');
  }
  // Adaptive polling: 10s when unhealthy, 60s when healthy, auto-switches
  const scheduleHealthPoll = (intervalMs) => {
    if (_healthCheckInterval) clearInterval(_healthCheckInterval);
    _healthCheckInterval = setInterval(async () => {
      const wasHealthy = _gatewayHealthy;
      const ok = await checkGatewayHealth();
      // Transition: unhealthy→healthy = slow down to 60s
      if (ok && !wasHealthy) {
        scheduleHealthPoll(60_000);
      }
      // Transition: healthy→unhealthy = speed up to 10s
      if (!ok && wasHealthy) {
        scheduleHealthPoll(10_000);
      }
    }, intervalMs);
  };
  scheduleHealthPoll(_gatewayHealthy ? 60_000 : 10_000);
}

// Start health check immediately (before Discord login)
startGatewayHealthCheck();

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, '..', 'tmp');
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

// Config
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID;
const TEXT_CHANNEL_ID = process.env.DISCORD_TEXT_CHANNEL_ID;
const CC_CHANNEL_ID = process.env.DISCORD_CC_CHANNEL_ID; // Closed captions channel
const ACTIVITY_CHANNEL_ID = process.env.DISCORD_ACTIVITY_CHANNEL_ID || TEXT_CHANNEL_ID; // Task activity feed
const ACTIVITY_FEED_ENABLED = process.env.ACTIVITY_FEED_ENABLED !== 'false'; // Feature flag — default ON
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim());
const MULTI_USER_ENABLED = process.env.MULTI_USER_ENABLED === 'true';

// ── Webhook Callback Mode ─────────────────────────────────────────────
// When enabled, voice requests go through /hooks/agent (fire-and-forget).
// Gateway delivers response to VOICE_CALLBACK_CHANNEL_ID as a Discord message.
// Voice bot picks it up and speaks it. No timeout pressure on the gateway.
const WEBHOOK_CALLBACK_MODE = process.env.WEBHOOK_CALLBACK_MODE === 'true';
const VOICE_CALLBACK_CHANNEL_ID = process.env.VOICE_CALLBACK_CHANNEL_ID || TEXT_CHANNEL_ID;
const IMMEDIATE_ACKS_ENABLED = process.env.IMMEDIATE_ACKS_ENABLED === 'true'; // Feature flag — default OFF (was ON, removed for natural flow)
const VOICE_ACK_ENABLED = process.env.VOICE_ACK_ENABLED === 'true'; // Master ack flag — default OFF (no more "On it, sir." before every response)
const AGENT_DISPATCH_ACK_ENABLED = process.env.AGENT_DISPATCH_ACK_ENABLED !== 'false'; // Contextual Jarvis-style ack on sub-agent spawn — default ON
const CLAWDBOT_BOT_ID = process.env.CLAWDBOT_BOT_ID || ''; // Set CLAWDBOT_BOT_ID in .env to filter webhook callback messages

// ── Self-Mute TTS Queue ───────────────────────────────────────────────
// When owner self-mutes, queue TTS output instead of speaking.
// On unmute: "I have N updates — shall I brief you?"
const MUTE_QUEUE_ENABLED = process.env.MUTE_QUEUE_ENABLED === 'true';
// Skip wake word on unmute prompt if speaker verification is enrolled
const MUTE_QUEUE_WAKE_BYPASS = process.env.MUTE_QUEUE_WAKE_BYPASS !== 'false'; // default ON
// Treat self-unmute as an implicit wake word — opens a conversation window
// so the first thing you say after unmuting doesn't require "Jarvis".
// Requires speaker verify to confirm identity on first utterance.
const UNMUTE_IMPLICIT_WAKE = process.env.UNMUTE_IMPLICIT_WAKE !== 'false'; // default ON

// ── Voice Reconnect Backoff ───────────────────────────────────────────
const reconnectState = {
  attempts: 0,
  currentDelayMs: 5000,
  maxDelayMs: 60000,
  baseDelayMs: 5000,
  textModeNotified: false, // Whether we've posted "standing by in text mode"
  
  nextDelay() {
    this.attempts++;
    // Exponential backoff: 5s → 10s → 20s → 40s → 60s (cap)
    this.currentDelayMs = Math.min(this.baseDelayMs * Math.pow(2, this.attempts - 1), this.maxDelayMs);
    return this.currentDelayMs;
  },
  
  reset() {
    if (this.attempts > 0) {
      console.log(`🟢 Voice reconnect successful (was at attempt #${this.attempts})`);
    }
    this.attempts = 0;
    this.currentDelayMs = this.baseDelayMs;
    this.textModeNotified = false;
  },
};

// ── Process Health Monitor ───────────────────────────────────────────
const HEALTH_CHECK_INTERVAL_MS = 30 * 1000; // Check every 30s
const MEMORY_WARNING_MB = 500;
const MEMORY_CRITICAL_MB = 1024;
const EVENT_LOOP_LAG_WARNING_MS = 500;
let lastEventLoopCheck = Date.now();
let eventLoopLagWarnings = 0;

function startHealthMonitor() {
  setInterval(() => {
    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / 1024 / 1024);
    
    // Memory monitoring
    if (rssMb > MEMORY_CRITICAL_MB) {
      console.error(`🔴 CRITICAL: Memory usage ${rssMb}MB > ${MEMORY_CRITICAL_MB}MB — attempting graceful restart`);
      postToTextChannel(`🔴 **Memory critical** (${rssMb}MB). Restarting gracefully.`);
      // Give time for the message to send, then exit (systemd will restart)
      setTimeout(() => process.exit(1), 2000);
    } else if (rssMb > MEMORY_WARNING_MB) {
      console.warn(`🟡 Memory usage high: ${rssMb}MB > ${MEMORY_WARNING_MB}MB`);
    }
    
    // Event loop lag monitoring
    const now = Date.now();
    const lag = now - lastEventLoopCheck - HEALTH_CHECK_INTERVAL_MS;
    lastEventLoopCheck = now;
    
    if (lag > EVENT_LOOP_LAG_WARNING_MS) {
      eventLoopLagWarnings++;
      console.warn(`🟡 Event loop lag: ${lag}ms (warning #${eventLoopLagWarnings})`);
      if (eventLoopLagWarnings >= 3) {
        console.error(`🔴 Sustained event loop lag (${eventLoopLagWarnings} warnings)`);
        postToTextChannel(`⚠️ **Event loop lag** detected (${lag}ms, ${eventLoopLagWarnings} warnings). Performance may be degraded.`);
        eventLoopLagWarnings = 0; // Reset after reporting
      }
    } else {
      eventLoopLagWarnings = Math.max(0, eventLoopLagWarnings - 1); // Decay warnings on good ticks
    }
    
    // Update health state for /health endpoint
    updateHealthState({
      gatewayHealthy: _gatewayHealthy,
      ttsHealth: getTTSHealth(),
      sttHealth: getSTTHealth(),
      activeTaskCount: activeTasks.size,
      reconnectAttempts: reconnectState.attempts,
      lastSuccessfulInteraction: lastInteractionTime || null,
    });
  }, HEALTH_CHECK_INTERVAL_MS);
  
  console.log('🏥 Process health monitor started (30s interval)');
}

// Conversation history per user (local backup — gateway session is primary)
const conversations = new Map(); // userId -> { history: [], lastActive: timestamp }
const CONVERSATION_TTL_MS = 30 * 60 * 1000; // Prune inactive conversations after 30 min

function pruneConversations() {
  const now = Date.now();
  for (const [userId, conv] of conversations) {
    if (now - (conv.lastActive || 0) > CONVERSATION_TTL_MS) {
      conversations.delete(userId);
    }
  }
}
// Run pruning every 5 minutes
setInterval(pruneConversations, 5 * 60 * 1000);

// Voice activity tracking
const userSpeaking = new Map();
const SILENCE_THRESHOLD_MS = process.env.VAD_TIMEOUT ? parseInt(process.env.VAD_TIMEOUT) : 1500;
const MIN_AUDIO_DURATION_MS = 300;

// Audio player — single player shared with speech-output.js
const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play },
});
// Listener cleanup in playAudio/finish() prevents accumulation — modest limit is safe
player.setMaxListeners(20);
// Share this player with speech-output.js so speakText/speakPhrase use
// the same player that's subscribed to the voice connection
setPlayer(player);

let isSpeaking = false;
let currentConnection = null;
let currentVoiceChannelId = null;
const bargeInEvents = new Set();
const bargeInTimers = new Map(); // Module-scope so reconnects can clear old timers
let pendingAlertBriefingForUser = null;

// ── Record Mode: Passive Meeting Transcription ──────────────────────
// Accumulates raw transcripts to a local file. Summary posted to thread after stop.
const RECORD_CHANNEL_ID = process.env.RECORD_CHANNEL_ID || null;
const RECORD_TEXT_CHANNEL_ID = process.env.RECORD_TEXT_CHANNEL_ID || null;
const RECORD_DIR = join(process.env.HOME || '/tmp', 'meeting-transcripts');
const recordMode = {
  active: false,
  thread: null,          // Discord thread object (created at stop, not start)
  startTime: null,
  filePath: null,        // local transcript file
  entryCount: 0,
};

// Async task management — concurrent background brain calls
const activeTasks = new Map(); // taskId -> { controller, transcript, startTime }
let taskIdCounter = 0;

// ── Utterance Grouping (debounce rapid speech segments) ──────────────
// When user speaks in fragments ("check the weather" ... "in New York"), Whisper
// may emit them as separate transcripts. Buffer briefly and merge before dispatching.
const UTTERANCE_DEBOUNCE_MS = parseInt(process.env.UTTERANCE_DEBOUNCE_MS || '2000'); // 2s window
const _pendingUtterance = {
  timer: null,
  userId: null,
  parts: [],      // transcript fragments
  startTime: 0,
  conv: null,
  speakerName: null,
  sentiment: null,
  autoSleepAfterTask: false,  // Two-tier sleep: sign-off + task → sleep after response
};

function flushPendingUtterance() {
  const { userId, parts, conv, speakerName, sentiment, autoSleepAfterTask } = _pendingUtterance;
  _pendingUtterance.timer = null;
  _pendingUtterance.parts = [];
  _pendingUtterance.userId = null;
  _pendingUtterance.autoSleepAfterTask = false;

  if (!parts.length || !userId) return;

  const merged = parts.join(' ').trim();
  if (!merged) return;

  if (parts.length > 1) {
    console.log(`🔗 Merged ${parts.length} utterances: "${merged.substring(0, 80)}..."`);
  }

  const taskId = ++taskIdCounter;
  const controller = new AbortController();
  activeTasks.set(taskId, { controller, transcript: merged, startTime: Date.now(), userId, autoSleepAfterTask });

  const sleepTag = autoSleepAfterTask ? ' [auto-sleep]' : '';
  const speakerTag = speakerName ? ` [${speakerName}]` : '';
  console.log(`🚀 Task #${taskId}${speakerTag}${sleepTag} dispatched: "${merged.substring(0, 60)}..." (${activeTasks.size} active)`);

  postActivity(`🚀 **Task #${taskId}**${speakerTag}${sleepTag} started${activeTasks.size > 1 ? ` (${activeTasks.size} active)` : ''}\n> ${truncate(merged, 120)}`);

  const brainOptions = {};
  if (speakerName) brainOptions.speaker = speakerName;
  if (sentiment) brainOptions.sentiment = sentiment;
  if (autoSleepAfterTask) brainOptions.autoSleepAfterTask = true;

  processBrainTask(taskId, userId, merged, conv ? [...conv.history] : [], controller.signal, brainOptions)
    .catch(err => console.error(`Task #${taskId} error:`, err.message));
}

function queueUtterance(userId, transcript, conv, speakerName, sentiment) {
  // If different user or a task is already pending and old, flush first
  if (_pendingUtterance.timer && _pendingUtterance.userId !== userId) {
    clearTimeout(_pendingUtterance.timer);
    flushPendingUtterance();
  }

  _pendingUtterance.userId = userId;
  _pendingUtterance.parts.push(transcript);
  _pendingUtterance.conv = conv;
  _pendingUtterance.speakerName = speakerName;
  _pendingUtterance.sentiment = sentiment;
  if (!_pendingUtterance.startTime) _pendingUtterance.startTime = Date.now();

  // Reset debounce timer
  if (_pendingUtterance.timer) clearTimeout(_pendingUtterance.timer);
  _pendingUtterance.timer = setTimeout(flushPendingUtterance, UTTERANCE_DEBOUNCE_MS);
}

// Interrupt/stop command detection
const INTERRUPT_PATTERNS = [
  /^(jarvis\s*[,.]?\s*)?(stop|cancel|abort|shut up|be quiet|enough|nevermind|never mind|hold on|wait)\.?$/i,
  /^(jarvis\s*[,.]?\s*)?(stop|cancel)\s+(that|it|talking|speaking|please|now)\.?$/i,
  /^(jarvis\s*[,.]?\s*)?that's\s+(enough|ok|okay|fine)\.?$/i,
];

function isInterruptCommand(transcript) {
  const clean = transcript.trim().replace(/[.,!?;:]+$/g, '');
  return INTERRUPT_PATTERNS.some(p => p.test(clean));
}

// Voice-to-text handoff tracking
let userDisconnected = false;
let lastInteractionTime = Date.now(); // Init to now — prevents immediate idle disconnect on startup/restart

// Mute-gated output: when others present + owner unmuted, hold responses
let ownerMuted = false;
let lastUserMessage = '';
const ACTIVE_CONVERSATION_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

// ── Follow-Up Detection ──────────────────────────────────────────────
// Detect if a response invites follow-up (lists, questions, partial info).
// Used to extend conversation window so user doesn't need wake word for natural continuation.
const FOLLOWUP_PATTERNS = [
  /\d+\.\s+\w/,                     // numbered list (1. item, 2. item)
  /^\s*[-•]\s+\w/m,                  // bullet list
  /\b(first|second|third|here are|top \d|there are \d)\b/i,  // enumeration language
  /\bwant me to\b/i,                 // offering more
  /\bshould I\b/i,                   // asking for direction
  /\bwould you like\b/i,             // inviting follow-up
  /\bdo you want\b/i,                // direct question
  /\bany (questions|thoughts)\b/i,   // inviting response
  /\blet me know\b/i,                // open-ended invite
  /\bfor more (info|details|on)\b/i, // signaling more available
  /\?\s*$/,                          // ends with a question
];

function detectFollowUpLikely(responseText) {
  if (!responseText || responseText.length < 20) return false;
  return FOLLOWUP_PATTERNS.some(p => p.test(responseText));
}

// ── FSM Sleep/Idle Timers ─────────────────────────────────────────────
// Two-stage: ACTIVE -> IDLE (dynamic) -> SLEEP (2 more min)
// ACTIVE_TO_IDLE adapts: 3min default, up to 5min during active sessions
const ACTIVE_TO_IDLE_BASE_MS = 3 * 60 * 1000;  // 3 min baseline
const IDLE_TO_SLEEP_MS  = 2 * 60 * 1000;  // 2 more min IDLE -> SLEEP
let _activeTimer = null;
let _idleTimer = null;

function resetIdleSleepTimer() {
  if (_activeTimer) clearTimeout(_activeTimer);
  if (_idleTimer) clearTimeout(_idleTimer);

  // Velocity-aware: extend ACTIVE timeout during working sessions
  const effectiveMs = Math.max(ACTIVE_TO_IDLE_BASE_MS, getEffectiveWindowMs());

  _activeTimer = setTimeout(() => {
    if (getState() === 'ACTIVE' && !enrollmentState.active) {
      transition('IDLE', 'active-timeout');
      authenticatedSession = false;
      console.log(`ACTIVE -> IDLE: no interaction for ${Math.round(effectiveMs / 1000)}s`);

      _idleTimer = setTimeout(() => {
        if (getState() === 'IDLE' && !enrollmentState.active) {
          transition('SLEEP', 'idle-timeout');
          console.log('IDLE -> SLEEP: no interaction after IDLE timeout');
        }
      }, IDLE_TO_SLEEP_MS);
    }
  }, effectiveMs);
}

// ── Session-Based Speaker Authentication ─────────────────────────────
// Like Siri/Google: verify speaker on wake word, trust the session after.
// Once "Hey Jarvis" passes speaker verification, all subsequent utterances
// are trusted until sleep/idle/disconnect. No per-utterance verification.
let authenticatedSession = false;
const SESSION_PASSPHRASE = process.env.SPEAKER_PASSPHRASE || '';  // secret phrase to force-authenticate

// Build wake-up patterns from .env WAKE_WORD_PHRASES + hardcoded patterns
const _envPhrases = (process.env.WAKE_WORD_PHRASES || '').split(',').map(p => p.trim().toLowerCase()).filter(p => p.length > 0);
const _phrasePattern = _envPhrases.length > 0
  ? new RegExp(`^(hey[,.]?\\s+)?(${_envPhrases.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i')
  : null;
const WAKE_UP_PATTERNS = [
  /^(jarvis[,.]?\s*)?(wake up|i'm back|come back|resume|start listening|online)/i,
  /^(hey[,.]?\s+)?jarvis\b/i,   // "Jarvis" at start or after "hey"
  /^(hi( there)?|hello|good (morning|evening|afternoon)|yo|sup|hey there)[,.]?\s+jarvis\b/i,  // greeting + Jarvis
  ...(_phrasePattern ? [_phrasePattern] : []),
];

/**
 * Open a conversation window on self-unmute, treating it as an implicit wake word.
 * The first utterance after unmuting doesn't require "Jarvis" — owner identity is
 * confirmed by the act of unmuting from an authenticated device + voiceprint on first speech.
 * Normal idle/sleep timers apply after the window expires.
 */
function _applyImplicitWakeOnUnmute(userId) {
  const currentState = getState();
  // Only apply if there's no active conversation already (don't interrupt)
  if (currentState !== 'ACTIVE') {
    transition('ACTIVE', 'implicit-wake-unmute');
    authenticatedSession = true; // device is authenticated; voiceprint confirms on first utterance
    console.log(`🎙️  Implicit wake: self-unmute opened conversation window (was ${currentState})`);
  }
  // Mark bot response to open the conversation window — followUpLikely=false
  // so we get the standard 2-min window (extended to 5 if velocity is high),
  // not the alert-debrief extended window.
  markBotResponse(userId, { followUpLikely: false });
  resetIdleSleepTimer();
  console.log(`🎙️  Implicit wake window open — first utterance does not require wake word`);
}

function isWakeUpCommand(transcript, speakerVerified = false) {
  const clean = transcript.trim().replace(/[.,!?;:]+$/g, '');
  if (WAKE_UP_PATTERNS.some(p => p.test(clean))) return true;

  // Fuzzy wake word: vocative pattern [word], [sentence]
  // Catches Whisper mishears like "Gargans, go for it" when speaker is verified
  if (WAKE_WORD_FUZZY && speakerVerified) {
    const lower = clean.toLowerCase();
    const fuzzyMaxPrefix = parseInt(process.env.WAKE_WORD_FUZZY_MAX_PREFIX || '12');
    const fuzzyMinSentence = parseInt(process.env.WAKE_WORD_FUZZY_MIN_SENTENCE || '8');
    const fuzzyPattern = new RegExp(
      `^([a-z]{1,${fuzzyMaxPrefix}})[,.]?\\s+(.{${fuzzyMinSentence},})$`, 'i'
    );
    const m = lower.match(fuzzyPattern);
    if (m) {
      const prefix = m[1];
      const COMMON = [
        'so', 'but', 'and', 'the', 'its', 'ok', 'okay', 'yes', 'no', 'hey', 'well',
        'now', 'just', 'wait', 'oh', 'i', 'we', 'you', 'he', 'she', 'it', 'they',
        'this', 'that', 'what', 'how', 'why', 'when', 'where', 'can', 'could', 'would',
        'should', 'will', 'do', 'did', 'is', 'are', 'was', 'were', 'have', 'has', 'had',
        'get', 'got', 'go', 'going', 'let', 'make', 'take', 'also', 'actually',
        'basically', 'literally',
      ];
      if (!COMMON.includes(prefix)) {
        console.log(`🎯 Fuzzy wake (FSM gate): "${prefix}" → treating as wake word (speaker verified)`);
        return true;
      }
    }
  }

  return false;
}

// ── Voice Enrollment Mode ────────────────────────────────────────────
// Activated by "Jarvis, enroll my voice". Captures next N audio clips
// and POSTs them to the speaker verification enrollment endpoint.
const SPEAKER_ENROLL_URL = process.env.SPEAKER_VERIFY_URL?.replace('/verify', '') || 'http://localhost:8767';

// Guided enrollment prompts — wake word variants first (like Siri), then longer phrases
// Wake word variants train the voiceprint on exactly what gets verified.
// Longer phrases add phonetic richness for better overall matching.
const ENROLLMENT_PROMPTS = [
  // Wake word variants (5) — the actual authentication trigger
  "Hey Jarvis.",
  "Jarvis, are you there?",
  "Hey Jarvis, can you hear me?",
  "Yo Jarvis.",
  "Jarvis.",
  // Longer phrases (5) — hacker movie references, diverse phonemes
  "My voice is my passport, verify me.",                          // Sneakers (1992)
  "I'm in.",                                                       // Every hacker movie ever
  "The only winning move is not to play.",                         // WarGames (1983)
  "I need you to hack the planet.",                                // Hackers (1995)
  "Jarvis, put everything we have into the thrusters.",            // Iron Man (2008)
];

const enrollmentState = {
  active: false,
  learnMode: false,       // learn mode: keep adding clips beyond initial enrollment
  clipsNeeded: 10,
  clipsCollected: 0,
  promptIndex: 0,
  userId: null,
  // Track which prompts have been recorded (for retry N)
  recorded: [],           // boolean array — recorded[i] = true if prompt i accepted

  start(userId, learn = false) {
    this.active = true;
    this.learnMode = learn;
    this.clipsNeeded = ENROLLMENT_PROMPTS.length;
    this.clipsCollected = 0;
    this.promptIndex = 0;
    this.userId = userId;
    this.recorded = new Array(ENROLLMENT_PROMPTS.length).fill(false);
    if (!learn) {
      fetch(`${SPEAKER_ENROLL_URL}/enroll/reset`, { method: 'POST' }).catch(() => {});
    }
  },

  currentPrompt() {
    return ENROLLMENT_PROMPTS[this.promptIndex] || null;
  },

  // Jump to a specific phrase number (1-indexed)
  goToPrompt(num) {
    const idx = num - 1;
    if (idx >= 0 && idx < ENROLLMENT_PROMPTS.length) {
      this.promptIndex = idx;
      return ENROLLMENT_PROMPTS[idx];
    }
    return null;
  },

  // Advance to next unrecorded prompt (or next in sequence)
  advanceToNext() {
    this.promptIndex++;
    // In normal mode just go forward
    if (this.promptIndex >= ENROLLMENT_PROMPTS.length) {
      return null; // all done
    }
    return ENROLLMENT_PROMPTS[this.promptIndex];
  },

  async addClip(wavPath) {
    try {
      const { default: fetch } = await import('node-fetch');
      const { createReadStream } = await import('fs');
      const FormData = (await import('form-data')).default;
      const form = new FormData();
      form.append('audio', createReadStream(wavPath));
      const res = await fetch(`${SPEAKER_ENROLL_URL}/enroll`, {
        method: 'POST',
        body: form,
        headers: form.getHeaders(),
        timeout: 10000,
      });
      const data = await res.json();
      if (data.accepted) {
        this.recorded[this.promptIndex] = true;
        this.clipsCollected = this.recorded.filter(Boolean).length;
        return { accepted: true, total: this.clipsCollected, needed: this.clipsNeeded };
      }
      return { accepted: false, reason: data.reason || 'unknown' };
    } catch (err) {
      return { accepted: false, reason: err.message };
    }
  },

  async finalize() {
    try {
      const res = await fetch(`${SPEAKER_ENROLL_URL}/enroll/finalize`, { method: 'POST' });
      const data = await res.json();
      if (!this.learnMode) this.active = false;
      return data;
    } catch (err) {
      if (!this.learnMode) this.active = false;
      return { saved: false, error: err.message };
    }
  },

  cancel() {
    this.active = false;
    this.learnMode = false;
    this.clipsCollected = 0;
    this.promptIndex = 0;
    this.recorded = [];
    fetch(`${SPEAKER_ENROLL_URL}/enroll/reset`, { method: 'POST' }).catch(() => {});
  },
};

// ── Task Activity Feed ───────────────────────────────────────────────
// Posts task lifecycle events to the text channel so user can track
// what's happening when in voice (can't see the screen)

async function postActivity(message) {
  if (!ACTIVITY_FEED_ENABLED || !ACTIVITY_CHANNEL_ID || !client.isReady()) return;
  try {
    const channel = client.channels.cache.get(ACTIVITY_CHANNEL_ID);
    if (channel) return await channel.send(message);
  } catch (err) {
    console.error('Activity post failed:', err.message);
  }
  return null;
}

// Pin/unpin removed — gateway handles all Discord interaction (has full perms)

function truncate(str, len = 80) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '…' : str;
}

// ── Audio Queue (for streaming TTS) ──────────────────────────────────

class AudioQueue {
  constructor() {
    this.queue = [];
    this.playing = false;
  }
  
  add(audioSource, metadata = {}) {
    this.queue.push({ audioSource, metadata });
    if (!this.playing) this.playNext();
  }
  
  clear() {
    this.queue = [];
    if (this.playing) {
      player.stop(true);
      this.playing = false;
    }
    serverMuteOwner(false);
  }
  
  async playNext() {
    if (this.queue.length === 0) {
      this.playing = false;
      isSpeaking = false;
      serverMuteOwner(false);
      return;
    }

    // Mute-gated: hold response when others present + owner unmuted
    // Skip mute-gating when wake word is active — wake word handles filtering
    if (isOthersPresent() && !ownerMuted && !WAKE_WORD_ENABLED) {
      console.log(`🤫 Holding response — owner unmuted with others present (${this.queue.length} queued)`);
      this.playing = false;
      isSpeaking = false;
      return; // Will resume when owner mutes (voiceStateUpdate fires playNext)
    }

    const wasPlaying = this.playing;
    this.playing = true;
    isSpeaking = true;
    if (!wasPlaying) serverMuteOwner(true);
    let { audioSource } = this.queue.shift();
    // Prepend silence to first clip so BT speaker wakes on dead air, not speech
    if (!wasPlaying) {
      const btLeadMs = parseInt(process.env.BT_LEAD_IN_MS || '0');
      const padded = prependSilence(audioSource, btLeadMs);
      if (padded !== audioSource) {
        try { unlinkSync(audioSource); } catch {} // remove original, padded replaces it
        audioSource = padded;
      }
    }
    try { await playAudio(audioSource); } catch (err) { console.error('Queue playback error:', err.message); }
    // Clean up TTS temp file after playback
    try { unlinkSync(audioSource); } catch {}
    setImmediate(() => this.playNext());
  }
}

const audioQueue = new AudioQueue();

// ── Alert Briefing ───────────────────────────────────────────────────

function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours > 1 ? 's' : ''} ago`;
}

async function briefPendingAlerts(userId) {
  const alerts = getPendingAlerts();
  if (alerts.length === 0) return;
  
  let briefing = 'Welcome back. ';
  if (alerts.length === 1) {
    const alert = alerts[0];
    briefing += `${alert.priority === 'urgent' ? 'Urgent alert' : 'Alert'} from ${getTimeAgo(alert.timestamp)}: ${alert.message}. Want the rundown?`;
  } else {
    briefing += `You have ${alerts.length} alerts. `;
    const urgentCount = alerts.filter(a => a.priority === 'urgent').length;
    if (urgentCount > 0) briefing += `${urgentCount} urgent. `;
    briefing += 'Want the briefing?';
  }
  
  const audio = await synthesizeSpeech(briefing);
  if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
  markBotResponse(userId, { followUpLikely: true }); // alerts always invite follow-up

  // Inject alert context into conversation history so gateway agent can handle follow-ups
  if (!conversations.has(userId)) conversations.set(userId, { history: [], lastActive: Date.now() });
  const conv = conversations.get(userId);
  conv.lastActive = Date.now();
  
  // Build detailed alert context for the agent
  let alertContext = `[SYSTEM] The following alerts were queued while user was away and just briefed via TTS:\n`;
  for (const alert of alerts) {
    alertContext += `- [${alert.priority}] ${getTimeAgo(alert.timestamp)}: ${alert.message}`;
    if (alert.fullDetails) alertContext += ` | Details: ${alert.fullDetails}`;
    if (alert.source) alertContext += ` (source: ${alert.source})`;
    alertContext += '\n';
  }
  alertContext += `User was told: "${briefing}"\nIf they ask for details, provide the full alert information above.`;
  
  conv.history.push({ role: 'assistant', content: alertContext });
  while (conv.history.length > 40) conv.history.shift();
  
  clearAlerts();
}

async function briefPendingHandoffs(userId) {
  const handoffs = getPendingHandoffs();
  if (handoffs.length === 0) return;
  
  // Build voice briefing
  let briefing = '';
  if (handoffs.length === 1) {
    const h = handoffs[0];
    briefing = `You have a handoff from ${h.channel}. ${h.topic ? h.topic + '. ' : ''}${h.summary.substring(0, 200)}`;
    if (h.instructions) briefing += ` Instructions: ${h.instructions.substring(0, 100)}`;
  } else {
    briefing = `You have ${handoffs.length} handoffs. `;
    for (const h of handoffs) {
      briefing += `From ${h.channel}: ${h.summary.substring(0, 80)}. `;
    }
  }
  
  const audio = await synthesizeSpeech(briefing);
  if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
  markBotResponse(userId, { followUpLikely: true }); // handoffs invite follow-up

  // Inject handoff context into conversation history so gateway agent has it
  if (!conversations.has(userId)) conversations.set(userId, { history: [], lastActive: Date.now() });
  const conv = conversations.get(userId);
  conv.lastActive = Date.now();
  
  let context = `[SYSTEM] Voice handoff context — the following was queued from text channels:\n`;
  for (const h of handoffs) {
    context += `\n--- Handoff from #${h.channel} (${getTimeAgo(h.timestamp)}) ---\n`;
    if (h.topic) context += `Topic: ${h.topic}\n`;
    context += `Summary: ${h.summary}\n`;
    if (h.instructions) context += `Instructions: ${h.instructions}\n`;
  }
  context += `\nUser has been briefed via TTS. Continue from this context.`;
  
  conv.history.push({ role: 'assistant', content: context });
  while (conv.history.length > 40) conv.history.shift();
  
  clearHandoffs();
}

function scheduleBriefingOnPause(userId) {
  pendingAlertBriefingForUser = userId;
}

// ── Dynamic Greeting ─────────────────────────────────────────────────

async function generateDynamicGreeting() {
  const now = new Date();
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  
  const prompt = `You are Jarvis, a British AI butler. Generate ONE short greeting (under 15 words) for ${timeOfDay}. Dry wit welcome. No quotes, just the text.`;
  
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GATEWAY_TOKEN}` },
      body: JSON.stringify({
        model: process.env.VOICE_MODEL || 'anthropic-console/claude-sonnet-4-6',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50,
        temperature: 0.9,
      }),
    });
    if (!res.ok) throw new Error(`Gateway ${res.status}`);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content?.trim() || 'Welcome back, sir.').replace(/^["']|["']$/g, '');
  } catch {
    return 'Welcome back, sir.';
  }
}

// ── Main ─────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', async () => {
  console.log(`🤖 Jarvis Voice Bot online as ${client.user.tag}`);
  console.log(`📡 Guild: ${GUILD_ID} | Voice: ${VOICE_CHANNEL_ID} | Multi-user: ${MULTI_USER_ENABLED} | Callback: ${WEBHOOK_CALLBACK_MODE}`);
  
  initAlertWebhook(client, GUILD_ID, ALLOWED_USERS, scheduleBriefingOnPause);
  
  // Wire up cross-path content deduplication (shared between messageCreate + /speak)
  setDedupCallback(_isDuplicateContent);

  // Wire follow-up detection into the TV noise filter (intent-classifier.js)
  // When a follow-up is expected, short phrases like "yes please" bypass the TV filter
  setFollowUpExpectedCallback(() => isFollowUpExpected());
  
  // Wire up immediate TTS delivery for /speak endpoint
  // Uses the main audioQueue (subscribed to voice connection) directly.
  // speech-output.js speakText has its own audioQueue that wasn't connected.
  setSpeakCallback(async (message, speakOpts = {}) => {
    try {
      if (!message || message.trim().length < 2) return;

      // Self-mute queue intercept — capture text instead of synthesizing
      if (MUTE_QUEUE_ENABLED && isMuteQueueActive()) {
        const source = speakOpts.source || 'speak';
        const priority = speakOpts.priority || 3;
        muteQueueAdd(message.trim(), source, priority);
        console.log(`🔇 /speak intercepted — queued for mute debrief (${source})`);
        return;
      }

      const sentences = splitIntoSentences(message);
      for (const sentence of sentences) {
        if (sentence.trim().length < 2) continue;
        const audio = await synthesizeSpeech(sentence.trim());
        if (audio) {
          audioQueue.add(audio);
        } else {
          // TTS failed -- fall back to text
          postToTextChannel(`🔇 ${sentence}`);
        }
      }
    } catch (err) {
      console.error('Speak callback TTS failed:', err.message);
    }
  });
  
  // Wire up conversation window refresh for /speak callback responses
  setMarkBotResponseCallback((userId, opts) => markBotResponse(userId, opts));

  // Wire up activity feed posting for /speak endpoint
  setPostActivityCallback((message) => postActivity(message));
  
  // Wire up text channel posting for /speak endpoint (belt and suspenders)
  setPostToTextCallback((message) => postToTextChannel(message));
  
  startAlertWebhook();
  startHealthMonitor();
  
  // Task ledger removed — voice bot is a thin pipe
  
  try {
    // Check if owner is already in a voice channel — follow them
    const guild = client.guilds.cache.get(GUILD_ID);
    let ownerChannel = null;
    try {
      const ownerMember = await guild.members.fetch(ALLOWED_USERS[0]);
      ownerChannel = ownerMember?.voice?.channelId;
      ownerMuted = !!ownerMember?.voice?.selfMute;
      if (ownerChannel) console.log(`👀 Owner is in voice channel ${ownerChannel} (${ownerMuted ? 'muted' : 'unmuted'})`);
    } catch (e) {
      console.log(`Could not fetch owner voice state: ${e.message}`);
    }
    
    const targetChannel = ownerChannel || VOICE_CHANNEL_ID;
    if (targetChannel) {
      // Retry logic on startup join
      let attempt = 0;
      const maxAttempts = 3;
      let joined = false;
      
      while (!joined && attempt < maxAttempts) {
        attempt++;
        try {
          await joinChannel(targetChannel, { greeting: false });
          console.log(`✅ Joined voice channel ${targetChannel}${ownerChannel ? ' (owner is here)' : ' (default)'}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
          joined = true;
          // Auto-enter record mode on startup if owner is in the record channel
          if (RECORD_CHANNEL_ID && targetChannel === RECORD_CHANNEL_ID) {
            startRecordMode(ALLOWED_USERS[0]);
          }
        } catch (err) {
          if (attempt < maxAttempts) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            console.error(`⚠️ Join attempt ${attempt} failed: ${err.message} — retrying in ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            console.error('⚠️ Failed to join voice channel after 3 attempts:', err.message);
            console.log('🔄 Will auto-join when owner enters a voice channel');
          }
        }
      }
    } else {
      console.log('🔄 No default channel and owner not in voice — waiting for owner to join');
    }
  } catch (err) {
    console.error('⚠️ Failed to join voice channel:', err.message);
    console.log('🔄 Will auto-join when owner enters a voice channel');
  }
});

// Detect user joining/leaving voice channel
// Track whether non-owner humans are in voice channel for dynamic wake word
client.on('voiceStateUpdate', (oldState, newState) => {
  if (!currentVoiceChannelId) return;
  const channel = client.channels.cache.get(currentVoiceChannelId);
  if (channel) {
    const wasOthers = isOthersPresent();
    const others = channel.members.filter(m => !m.user.bot && !ALLOWED_USERS.includes(m.id)).size;
    setOthersPresent(others > 0);
    // Others just left — flush any held responses
    if (wasOthers && others === 0 && audioQueue && audioQueue.queue.length > 0 && !audioQueue.playing) {
      console.log(`▶️  Others left channel — playing ${audioQueue.queue.length} held response(s)`);
      audioQueue.playNext();
    }
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.id !== ALLOWED_USERS[0]) return;
  
  // Track owner mute state for mute-gated output
  const wasMuted = ownerMuted;
  ownerMuted = !!newState.selfMute;
  if (wasMuted !== ownerMuted) {
    console.log(`🎙️ Owner ${ownerMuted ? 'MUTED' : 'UNMUTED'}`);

    if (ownerMuted) {
      // ── Owner just MUTED ──────────────────────────────────────────
      if (MUTE_QUEUE_ENABLED) {
        // Activate mute queue — subsequent TTS will be captured, not spoken
        muteQueueActivate();
        // Clear audio already queued/playing (don't dump it while they're muted)
        audioQueue.clear();
        console.log(`🔇 Mute queue active — TTS will be queued until unmute`);
      } else {
        // Legacy behaviour: flush held responses on mute (mute-gated output)
        if (audioQueue && audioQueue.queue.length > 0 && !audioQueue.playing) {
          console.log(`▶️  Owner muted — playing ${audioQueue.queue.length} held response(s)`);
          audioQueue.playNext();
        }
      }
    } else {
      // ── Owner just UNMUTED ────────────────────────────────────────
      if (MUTE_QUEUE_ENABLED && isMuteQueueActive()) {
        muteQueueDeactivate();
        const count = muteQueueCount();
        if (count > 0) {
          // Offer debrief — smart-collapsed summary
          const summary = muteQueueSummary();
          if (summary) {
            console.log(`🔊 Mute queue debrief: ${count} entries — offering summary`);

            // Build conversation context so AI can answer follow-ups
            const ctxBlock = muteQueueContext();
            if (ctxBlock) {
              const userId = ALLOWED_USERS[0];
              if (!conversations.has(userId)) conversations.set(userId, { history: [], lastActive: Date.now() });
              const conv = conversations.get(userId);
              conv.history.push({ role: 'assistant', content: ctxBlock });
              while (conv.history.length > 40) conv.history.shift();
              conv.lastActive = Date.now();
            }

            // FSM: force ACTIVE state — user just unmuted and we're talking to them
            // Without this, the idle timer (3min) may have pushed state to IDLE/SLEEP
            // while muted, and the debrief reply gets dropped by the FSM gate.
            if (getState() !== 'ACTIVE') {
              transition('ACTIVE', 'mute-queue-debrief');
              authenticatedSession = true; // they were verified before muting
            }
            resetIdleSleepTimer();

            // Wake bypass: on unmute prompt, skip wake word for the reply
            if (MUTE_QUEUE_WAKE_BYPASS) {
              const userId = ALLOWED_USERS[0];
              markBotResponse(userId, { followUpLikely: true });
              console.log(`🎙️  Wake bypass active — unmute response does not require wake word`);
            }

            // Speak the summary (fires immediately, won't re-queue)
            try {
              const audio = await synthesizeSpeech(summary);
              if (audio) audioQueue.add(audio);
            } catch (err) {
              console.error('Mute queue debrief TTS failed:', err.message);
            }

            // Clear queue after debrief offered (details available via conversation history)
            muteQueueClear();
          }
        } else {
          // Nothing queued — deactivate and optionally open implicit wake window
          muteQueueDeactivate();
          if (UNMUTE_IMPLICIT_WAKE) {
            _applyImplicitWakeOnUnmute(newState.id);
          }
        }
      } else if (UNMUTE_IMPLICIT_WAKE) {
        // MUTE_QUEUE_ENABLED=false but unmute implicit wake still applies
        _applyImplicitWakeOnUnmute(newState.id);
      }
    }
  }
  
  // User joined a voice channel (any channel in the guild)
  const joinedChannel = newState.channelId;
  const leftChannel = oldState.channelId;
  
  // User switched or joined a voice channel — follow them
  if (joinedChannel && joinedChannel !== currentVoiceChannelId) {
    console.log(`🔀 Owner moved to channel ${joinedChannel} — following`);
    
    // Retry logic with exponential backoff
    let attempt = 0;
    const maxAttempts = 3;
    let joined = false;
    
    while (!joined && attempt < maxAttempts) {
      attempt++;
      try {
        await joinChannel(joinedChannel, { greeting: false });
        console.log(`✅ Followed owner to ${joinedChannel}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        joined = true;
        // Auto-enter record mode for dedicated recording channel
        if (RECORD_CHANNEL_ID && joinedChannel === RECORD_CHANNEL_ID) {
          startRecordMode(newState.id);
        }
      } catch (err) {
        if (attempt < maxAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          console.error(`⚠️ Follow attempt ${attempt} failed: ${err.message} — retrying in ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          console.error(`❌ Failed to follow owner after ${maxAttempts} attempts: ${err.message}`);
        }
      }
    }
  }
  
  if (joinedChannel && (!leftChannel || leftChannel !== joinedChannel)) {
    userDisconnected = false; // Reset disconnect flag on join
    console.log(`👋 User joined voice channel ${joinedChannel}`);
    // Record channel: auto-start recording, skip greeting
    if (RECORD_CHANNEL_ID && joinedChannel === RECORD_CHANNEL_ID) {
      // Cancel pending stop timer if rejoining within grace period
      if (recordMode._stopTimer) { clearTimeout(recordMode._stopTimer); recordMode._stopTimer = null; }
      if (!recordMode.active) startRecordMode(newState.id);
      return;
    }
    // Quick "Jarvis online" on join — no waiting for AI-generated greeting
    setTimeout(async () => {
      try {
        const rawModel = process.env.VOICE_MODEL || 'anthropic-console/claude-sonnet-4-6';
        const modelLabel = rawModel
          .replace('google-gemini-cli/', '').replace('google/', '')
          .replace('anthropic/', '').replace('openai-codex/', '').replace('openai/', '')
          .replace('gemini-3-flash-preview', 'Gemini 3 Flash')
          .replace('gemini-3-pro-preview', 'Gemini 3 Pro')
          .replace('gemini-2.5-pro', 'Gemini 2.5 Pro')
          .replace('gemini-2.5-flash', 'Gemini 2.5 Flash')
          .replace('claude-sonnet-4-6', 'Claude Sonnet')
          .replace('claude-opus-4-6', 'Claude Opus')
          .replace('claude-haiku-4-5', 'Claude Haiku')
          .replace('gpt-5.3-codex', 'Codex');
        const audio = await synthesizeSpeech(`Jarvis online. Using ${modelLabel}.`);
        if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
      } catch {}
      
      // ── Auto-Brief: Check for active context ──────────────────────
      // If there's an active handoff context, brief immediately
      try {
        const WEBHOOK_TOKEN = process.env.ALERT_WEBHOOK_TOKEN || 'change-me';
        const res = await fetch(WEBHOOK_BASE_URL + '/context/active', {
          headers: { 'Authorization': `Bearer ${WEBHOOK_TOKEN}` },
        });
        if (res.ok) {
          const { context } = await res.json();
          if (context && context.summary) {
            console.log(`📋 Active context detected from ${context.surface} — briefing user`);
            const briefMsg = `${context.topic ? context.topic + '. ' : ''}${context.summary.substring(0, 300)}`;
            const briefAudio = await synthesizeSpeech(briefMsg);
            if (briefAudio) {
              await playAudio(briefAudio);
              try { unlinkSync(briefAudio); } catch {}
            }
            // Clear the context after briefing
            await fetch(WEBHOOK_BASE_URL + '/context/active', {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${WEBHOOK_TOKEN}` },
            });
          }
        }
      } catch (err) {
        console.error(`⚠️ Failed to check active context: ${err.message}`);
      }
      
      // Brief pending alerts after greeting
      if (hasPendingAlerts()) {
        await briefPendingAlerts(newState.id);
      }
      // Brief pending handoffs
      if (hasPendingHandoffs()) {
        await briefPendingHandoffs(newState.id);
      }
      // Mute queue debrief on reconnect — handles device switch (iPad muted → phone join)
      // If user left while self-muted and rejoins on a different device (unmuted by default),
      // the selfMute toggle never fires. Check the queue here as a safety net.
      if (MUTE_QUEUE_ENABLED && muteQueueHasEntries()) {
        // Deactivate first (may still be flagged active if left while muted)
        if (isMuteQueueActive()) muteQueueDeactivate();
        const count = muteQueueCount();
        const summary = muteQueueSummary();
        if (summary) {
          console.log(`🔊 Mute queue debrief on reconnect: ${count} entries`);
          // Inject context so AI can answer follow-ups
          const ctxBlock = muteQueueContext();
          if (ctxBlock) {
            const uid = newState.id;
            if (!conversations.has(uid)) conversations.set(uid, { history: [], lastActive: Date.now() });
            const conv = conversations.get(uid);
            conv.history.push({ role: 'assistant', content: ctxBlock });
            while (conv.history.length > 40) conv.history.shift();
            conv.lastActive = Date.now();
          }
          // Wake bypass — just reconnected, don't require wake word for reply
          if (MUTE_QUEUE_WAKE_BYPASS) {
            markBotResponse(newState.id, { followUpLikely: true });
          }
          transition('ACTIVE', 'mute-queue-debrief-reconnect');
          authenticatedSession = true;
          resetIdleSleepTimer();
          try {
            const audio = await synthesizeSpeech(summary);
            if (audio) audioQueue.add(audio);
          } catch (err) {
            console.error('Mute queue reconnect debrief TTS failed:', err.message);
          }
          muteQueueClear();
        }
      }
    }, 500);
  }
  
  // User left voice entirely (not just switching channels)
  if (leftChannel && !joinedChannel) {
    console.log(`👋 User left voice entirely`);
    userDisconnected = true;
    // If owner left while self-muted, deactivate the mute queue
    // so it's in the right state when they reconnect on another device
    if (MUTE_QUEUE_ENABLED && isMuteQueueActive()) {
      muteQueueDeactivate();
      console.log(`🔇 Mute queue deactivated on disconnect (${muteQueueCount()} entries held for reconnect)`);
    }
    // Stop recording after grace period (30s for brief disconnects)
    if (recordMode.active) {
      recordMode._stopTimer = setTimeout(() => stopRecordMode(), 30000);
    }
    // End all pinned session statuses in handoff channels
    await endAllSessionPins();
    await handleVoiceDisconnect(newState.id);
  }
});

// ── Callback Deduplication ────────────────────────────────────────────
// Prevents duplicate responses from being spoken multiple times.
// Two layers: message ID dedup (Discord events) + content hash dedup (cross-path).

const _processedMsgIds = new Set();
const _recentContentHashes = new Map(); // hash -> timestamp
const DEDUP_MSG_ID_MAX = 500;
const DEDUP_CONTENT_TTL_MS = 30_000; // 30s window for content dedup

function _contentHash(text) {
  // First 120 chars + length = cheap but effective fingerprint
  return `${text.substring(0, 120).trim()}__${text.length}`;
}

function _isDuplicateContent(text) {
  const hash = _contentHash(text);
  const now = Date.now();
  const lastSeen = _recentContentHashes.get(hash);
  if (lastSeen && now - lastSeen < DEDUP_CONTENT_TTL_MS) {
    return true;
  }
  _recentContentHashes.set(hash, now);
  // Prune old entries periodically
  if (_recentContentHashes.size > 200) {
    for (const [h, t] of _recentContentHashes) {
      if (now - t > DEDUP_CONTENT_TTL_MS * 2) _recentContentHashes.delete(h);
    }
  }
  return false;
}

// Expose content dedup for /speak endpoint (alert-webhook.js)
export function isDuplicateContent(text) { return _isDuplicateContent(text); }

// Periodic cleanup of message ID cache
setInterval(() => {
  if (_processedMsgIds.size > DEDUP_MSG_ID_MAX) {
    _processedMsgIds.clear();
    console.log('🧹 Cleared message ID dedup cache');
  }
}, 5 * 60 * 1000);

// ── Webhook Callback Listener ────────────────────────────────────────
// When webhook callback mode is on, gateway delivers responses to
// #jarvis-voice-text. This listener picks them up and speaks them.

client.on('messageCreate', async (message) => {
  if (!WEBHOOK_CALLBACK_MODE) return;
  
  // Only listen in the callback channel
  if (message.channelId !== VOICE_CALLBACK_CHANNEL_ID) return;
  
  // Only process messages from the Clawdbot bot
  if (message.author.id !== CLAWDBOT_BOT_ID) return;
  
  // Skip if it's a bot message from ourselves (voice bot)
  if (message.author.id === client.user.id) return;
  
  // Skip empty or signal messages
  const text = message.content?.trim();
  if (!text) return;
  if (/^\s*(NO_REPLY|HEARTBEAT_OK)\s*$/i.test(text)) return;
  
  // ── Deduplication: message ID ──
  if (_processedMsgIds.has(message.id)) {
    console.log(`⏭️  Dedup: skipping duplicate message ID ${message.id}`);
    return;
  }
  _processedMsgIds.add(message.id);
  
  // ── Deduplication: content hash (catches cross-path dupes from /speak) ──
  if (_isDuplicateContent(text)) {
    console.log(`⏭️  Dedup: skipping duplicate content (${text.substring(0, 40)}...)`);
    return;
  }
  
  console.log(`📩 Callback received (${text.length} chars, id: ${message.id}): "${text.substring(0, 80)}..."`);
  
  // Clean for voice
  const voiceText = trimForVoice(text);
  if (!voiceText || voiceText.length < 2) return;
  
  // Add to conversation history
  const conv = conversations.get(ALLOWED_USERS[0]) || { history: [], lastActive: 0 };
  conv.history.push({ role: 'assistant', content: voiceText });
  if (conv.history.length > 20) conv.history.splice(0, conv.history.length - 20);
  conv.lastActive = Date.now();
  conversations.set(ALLOWED_USERS[0], conv);
  
  // If user is in voice, speak it
  if (!userDisconnected) {
    // Split into sentences for streaming TTS
    const sentences = splitIntoSentences(voiceText);
    for (const sentence of sentences) {
      if (sentence.trim().length < 2) continue;
      try {
        const audio = await synthesizeSpeech(sentence.trim());
        if (audio) {
          audioQueue.add(audio);
        } else if (!isTTSAvailable()) {
          await postToTextChannel(`🔇 ${sentence}`);
        }
      } catch (err) {
        console.error('Callback TTS failed:', err.message);
      }
    }
    
    const duration = ((Date.now() - lastInteractionTime) / 1000).toFixed(1);
    console.log(`💬 Callback spoken (${duration}s since request)`);
  } else {
    // User not in voice — ping them in the text channel so they see it
    console.log(`📝 Callback received but user not in voice — pinging in text channel`);
    const userId = ALLOWED_USERS[0];
    await postToTextChannel(`<@${userId}> 🎙️ **Voice task complete:**\n${voiceText}`);
  }
});

// ── @Mention Handler ─────────────────────────────────────────────────
// Responds to @JARVISAI mentions in any Discord text channel.
// Routes through the gateway with a [TEXT] tag (full markdown, no voice constraints).

client.on('messageCreate', async (message) => {
  // Skip bot messages (including our own)
  if (message.author.bot) return;

  // Only respond if we're actually mentioned
  if (!message.mentions.has(client.user.id)) return;

  // Only respond to allowed users (same as voice)
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(message.author.id)) return;

  // Strip the mention from the message content
  const content = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();

  if (!content) return; // Empty mention, nothing to respond to

  console.log(`@mention from ${message.author.tag} in #${message.channel.name}: "${content.substring(0, 80)}"`);

  // Show typing indicator while we process
  try { await message.channel.sendTyping(); } catch (_) {}

  try {
    const result = await generateTextResponse(content, {
      channelId: message.channelId,
      sessionUser: `agent:main:discord:channel:${message.channelId}`,
    });

    if (!result.text || result.text.length < 2) {
      // Agent probably spawned a sub-agent -- it'll post back on its own
      console.log(`@mention: empty response (sub-agent likely spawned)`);
      return;
    }

    // Discord message limit is 2000 chars -- split if needed
    const response = result.text;
    if (response.length <= 2000) {
      await message.reply(response);
    } else {
      // Split into chunks at paragraph boundaries
      const chunks = [];
      let remaining = response;
      while (remaining.length > 0) {
        if (remaining.length <= 2000) {
          chunks.push(remaining);
          break;
        }
        let splitAt = remaining.lastIndexOf('\n\n', 2000);
        if (splitAt < 500) splitAt = remaining.lastIndexOf('\n', 2000);
        if (splitAt < 500) splitAt = 2000;
        chunks.push(remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt).trimStart();
      }
      // Reply to the first chunk, send rest as follow-ups
      await message.reply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await message.channel.send(chunks[i]);
      }
    }

    console.log(`@mention: replied (${response.length} chars)`);
  } catch (err) {
    console.error(`@mention handler error:`, err.message);
    try {
      await message.reply("Having trouble processing that right now, sir.");
    } catch (_) {}
  }
});

// ── Voice-to-Text Handoff ────────────────────────────────────────────

async function sendDM(userId, message) {
  try {
    const user = await client.users.fetch(userId);
    console.log(`📤 Sending DM to user ${userId}...`);
    await user.send(message);
    console.log(`✅ DM sent successfully`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send DM: ${err.message}`);
    return false;
  }
}

// Post to closed captions channel (live transcript)
async function postToCC(prefix, text) {
  if (!CC_CHANNEL_ID) return;
  try {
    const channel = client.channels.cache.get(CC_CHANNEL_ID);
    if (!channel) return;
    // Truncate to Discord limit
    const msg = `${prefix} ${text}`.substring(0, 2000);
    await channel.send(msg);
  } catch (err) {
    console.warn(`CC post failed: ${err.message}`);
  }
}

async function postToTextChannel(message) {
  if (!TEXT_CHANNEL_ID) {
    console.warn('⚠️  No text channel configured, skipping channel post');
    return false;
  }
  
  try {
    const channel = client.channels.cache.get(TEXT_CHANNEL_ID);
    if (!channel) {
      console.error(`❌ Channel ${TEXT_CHANNEL_ID} not found in cache`);
      return false;
    }
    
    console.log(`📤 Posting to ${channel.name} (${TEXT_CHANNEL_ID})...`);
    await channel.send(message);
    console.log(`✅ Posted to ${channel.name} successfully`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to post to channel: ${err.message}`);
    return false;
  }
}

/**
 * Post voice conversation as a thread (user question → thread with Jarvis response + task tracking)
 */
async function postTranscriptThread(taskId, userTranscript, jarvisResponse, duration) {
  if (!TEXT_CHANNEL_ID) {
    console.warn('⚠️  No text channel configured, skipping transcript thread');
    return false;
  }
  
  try {
    const channel = client.channels.cache.get(TEXT_CHANNEL_ID);
    if (!channel) {
      console.error(`❌ Channel ${TEXT_CHANNEL_ID} not found in cache`);
      return false;
    }
    
    // Post the initial message with task ID and user's question
    console.log(`📤 Posting voice transcript thread (task #${taskId}) to ${channel.name}...`);
    const initialMsg = await channel.send(`🎙️ **Task #${taskId}** | You: ${userTranscript}`);
    
    // Create a thread on that message with task ID in the name
    const thread = await initialMsg.startThread({
      name: `Task #${taskId}: ${userTranscript.substring(0, 40)}${userTranscript.length > 40 ? '...' : ''}`,
      autoArchiveDuration: 1440, // 24 hours
    });
    
    // Post Jarvis's full response with timing in the thread
    await thread.send(`**Jarvis Response:**\n${jarvisResponse}\n\n_Task completed in ${duration}s_`);
    
    console.log(`✅ Posted voice transcript thread (task #${taskId}) to ${channel.name}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to post transcript thread: ${err.message}`);
    return false;
  }
}

// ── Record Mode Functions ────────────────────────────────────────────

async function startRecordMode(userId) {
  if (recordMode.active) return; // already recording
  recordMode.active = true;
  recordMode.startTime = Date.now();
  recordMode.thread = null;
  recordMode.entryCount = 0;

  // Create date-based directory: ~/meeting-transcripts/2026/02/23/
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dayDir = join(RECORD_DIR, String(year), month, day);
  try { mkdirSync(dayDir, { recursive: true }); } catch {}
  const timeStamp = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).replace(':', '');
  recordMode.filePath = join(dayDir, `meeting-${timeStamp}.md`);
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  writeFileSync(recordMode.filePath, `# Meeting Notes -- ${dateStr}, ${timeStr}\n\n`);

  // Post notification to #meeting-transcripts
  try {
    const chId = RECORD_TEXT_CHANNEL_ID || TEXT_CHANNEL_ID;
    let recChannel = client.channels.cache.get(chId);
    if (!recChannel) {
      const guild = client.guilds.cache.get(GUILD_ID);
      if (guild) recChannel = await guild.channels.fetch(chId);
    }
    if (recChannel) {
      await recChannel.send(`**Recording started** -- ${dateStr}, ${timeStr}`);
      console.log(`REC: notification posted to #meeting-transcripts`);
    } else {
      console.log(`REC: channel ${chId} not found for notification`);
    }
  } catch (err) {
    console.error(`REC: notification failed: ${err.message}`);
  }

  console.log(`REC: started -> ${recordMode.filePath}`);
}

async function stopRecordMode() {
  if (!recordMode.active) return;
  const durationMs = Date.now() - recordMode.startTime;
  const mins = Math.floor(durationMs / 60000);
  const secs = Math.floor((durationMs % 60000) / 1000);
  const durationStr = `${mins}m ${String(secs).padStart(2, '0')}s`;
  const entryCount = recordMode.entryCount;
  const filePath = recordMode.filePath;

  // Append footer to file
  if (filePath) {
    try { appendFileSync(filePath, `\n--- Recording ended ---\nDuration: ${durationStr} | Entries: ${entryCount}\n`); } catch {}
  }

  // Post stop notification to #meeting-transcripts (no transcript -- it's on disk)
  try {
    const chId = RECORD_TEXT_CHANNEL_ID || TEXT_CHANNEL_ID;
    let recChannel = client.channels.cache.get(chId);
    if (!recChannel) {
      const guild = client.guilds.cache.get(GUILD_ID);
      if (guild) recChannel = await guild.channels.fetch(chId);
    }
    if (recChannel) {
      await recChannel.send(`**Recording stopped** -- ${durationStr}, ${entryCount} entries\n\`${filePath}\``);
    }
  } catch (err) {
    console.error(`REC: failed to post stop notification: ${err.message}`);
  }

  console.log(`REC: stopped (${durationStr}, ${entryCount} entries) -> ${filePath}`);

  recordMode.active = false;
  recordMode.thread = null;
  recordMode.startTime = null;
  recordMode.filePath = null;
  recordMode.entryCount = 0;
}

function handleRecordModeSpeech(userId, sttResult) {
  const text = (sttResult?.text || '').trim();
  if (!text) return;
  if (isHallucination(text)) return;

  // Check for stop command
  if (/\b(stop|end)\s*record/i.test(text)) {
    return stopRecordMode();
  }

  // Timestamp offset from start
  const offsetMs = Date.now() - recordMode.startTime;
  const mm = String(Math.floor(offsetMs / 60000)).padStart(2, '0');
  const ss = String(Math.floor((offsetMs % 60000) / 1000)).padStart(2, '0');

  // Append to local file
  const line = `[${mm}:${ss}] ${text}`;
  if (recordMode.filePath) {
    try { appendFileSync(recordMode.filePath, line + '\n'); } catch {}
  }
  recordMode.entryCount++;
  console.log(`REC: [${mm}:${ss}] "${text.substring(0, 50)}"`);
}

async function handleVoiceDisconnect(userId) {
  const timeSinceLastInteraction = Date.now() - lastInteractionTime;
  const wasRecentlyActive = timeSinceLastInteraction < ACTIVE_CONVERSATION_WINDOW_MS;
  
  // Handle in-flight tasks — they'll detect userDisconnected and post to text
  if (activeTasks.size > 0) {
    console.log(`📤 ${activeTasks.size} tasks in flight — will handoff to text channel when ready`);
    return;
  }
  
  // Handle recent conversation handoff
  if (wasRecentlyActive && lastUserMessage) {
    console.log(`📤 Active conversation detected — posting handoff note to text channel`);
    const handoffMsg = `🎙️ Voice session ended. Last topic: "${lastUserMessage}". Continuing in text.`;
    await postToTextChannel(handoffMsg);
    return;
  }
  
  // Idle disconnect — silent exit
  console.log(`🔇 Idle disconnect (${Math.round(timeSinceLastInteraction / 1000)}s since last interaction) — no handoff`);
}

async function joinChannel(voiceChannelId, options = {}) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) throw new Error(`Guild ${GUILD_ID} not found`);
  // Fetch channel if not cached (needed for channels not seen at startup)
  let channel = guild.channels.cache.get(voiceChannelId);
  if (!channel) {
    try { channel = await guild.channels.fetch(voiceChannelId); } catch {}
  }
  if (!channel) throw new Error(`Voice channel ${voiceChannelId} not found`);
  console.log(`🔗 Joining voice channel: ${channel.name} (${voiceChannelId})`);
  
  // Destroy existing connection if switching channels
  if (currentConnection) {
    try { currentConnection.destroy(); } catch {}
    currentConnection = null;
    setVoiceConnection(null);
  }
  
  const connection = joinVoiceChannel({
    channelId: voiceChannelId,
    guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  
  // Catch voice connection errors (UDP/networking) to prevent process crash
  connection.on('error', (err) => {
    console.error('🔴 Voice connection error:', err.message);
  });
  
  // Log state transitions for debugging
  connection.on('stateChange', (oldState, newState) => {
    console.log(`🔊 Voice state: ${oldState.status} → ${newState.status}`);
  });

  // Wait for Ready state with timeout — destroy and retry if stuck
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    console.error(`⚠️ Connection timeout (stuck in ${connection.state.status}) — destroying and retrying`);
    try { connection.destroy(); } catch {}
    throw err; // Let caller handle retry
  }
  
  connection.subscribe(player);
  currentConnection = connection;
  setVoiceConnection(connection); // Wire speech-output.js connection validation
  currentVoiceChannelId = voiceChannelId;
  setCurrentVoiceChannelId(voiceChannelId);
  
  // Reconnect on disconnect — exponential backoff with text-mode fallback
  const handleDisconnect = async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // Successful reconnect — reset backoff
      reconnectState.reset();
      // Re-attach disconnect handler after successful reconnect
      connection.once(VoiceConnectionStatus.Disconnected, handleDisconnect);
    } catch {
      try { connection.destroy(); } catch {} // Guard against double-destroy race condition
      const delay = reconnectState.nextDelay();
      console.log(`⚠️  Disconnected (attempt #${reconnectState.attempts}), rejoining in ${delay / 1000}s...`);
      
      // After 5 failed reconnects, notify text channel and stand by
      if (reconnectState.attempts >= 5 && !reconnectState.textModeNotified) {
        reconnectState.textModeNotified = true;
        console.error('🔴 Voice connection unstable after 5 reconnect attempts');
        postToTextChannel('⚠️ **Voice connection unstable.** Standing by in text mode. Will keep retrying.');
      }
      
      setTimeout(async () => {
        try {
          await joinChannel(voiceChannelId);
          reconnectState.reset();
        } catch (err) {
          console.error(`❌ Reconnect attempt #${reconnectState.attempts} failed: ${err.message}`);
          // The next disconnect handler will trigger another attempt
        }
      }, delay);
    }
  };
  connection.once(VoiceConnectionStatus.Disconnected, handleDisconnect);
  
  // Listen to incoming audio
  const receiver = connection.receiver;
  // Clear any stale barge-in timers from previous connection
  for (const [uid, timer] of bargeInTimers) { clearTimeout(timer); }
  bargeInTimers.clear();
  const BARGE_IN_THRESHOLD_MS = 600;
  
  receiver.speaking.on('end', (userId) => {
    if (bargeInTimers.has(userId)) {
      clearTimeout(bargeInTimers.get(userId));
      bargeInTimers.delete(userId);
    }
  });
  
  receiver.speaking.on('start', (userId) => {
    // Multi-user: listen to everyone; Single-user: only ALLOWED_USERS
    if (!MULTI_USER_ENABLED && !ALLOWED_USERS.includes(userId)) return;
    
    // Barge-in detection — only primary users (ALLOWED_USERS) can barge-in
    if (isSpeaking && ALLOWED_USERS.includes(userId)) {
      if (!bargeInTimers.has(userId)) {
        const timer = setTimeout(() => {
          if (isSpeaking) {
            console.log(`⚡ Barge-in — stopping playback`);
            bargeInEvents.add(userId);
            player.stop(true);
            audioQueue.clear();
            isSpeaking = false;
          }
          bargeInTimers.delete(userId);
        }, BARGE_IN_THRESHOLD_MS);
        bargeInTimers.set(userId, timer);
      }
    }
    
    // Collect audio
    if (!userSpeaking.has(userId)) {
      const audioStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_THRESHOLD_MS },
      });
      
      const chunks = [];
      const decoder = new OpusDecoder();
      audioStream.pipe(decoder);
      
      decoder.on('data', (chunk) => chunks.push(chunk));
      
      // Clean up userSpeaking on error so future audio isn't blocked
      audioStream.once('error', (err) => {
        console.error(`Audio stream error for ${userId}:`, err.message);
        userSpeaking.delete(userId);
        decoder.destroy();
      });
      
      decoder.once('error', () => {}); // Suppress unhandled error on destroy
      
      audioStream.once('end', async () => {
        userSpeaking.delete(userId);
        const totalBuffer = Buffer.concat(chunks);
        const durationMs = (totalBuffer.length / (48000 * 2)) * 1000;
        
        if (durationMs < MIN_AUDIO_DURATION_MS) return;
        
        // Fully async — every utterance goes straight to handleSpeech
        // No blocking, no queueing. Multiple brain calls run concurrently.
        await handleSpeech(userId, totalBuffer);
      });
      
      userSpeaking.set(userId, { startTime: Date.now() });
    }
  });
  
  // Safety unmute on startup — previous instance may have left owner server-muted
  serverMuteOwner(false);

  if (options.greeting) await playGreeting();
  return connection;
}

async function playGreeting() {
  try {
    const audio = await synthesizeSpeech('Jarvis online. Voice channel is live.');
    if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
  } catch (err) {
    console.error('Greeting failed:', err.message);
  }
}

// ── Speech Processing Pipeline (Async — non-blocking) ────────────────
//
// Flow: User speaks → transcribe → dispatch background task → immediately ready
//       Background task completes → queue response → TTS when speaker is free
//
// Quick commands (focus, wake word only, alerts) are handled synchronously.
// Brain calls are fully async — multiple can run concurrently.

async function handleSpeech(userId, audioBuffer, preTranscribed = null) {
  const startTime = Date.now();
  let wavPath = null;

  // ── Enrollment Mode: capture audio clips for voiceprint ──
  // Audio-quality validation happens server-side (Silero VAD speech duration + embedding consistency).
  // No Whisper transcript validation -- enrollment captures voice characteristics, not diction.
  // Voice commands use lightweight Whisper transcription only when needed.
  if (enrollmentState.active && enrollmentState.userId === userId) {
    resetIdleSleepTimer(); // Keep auto-sleep at bay during enrollment
    const enrollWavPath = join(TMP_DIR, `enroll_${userId}_${Date.now()}.wav`);
    try {
      await savePcmAsWav(audioBuffer, enrollWavPath);
      const durationMs = (audioBuffer.length / (48000 * 2)) * 1000;
      // Lower threshold for enrollment -- server-side Silero VAD validates
      // actual speech duration (>400ms). Short wake word prompts like
      // "Yo Jarvis" or "I'm in" can be under 1.5s total.
      if (durationMs < 600) {
        try { unlinkSync(enrollWavPath); } catch {}
        return;
      }

      // Lightweight transcription for voice command detection only
      let clipTranscript = '';
      try {
        clipTranscript = (await transcribeWhisperOnly(enrollWavPath) || '').trim();
      } catch {}

      // Enrollment voice commands -- checked FIRST before clip submission
      const retryCheck = clipTranscript.toLowerCase().replace(/[.,!?]/g, '').trim();

      // "cancel" / "stop" / "cancel enrollment" / "quit"
      if (/\b(cancel|stop|quit|abort)\b/i.test(retryCheck) && !/passport/i.test(retryCheck)) {
        try { unlinkSync(enrollWavPath); } catch {}
        enrollmentState.cancel();
        console.log('Enrollment cancelled by voice command');
        const audio = await synthesizeSpeech('Enrollment cancelled.');
        if (audio) { audioQueue.add(audio); }
        return;
      }

      // "retry 5" / "redo 3" / "go back to 2" / "number 5"
      const retryNumMatch = retryCheck.match(/\b(retry|redo|repeat|go\s*back\s*(?:to)?|number|phrase)\s*(\d+)/i);
      if (retryNumMatch) {
        try { unlinkSync(enrollWavPath); } catch {}
        const num = parseInt(retryNumMatch[2]);
        const prompt = enrollmentState.goToPrompt(num);
        if (prompt) {
          postToCC('Enrollment', `[${num}/${enrollmentState.clipsNeeded}] Retry: **${prompt}**`);
          const audio = await synthesizeSpeech(`Going back to number ${num}: ${prompt}`);
          if (audio) { audioQueue.add(audio); }
        } else {
          const audio = await synthesizeSpeech(`There's no phrase number ${num}. Valid range is 1 to ${enrollmentState.clipsNeeded}.`);
          if (audio) { audioQueue.add(audio); }
        }
        return;
      }

      // "retry" / "again" / "try again" / "we try" (Whisper mishearing)
      if (/\b(retry|repeat|again|try\s*(it\s*)?again|one more|we\s*try)\b/i.test(retryCheck) && retryCheck.length < 30) {
        try { unlinkSync(enrollWavPath); } catch {}
        const prompt = enrollmentState.currentPrompt();
        if (prompt) {
          const num = enrollmentState.promptIndex + 1;
          postToCC('Enrollment', `[${num}/${enrollmentState.clipsNeeded}] Repeat: **${prompt}**`);
          const audio = await synthesizeSpeech(`OK, again: ${prompt}`);
          if (audio) { audioQueue.add(audio); }
        }
        return;
      }

      // "start over" / "restart" / "from the top" / "redo all"
      if (/\b(start\s*over|restart|from\s*the\s*(top|start|beginning)|redo\s*all|reset)\b/i.test(retryCheck)) {
        try { unlinkSync(enrollWavPath); } catch {}
        await fetch(`${SPEAKER_ENROLL_URL}/enroll/reset`, { method: 'POST' }).catch(() => {});
        enrollmentState.clipsCollected = 0;
        enrollmentState.promptIndex = 0;
        enrollmentState.recorded = new Array(ENROLLMENT_PROMPTS.length).fill(false);
        const firstPrompt = enrollmentState.currentPrompt();
        console.log('Enrollment restarted from 1/10');
        postToCC('Enrollment', `Starting over. [1/${enrollmentState.clipsNeeded}] Repeat: **${firstPrompt}**`);
        const audio = await synthesizeSpeech(`Starting over. First phrase: ${firstPrompt}`);
        if (audio) { audioQueue.add(audio); }
        return;
      }

      // "done" / "that's enough" / "finish" / "save"
      if (/\b(done|that'?s\s*enough|finish|finalize|save it|save)\b/i.test(retryCheck) && retryCheck.length < 30) {
        try { unlinkSync(enrollWavPath); } catch {}
        if (enrollmentState.clipsCollected >= 3) {
          const finalResult = await enrollmentState.finalize();
          if (finalResult.saved) {
            const audio = await synthesizeSpeech(`Voiceprint saved with ${finalResult.clips_saved || enrollmentState.clipsCollected} samples. Speaker verification is active.`);
            if (audio) { audioQueue.add(audio); }
            console.log(`Enrollment finalized early: ${enrollmentState.clipsCollected} clips`);
            postToCC('Enrollment', `Voiceprint saved (${enrollmentState.clipsCollected} clips). Done.`);
          }
        } else {
          const audio = await synthesizeSpeech(`Need at least 3 clips. You have ${enrollmentState.clipsCollected} so far.`);
          if (audio) { audioQueue.add(audio); }
        }
        return;
      }

      // "more" / "keep going" / "learn mode" / "add more"
      if (/\b(learn\s*mode|keep\s*going|add\s*more|more\s*samples|continue)\b/i.test(retryCheck)) {
        try { unlinkSync(enrollWavPath); } catch {}
        enrollmentState.learnMode = true;
        const audio = await synthesizeSpeech('Learn mode on. Keep speaking naturally and I\'ll add samples to improve your voiceprint. Say done when finished.');
        if (audio) { audioQueue.add(audio); }
        postToCC('Enrollment', 'Learn mode enabled. Speak naturally. Say **"done"** to save.');
        return;
      }

      // Submit clip to speaker verify service for audio-quality validation
      // Server checks: Silero VAD speech presence, speech duration (>400ms),
      // and embedding consistency (outlier detection after 3 clips)
      if (clipTranscript) {
        console.log(`Enrollment clip transcript: "${clipTranscript}"`);
        postToCC('Enrollment', clipTranscript);
      }

      const result = await enrollmentState.addClip(enrollWavPath);
      try { unlinkSync(enrollWavPath); } catch {}
      if (result.accepted) {
        const consistencyStr = result.consistency_score != null ? ` consistency=${result.consistency_score}` : '';
        console.log(`Enrollment clip ${enrollmentState.clipsCollected}/${enrollmentState.clipsNeeded} accepted${consistencyStr}`);

        if (enrollmentState.learnMode) {
          postToCC('Learn', `Clip ${enrollmentState.clipsCollected} added. Keep going or say **"done"** to save.`);
          const audio = await synthesizeSpeech(`Got it. ${enrollmentState.clipsCollected} samples total. Keep going or say done.`);
          if (audio) { audioQueue.add(audio); }
        } else if (enrollmentState.clipsCollected >= enrollmentState.clipsNeeded) {
          const finalResult = await enrollmentState.finalize();
          if (finalResult.saved) {
            const count = finalResult.clips_saved || enrollmentState.clipsCollected;
            console.log(`Enrollment complete: ${count} clips saved`);
            postToCC('Enrollment', `${enrollmentState.clipsCollected}/${enrollmentState.clipsNeeded} done. Voiceprint saved.`);
            const audio = await synthesizeSpeech(`${enrollmentState.clipsCollected} of ${enrollmentState.clipsNeeded}. Voiceprint saved with ${count} samples. Speaker verification is now active. Welcome aboard. Say "learn mode" any time to add more samples.`);
            if (audio) { audioQueue.add(audio); }
          } else {
            const audio = await synthesizeSpeech(`Enrollment failed. ${finalResult.error || 'Unknown error'}.`);
            if (audio) { audioQueue.add(audio); }
          }
        } else {
          const nextPrompt = enrollmentState.advanceToNext();
          if (nextPrompt) {
            const progress = `${enrollmentState.clipsCollected} of ${enrollmentState.clipsNeeded}. Next: ${nextPrompt}`;
            postToCC('Enrollment', `[${enrollmentState.clipsCollected}/${enrollmentState.clipsNeeded}] Repeat: **${nextPrompt}**`);
            const audio = await synthesizeSpeech(progress);
            if (audio) { audioQueue.add(audio); }
          }
        }
      } else {
        // Clip rejected by server (no speech, too short, or outlier embedding)
        console.log(`Enrollment clip rejected: ${result.reason}`);
        const prompt = enrollmentState.currentPrompt();
        if (result.reason === 'outlier_embedding') {
          postToCC('Enrollment', `Audio didn't match your voice pattern. Retry: **${prompt}**`);
          const audio = await synthesizeSpeech(`That clip didn't match your voice pattern. Try again: ${prompt}`);
          if (audio) { audioQueue.add(audio); }
        } else if (result.reason === 'speech_too_short') {
          postToCC('Enrollment', `Speech too short. Retry: **${prompt}**`);
          const audio = await synthesizeSpeech(`Too short. Speak a bit longer. ${prompt}`);
          if (audio) { audioQueue.add(audio); }
        } else if (prompt) {
          postToCC('Enrollment', `Retry: **${prompt}**`);
          const audio = await synthesizeSpeech(`I didn't catch that. Try again: ${prompt}`);
          if (audio) { audioQueue.add(audio); }
        }
      }
    } catch (err) {
      console.error('Enrollment capture error:', err.message);
      try { unlinkSync(enrollWavPath); } catch {}
    }
    return;
  }

  try {
    // 1. Transcribe (skip if already transcribed during queue)
    let rawTranscript;
    let sentiment = null;
    let needsEnrollment = false;
    let sttResult = null;
    if (preTranscribed) {
      rawTranscript = preTranscribed;
      console.log(`(pre-transcribed) "${rawTranscript}"`);
    } else {
      wavPath = join(TMP_DIR, `speech_${userId}_${Date.now()}.wav`);
      await savePcmAsWav(audioBuffer, wavPath);
      sttResult = await transcribeAudio(wavPath);
      rawTranscript = sttResult.text;
      sentiment = sttResult.sentiment;
      needsEnrollment = !!sttResult.needsEnrollment;

      // no_speech / low_confidence are silent drops (from Silero VAD / Whisper confidence)
      if (sttResult.rejected) {
        try { unlinkSync(wavPath); } catch {}
        return;
      }

      // Record mode: just grab the transcript, skip all other processing
      if (recordMode.active) {
        try { unlinkSync(wavPath); } catch {}
        wavPath = null;
        if (!rawTranscript || rawTranscript.trim().length === 0) return;
        return handleRecordModeSpeech(userId, sttResult);
      }

      try { unlinkSync(wavPath); } catch {}
      wavPath = null; // Cleaned up successfully
    }

    if (!rawTranscript || rawTranscript.trim().length === 0) return;

    // ── Record Mode: bypass all filters (pre-transcribed path) ──
    if (recordMode.active) {
      return handleRecordModeSpeech(userId, sttResult || { text: rawTranscript });
    }

    // ── Per-utterance speaker filter: reject non-owner audio (TV, ambient) ──
    // Even in ACTIVE sessions, drop audio where speaker verification says "not owner".
    // Long transcripts (>80 chars) from non-owner are almost certainly TV dialogue.
    // Exception: wake word at transcript start bypasses filter — "Jarvis" is uncommon
    // enough that TV rarely produces it, and owner's embedding gets corrupted by
    // TV background noise (scoring 0.30-0.33, same as pure TV).
    const spkr = sttResult?.speakerInfo;
    if (spkr && !spkr.is_owner) {
      const trimmed = rawTranscript.trim();
      const startsWithWakeWord = /^(hey[,.]?\s+)?jarvis\b/i.test(trimmed);
      if (startsWithWakeWord) {
        console.log(`🎯 Wake word from non-owner embedding (confidence=${spkr.confidence} norm=${spkr.norm_score}) — passing to FSM gate`);
        // Let it through — FSM gate will handle wake-up with unauthenticated session
      } else {
        const isLong = rawTranscript.length > 80;
        if (spkr.confidence_tier === 'low' || spkr.norm_score < 0.5 || isLong) {
          console.log(`🔇 Non-owner audio filtered (confidence=${spkr.confidence} norm=${spkr.norm_score} tier=${spkr.confidence_tier} len=${rawTranscript.length}): "${rawTranscript.substring(0, 50)}..."`);
          return;
        }
      }
    }

    // ── TV dialogue extraction: parse Jarvis command out of long noisy transcripts ──
    // When TV is playing, Whisper captures both TV dialogue and owner speech in one chunk.
    // Instead of dropping the whole thing, extract just the Jarvis command.
    // e.g. "...blah TV noise... Jarvis, check my messages. ...more TV noise..." → "Jarvis, check my messages."
    if (rawTranscript.length > 60 && getState() === 'SLEEP') {
      const jarvisIdx = rawTranscript.search(/\b(jarvis|gargis|service)\b/i);
      if (jarvisIdx > 20) {
        // "Jarvis" is buried deep -- TV dialogue before it. Extract from Jarvis onward.
        const fromJarvis = rawTranscript.substring(jarvisIdx);
        const sentenceEnd = fromJarvis.match(/[.!?]\s/g);
        const extracted = sentenceEnd && sentenceEnd.length >= 2
          ? fromJarvis.substring(0, fromJarvis.indexOf(sentenceEnd[1]) + sentenceEnd[1].length).trim()
          : fromJarvis.substring(0, 200).trim();
        console.log(`🔧 TV noise extraction: ${rawTranscript.length} chars → ${extracted.length} chars: "${extracted.substring(0, 80)}"`);
        rawTranscript = extracted;
      } else if (jarvisIdx === -1 && spkr && spkr.confidence_tier === 'low') {
        // Long transcript, no Jarvis, LOW confidence only -- pure TV dialogue
        console.log(`🔇 TV dialogue filtered (norm=${spkr.norm_score} tier=${spkr.confidence_tier} len=${rawTranscript.length}): "${rawTranscript.substring(0, 60)}..."`);
        return;
      }
    }

    // ── Record Mode trigger: "Jarvis, record mode" from any FSM state ──
    if (!recordMode.active && /jarvis/i.test(rawTranscript) && /\b(record\s*(mode|meeting|this)?|start\s*recording)\b/i.test(rawTranscript)) {
      return startRecordMode(userId);
    }

    // ── FSM State Gate: SLEEP drops all except wake-up, IDLE requires wake word ──
    const currentState = getState();
    const spkrTag = spkr ? `${spkr.confidence_tier}(${spkr.confidence})` : 'null';
    console.log(`[FSM-gate] state=${currentState} speaker=${spkrTag} transcript="${rawTranscript.substring(0, 40)}..."`);
    postActivity(`🎤 \`${currentState}\` speaker=${spkrTag} → "${truncate(rawTranscript, 100)}"`);

    // SLEEP: only wake-up commands pass (including fuzzy wake word when speaker verified)
    const spkrIsOwner = !!(spkr?.is_owner);
    if (currentState === 'SLEEP') {
      if (isWakeUpCommand(rawTranscript, spkrIsOwner)) {
        const wakeSpkr = sttResult?.speakerInfo;
        // Allow wake word even with TV-corrupted embeddings — "Jarvis" is rare on TV.
        // Session stays unauthenticated so follow-up commands need clean speaker verify.
        transition('ACTIVE', 'wake-word');
        authenticatedSession = !!(wakeSpkr?.is_owner);
        resetIdleSleepTimer();
        // Strip wake word prefix: try standard patterns first, fall back to fuzzy vocative
        let stripped = rawTranscript.replace(/^(hey\s+)?jarvis[,.]?\s*/i, '').trim();
        if (stripped === rawTranscript.trim()) {
          // Standard strip didn't match — try fuzzy vocative prefix ([word], sentence)
          stripped = rawTranscript.replace(/^[a-zA-Z]{1,12}[,.]?\s+/i, '').trim();
        }
        if (stripped.length > 2) {
          console.log(`SLEEP -> ACTIVE with command (authenticated=${authenticatedSession}): "${stripped}"`);
          // fall through to process
        } else {
          console.log(`SLEEP -> ACTIVE (bare wake word, authenticated=${authenticatedSession})`);
          const audio = await synthesizeSpeech('Back online. What do you need?');
          if (audio) { audioQueue.add(audio); }
          markBotResponse(userId);
          return;
        }
      } else {
        return; // drop in SLEEP
      }
    }

    // IDLE: wake word OR continuation phrases pass (including fuzzy wake word when speaker verified)
    if (currentState === 'IDLE') {
      if (isWakeUpCommand(rawTranscript, spkrIsOwner)) {
        const wakeSpkr = sttResult?.speakerInfo;
        // Allow wake word even with TV-corrupted embeddings (see SLEEP comment above)
        transition('ACTIVE', 'wake-word-from-idle');
        authenticatedSession = !!(wakeSpkr?.is_owner);
        resetIdleSleepTimer();
        // fall through -- checkWakeWord handles transcript cleaning
      } else if (isContinuationPhrase(rawTranscript) && hasRecentContext(userId)) {
        // Follow-up to recent conversation -- no wake word needed
        console.log(`💬 Continuation phrase in IDLE: "${rawTranscript.substring(0, 50)}" -- resuming`);
        transition('ACTIVE', 'continuation-from-idle');
        authenticatedSession = true; // trust context -- was authenticated before IDLE
        resetIdleSleepTimer();
        // fall through to process
      } else if (spkr?.is_owner && spkr?.confidence_tier === 'high' && hasRecentContext(userId) && isFollowUpExpected()) {
        // Verified owner responding to an alert/prompt -- speaker ID is the auth
        console.log(`Owner response to alert/prompt in IDLE (speaker=${spkr.confidence} tier=${spkr.confidence_tier}) -- no wake word needed`);
        transition('ACTIVE', 'owner-response-from-idle');
        authenticatedSession = true;
        resetIdleSleepTimer();
        // fall through to process
      } else {
        return; // drop non-wake-word audio in IDLE
      }
    }

    // Filter Whisper hallucinations — phantom phrases from silence/ambient
    if (isHallucination(rawTranscript)) {
      console.log(`Whisper hallucination filtered: "${rawTranscript}"`);
      return;
    }

    console.log(`📝 "${rawTranscript}" (${Date.now() - startTime}ms)`);
    postToCC('🎤', rawTranscript);

    // ── Pre-wake-word sleep check (two-tier) ──
    // Tier 1: Standalone sleep — pure sleep command, no task content → immediate sleep
    // Tier 2: Sign-off + task — "we're good, check my email" → dispatch task, auto-sleep after
    const preSleepCheck = rawTranscript.toLowerCase().replace(/[.,!?]/g, '').replace(/\bjarvis\b/gi, '').trim();
    if (shouldSleep(preSleepCheck)) {
      if (hasTaskContent(preSleepCheck)) {
        // Tier 2: sign-off embedded in a task request — let the task flow through
        console.log(`Task detected with sign-off (pre-wake) — will auto-sleep after response: "${preSleepCheck}"`);
        _pendingUtterance.autoSleepAfterTask = true;
        // DON'T return — fall through to wake word detection and task dispatch
      } else {
        // Tier 1: pure sleep command — no task content
        console.log(`Sleep mode activated (no wake word): "${preSleepCheck}"`);
        transition('SLEEP', 'voice-command-pre-wake');
        authenticatedSession = false;
        endConversationWindow(userId);
        const isConversational = /\b(sounds?\s*good|thanks?|thank\s*you|cheers|talk\s*to\s*you|catch\s*you|have\s*a\s*good|appreciate|later|all\s*set|im\s*(good|done|all set))\b/i.test(preSleepCheck);
        const farewells = isConversational
          ? ['Anytime, sir.', 'Of course.', 'Very good, sir.', 'Cheers.']
          : ['Going quiet. Just say my name when you need me.'];
        const farewell = farewells[Math.floor(Math.random() * farewells.length)];
        const ack = await synthesizeSpeech(farewell);
        if (ack) { audioQueue.add(ack); }
        return;
      }
    }

    // Log sentiment if detected
    if (sentiment && sentiment.sentiment) {
      const scoreStr = sentiment.sentiment_score != null ? ` (${sentiment.sentiment_score.toFixed(2)})` : '';
      console.log(`🎭 Sentiment: ${sentiment.sentiment}${scoreStr}`);
      postActivity(`🎭 Sentiment: ${sentiment.sentiment}${scoreStr}`);
    }

    // 2. Wake word check
    // For fuzzy wake word: accept medium confidence tier too — Whisper mishears "Jarvis" as
    // phonetically similar words (Curtis, Gervas, jargos) which score medium, not high.
    // is_owner=true (high confidence) OR medium tier both count as "speaker likely verified".
    const speakerLikelyOwner = !!(spkr?.is_owner) || spkr?.confidence_tier === 'medium';
    const { detected, cleanedTranscript, wakeWordUsed } = checkWakeWord(rawTranscript, userId, speakerLikelyOwner);
    if (!detected) return;

    // ── Session-Based Speaker Authentication ──
    // Like Siri/Google: verify on wake word, trust the session after.
    // sttResult.speakerInfo comes from ECAPA-TDNN in stt.js.
    const speakerInfo = sttResult?.speakerInfo;
    if (speakerInfo && !authenticatedSession) {
      // Wake word detected -- this is the authentication moment
      // confidence_tier from server: "high" (auto-accept), "medium" (accept in session context), "low" (reject)
      if (speakerInfo.is_owner) {
        authenticatedSession = true;
        const tier = speakerInfo.confidence_tier || 'unknown';
        console.log(`Session authenticated (wake word confidence=${speakerInfo.confidence} tier=${tier})`);
      } else {
        // Check for passphrase override
        const cleanLowerAuth = cleanedTranscript.toLowerCase().replace(/[.,!?]/g, '').trim();
        if (SESSION_PASSPHRASE && cleanLowerAuth.includes(SESSION_PASSPHRASE.toLowerCase())) {
          authenticatedSession = true;
          console.log(`🔓 Session authenticated (passphrase override, confidence=${speakerInfo.confidence})`);
        } else {
          // Speaker doesn't match on wake word — reject with throttled rebuff
          const now = Date.now();
          if (!handleSpeech._lastRebuff || now - handleSpeech._lastRebuff > 60000) {
            handleSpeech._lastRebuff = now;
            const rebuffs = [
              "I'm sorry, I only respond to my principal's voice.",
              "Voice not recognized. Access denied.",
              "I don't recognize you. Only my principal can wake me.",
            ];
            const rebuff = rebuffs[Math.floor(Math.random() * rebuffs.length)];
            console.log(`🔒 Wake word rejected: confidence=${speakerInfo.confidence}`);
            try {
              const audio = await synthesizeSpeech(rebuff);
              if (audio) { audioQueue.add(audio); }
            } catch {}
          } else {
            console.log(`🔒 Wake word rejected (throttled): confidence=${speakerInfo.confidence}`);
          }
          return;
        }
      }
    } else if (authenticatedSession) {
      // Session authenticated -- but still reject clearly non-owner audio (TV/ambient)
      // The per-utterance filter above catches most, but double-check here for safety
      if (speakerInfo && !speakerInfo.is_owner && speakerInfo.confidence_tier === 'low') {
        console.log(`🔇 Active session: non-owner audio rejected (confidence=${speakerInfo.confidence} tier=${speakerInfo.confidence_tier})`);
        return;
      }
      if (speakerInfo) {
        console.log(`Session active (confidence=${speakerInfo.confidence} tier=${speakerInfo.confidence_tier || ''})`);
      }
    }
    // If speakerInfo is null (service down / disabled), allow through (graceful degradation)

    // Ensure we're in ACTIVE state when processing authenticated commands
    if (getState() !== 'ACTIVE') {
      transition('ACTIVE', 'speaker-authenticated');
    }

    // Real interaction -- reset idle sleep timer
    resetIdleSleepTimer();

    // ── Sleep Mode (two-tier): Stop listening entirely until wake-up command ──
    // Tier 1: Standalone sleep — pure sleep command, no task content → immediate sleep
    // Tier 2: Sign-off + task — "we're good, check my email" → dispatch task, auto-sleep after
    const cleanLower = cleanedTranscript.toLowerCase().replace(/[.,!?]/g, '').trim();
    if (shouldSleep(cleanLower)) {
      if (hasTaskContent(cleanLower)) {
        // Tier 2: sign-off embedded in a task request — let the task flow through
        console.log(`Task detected with sign-off (post-wake) — will auto-sleep after response: "${cleanLower}"`);
        _pendingUtterance.autoSleepAfterTask = true;
        // DON'T return — fall through to task dispatch
      } else {
        // Tier 1: pure sleep command — no task content
        console.log(`Sleep mode activated: "${cleanLower}"`);
        transition('SLEEP', 'voice-command');
        authenticatedSession = false;
        endConversationWindow(userId);
        // Natural farewell — match the tone of the sign-off
        const isConversational = /\b(sounds?\s*good|thanks?|thank\s*you|cheers|talk\s*to\s*you|catch\s*you|have\s*a\s*good|appreciate|later|all\s*set|im\s*(good|done|all set))\b/i.test(cleanLower);
        const farewells = isConversational
          ? ['Anytime, sir.', 'Of course.', 'Very good, sir.', 'Cheers.']
          : ['Going quiet. Just say my name when you need me.'];
        const farewell = farewells[Math.floor(Math.random() * farewells.length)];
        const ack = await synthesizeSpeech(farewell);
        if (ack) { audioQueue.add(ack); }
        return;
      }
    }
    // ──────────────────────────────────────────────────────

    // ── Enrollment Gating: no voiceprint enrolled (strict mode) ──
    // Only allow "enroll my voice" and sleep commands; block everything else.
    // Placed after wake word + sleep check so "Jarvis, go to sleep" works without auth.
    if (needsEnrollment) {
      const isEnrollCmd = rawTranscript.match(/(en\s*roll|in\s*roll|and\s*roll|can\s*roll|un\s*roll)\s*(my\s*)?voice/i);
      if (!isEnrollCmd) {
        if (!handleSpeech._lastEnrollPrompt || Date.now() - handleSpeech._lastEnrollPrompt > 30000) {
          handleSpeech._lastEnrollPrompt = Date.now();
          console.log('No voiceprint enrolled -- prompting enrollment');
          const audio = await synthesizeSpeech('No voiceprint on file. Say "Jarvis, enroll my voice" to set up speaker verification.');
          if (audio) { audioQueue.add(audio); }
        }
        return;
      }
    }

    // 3. Stop words — dismiss phrases that don't need a response (length-gated)
    const dismissResult = shouldDismiss(cleanedTranscript);
    if (dismissResult.dismiss) {
      console.log(`🤚 Stop word dismissed (${dismissResult.reason}): "${cleanedTranscript}"`);
      return;
    }

    // 3b. Side-talk — short non-directed speech in conversation window
    if (isSideTalk(cleanedTranscript, wakeWordUsed)) {
      console.log(`💭 Side-talk dismissed (no wake word, short): "${cleanedTranscript}"`);
      return;
    }

    // 4. Bare wake word — just "Jarvis" / "Jarvis." / "Jarvis?" with no real command.
    const bareCheck = cleanedTranscript.replace(/[.,!?;:\-'"]/g, '').trim();
    if (!bareCheck || bareCheck.length === 0) {
      console.log(`🎯 Bare wake word — acknowledging`);
      const acks = ['Sir?', 'At your service.', 'Yes, sir?', 'How can I help?', 'Listening.'];
      const ack = acks[Math.floor(Math.random() * acks.length)];
      const audio = await synthesizeSpeech(ack);
      if (audio) { audioQueue.add(audio); audioQueue.playNext(); }
      markBotResponse(userId);
      return;
    }

    const transcript = cleanedTranscript;

    // Stop word filter: drop exact-match filler phrases
    const STOP_WORDS = ['sounds good', 'thank you', 'thanks', 'obviously', 'ok', 'okay'];
    const normalizedTranscript = transcript.trim().toLowerCase().replace(/[.,!?]+$/, '');
    if (STOP_WORDS.includes(normalizedTranscript)) {
      console.log(`[voice] stop word filtered: "${transcript}"`);
      return;
    }

    // Track interaction for handoff detection
    lastInteractionTime = Date.now();
    lastUserMessage = transcript.substring(0, 100);
    
    // ── TL;DR mode toggle detection (admin only) ──
    const tldrToggle = ALLOWED_USERS.includes(userId) ? isTldrToggleCommand(rawTranscript) : null;
    if (tldrToggle !== null) {
      const newState = tldrToggle ? 'enabled' : 'disabled';
      const success = setTldrMode(tldrToggle);
      if (success) {
        console.log(`🎙️ Voice TL;DR mode ${newState}`);
        const ack = await synthesizeSpeech(`Voice TL;DR mode ${newState}.`);
        if (ack) { await playAudio(ack); try { unlinkSync(ack); } catch {} }
      }
      return;
    }
    
    // ── Full transcript mode toggle detection (admin only) ──
    const transcriptToggle = ALLOWED_USERS.includes(userId) ? isTranscriptToggleCommand(rawTranscript) : null;
    if (transcriptToggle !== null) {
      const newState = transcriptToggle ? 'enabled' : 'disabled';
      const success = setTranscriptMode(transcriptToggle);
      if (success) {
        console.log(`📝 Voice full transcript mode ${newState}`);
        const ack = await synthesizeSpeech(`Full transcript mode ${newState}.`);
        if (ack) { await playAudio(ack); try { unlinkSync(ack); } catch {} }
      }
      return;
    }
    
    // ── Ask mode toggle detection (admin only) ──
    const askToggle = ALLOWED_USERS.includes(userId) ? isAskModeToggleCommand(rawTranscript) : null;
    if (askToggle !== null) {
      const newState = askToggle ? 'enabled' : 'disabled';
      const success = setAskMode(askToggle);
      if (success) {
        console.log(`🛡️ Ask mode ${newState}`);
        const ack = await synthesizeSpeech(askToggle
          ? `Ask mode enabled. I'll confirm before taking any actions.`
          : `Ask mode disabled. Executing freely.`);
        if (ack) { await playAudio(ack); try { unlinkSync(ack); } catch {} }
      }
      return;
    }

    // ── TTS provider toggle detection (admin only) ──
    const ttsToggle = ALLOWED_USERS.includes(userId) ? isTtsToggleCommand(rawTranscript) : null;
    if (ttsToggle) {
      const success = setTtsProvider(ttsToggle);
      if (success) {
        const voiceName = ttsToggle === 'edge' ? 'Ryan' : 'JARVIS';
        console.log(`🎭 Switched to ${ttsToggle} TTS (${voiceName})`);
        const ack = await synthesizeSpeech(`Switched to ${voiceName} voice.`);
        if (ack) { await playAudio(ack); try { unlinkSync(ack); } catch {} }
      }
      return;
    }
    
    // ── Mobile / on-the-go mode toggle (admin only) ──
    const mobileToggle = ALLOWED_USERS.includes(userId) ? isMobileModeToggle(rawTranscript) : null;
    if (mobileToggle !== null) {
      const newState = mobileToggle ? 'enabled' : 'disabled';
      const success = setMobileMode(mobileToggle);
      if (success) {
        console.log(`📱 Mobile mode ${newState}`);
        const ack = await synthesizeSpeech(mobileToggle
          ? `Mobile mode on. I'll narrate as I work and keep you updated hands-free.`
          : `Mobile mode off. Back to standard voice output.`);
        if (ack) { await playAudio(ack); try { unlinkSync(ack); } catch {} }
      }
      return;
    }

    // ── Voice enrollment command (admin only) ──
    const enrollMatch = rawTranscript.match(/(en\s*roll|in\s*roll|and\s*roll|can\s*roll|un\s*roll)\s*(my\s*)?voice/i);
    const restartEnrollMatch = cleanedTranscript.match(/^(restart|redo|reset)\s*(enroll|enrollment|voice)/i);
    const cancelEnrollMatch = cleanedTranscript.match(/^(cancel|stop)\s*enroll/i);
    if (ALLOWED_USERS.includes(userId) && cancelEnrollMatch && enrollmentState.active) {
      enrollmentState.cancel();
      const audio = await synthesizeSpeech('Enrollment cancelled.');
      if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
      return;
    }
    // "restart enrollment" — wipe voiceprints and start fresh
    if (ALLOWED_USERS.includes(userId) && restartEnrollMatch) {
      try {
        const { unlinkSync: ul } = await import('fs');
        const { join: j } = await import('path');
        const home = process.env.HOME || '/tmp';
        const vp1 = j(home, '.jarvis', 'owner_voiceprint.npy');
        const vp2 = j(home, '.jarvis', 'owner_voiceprints.npy');
        try { ul(vp1); } catch {}
        try { ul(vp2); } catch {}
        // Reset on the service side too
        await fetch(`${SPEAKER_ENROLL_URL}/enroll/reset`, { method: 'POST' }).catch(() => {});
        console.log('Voiceprints wiped — starting fresh enrollment');
      } catch (e) { console.error('Voiceprint wipe error:', e.message); }
      // Fall through to start enrollment
    }
    // "learn mode" / "add samples" — add more clips to existing voiceprint
    const learnMatch = cleanedTranscript.match(/^(learn\s*mode|add\s*(more\s*)?samples|improve\s*voice)/i);
    if (ALLOWED_USERS.includes(userId) && learnMatch) {
      enrollmentState.start(userId, true); // learn=true
      console.log('Learn mode started — adding samples to voiceprint');
      postToCC('🎙️ Learn Mode', 'Speak naturally. Each clip improves your voiceprint. Say **"done"** to save.');
      const audio = await synthesizeSpeech('Learn mode on. Just talk naturally and I\'ll add each clip to your voiceprint. Say done when finished.');
      if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
      return;
    }

    if (ALLOWED_USERS.includes(userId) && (enrollMatch || restartEnrollMatch)) {
      enrollmentState.start(userId);
      const firstPrompt = enrollmentState.currentPrompt();
      console.log(`Voice enrollment started -- ${enrollmentState.clipsNeeded} guided phrases`);
      postToCC('🎙️ Enrollment', [
        `Starting voice enrollment (${enrollmentState.clipsNeeded} phrases).`,
        `**"retry"** — repeat the current phrase`,
        `**"retry 5"** — jump back to phrase #5`,
        `**"start over"** — restart from #1`,
        `**"done"** — save early (min 3 clips)`,
        `**"more"** — switch to learn mode after finishing`,
        `**"cancel enrollment"** — abort`,
        `[1/${enrollmentState.clipsNeeded}] Repeat: **${firstPrompt}**`,
      ].join('\n'));
      const audio = await synthesizeSpeech(`Voice enrollment. ${enrollmentState.clipsNeeded} phrases. First: ${firstPrompt}`);
      if (audio) { await playAudio(audio); try { unlinkSync(audio); } catch {} }
      return;
    }

    // ── Interrupt/stop detection (cancels all active tasks) ──
    // This MUST stay local -- it needs to kill in-flight audio/tasks immediately
    // Only ALLOWED_USERS can use interrupt commands (admin control)
    if (ALLOWED_USERS.includes(userId) && isInterruptCommand(rawTranscript)) {
      console.log(`⛔ Interrupt command: "${rawTranscript}"`);
      cancelAllTasks();
      const stopAudio = await synthesizeSpeech('Stopped.');
      if (stopAudio) { await playAudio(stopAudio); try { unlinkSync(stopAudio); } catch {} }
      return;
    }

    // Wake word only (no actual question) — local chime, no gateway round-trip
    const trimmed = transcript.trim().replace(/[.,!?]/g, '');
    if (!trimmed || trimmed.length < 2) {
      markBotResponse(userId);
      const chime = await synthesizeSpeech('Yes?');
      if (chime) { playAudio(chime).then(() => { try { unlinkSync(chime); } catch {} }).catch(() => {}); }
      return;
    }
    
    // ── Background brain call (async — non-blocking) ──
    
    if (!conversations.has(userId)) conversations.set(userId, { history: [], lastActive: Date.now() });
    const conv = conversations.get(userId);
    conv.lastActive = Date.now();
    
    // Add user message to history immediately
    conv.history.push({ role: 'user', content: transcript });
    while (conv.history.length > 40) conv.history.shift();
    
    // Resolve speaker display name for multi-user identification
    let speakerName = null;
    if (MULTI_USER_ENABLED) {
      try {
        const guild = client.guilds.cache.get(GUILD_ID);
        const member = guild?.members?.cache?.get(userId);
        speakerName = member?.displayName || member?.user?.username || null;
      } catch {}
    }
    
    // ── Transcript deduplication (prevent duplicate answers) ──
    // If the same (or very similar) transcript was dispatched within the last 15s, skip it.
    const transcriptKey = transcript.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80);
    const now = Date.now();
    if (!handleSpeech._recentTranscripts) handleSpeech._recentTranscripts = new Map();
    const lastSeen = handleSpeech._recentTranscripts.get(transcriptKey);
    if (lastSeen && now - lastSeen < 15000) {
      console.log(`⏭️  Transcript dedup: skipping duplicate "${transcript.substring(0, 40)}..." (${now - lastSeen}ms ago)`);
      return;
    }
    handleSpeech._recentTranscripts.set(transcriptKey, now);
    // Clean old entries every 50 calls
    if (handleSpeech._recentTranscripts.size > 50) {
      for (const [k, t] of handleSpeech._recentTranscripts) {
        if (now - t > 30000) handleSpeech._recentTranscripts.delete(k);
      }
    }
    
    // Dispatch via utterance grouping (debounce rapid fragments into one task)
    queueUtterance(userId, transcript, conv, speakerName, sentiment);
    
  } catch (err) {
    console.error('❌ Speech dispatch error:', err);
    // Only give audio feedback for real STT service failures (not empty/ambient noise)
    if (err.message && err.message.includes('STT failed') && !err.message.includes('Empty transcript')) {
      try {
        const failAudio = await synthesizeSpeech("I couldn't understand that. Could you try again?");
        if (failAudio) { await playAudio(failAudio); try { unlinkSync(failAudio); } catch {} }
      } catch {}
    }
  } finally {
    // Clean up WAV file if it wasn't already deleted
    if (wavPath) { try { unlinkSync(wavPath); } catch {} }
  }
}

/**
 * Background brain task — runs concurrently, queues result for TTS
 * @param {number} taskId
 * @param {string} userId
 * @param {string} transcript
 * @param {Array} history
 * @param {AbortSignal} signal
 * @param {object} [brainOptions] - Options to pass to brain { speaker, sentiment }
 */
async function processBrainTask(taskId, userId, transcript, history, signal, brainOptions = {}) {
  const startTime = Date.now();
  let firstAudioLogged = false;
  let fullResponse = '';
  const tldrModeEnabled = isTldrModeEnabled();

  // ── Two-Phase Async Voice Dispatch ──────────────────────────────────
  // Phase 1: Generate a fast 1-sentence ack (haiku, no tools, ~1-2s)
  // Phase 2: Fire the real task via webhook (fire-and-forget, result via /speak)
  // This keeps the voice queue non-blocking regardless of tool call duration.
  // No timeouts needed — phase 1 always returns, phase 2 runs until done.
  // ─────────────────────────────────────────────────────────────────────
  
  try {
    // Graceful degradation: if gateway is down, tell the user instead of failing silently
    if (isGatewayCircuitOpen()) {
      console.warn(`🔴 Task #${taskId} — gateway circuit breaker is open, informing user`);
      const degradedMsg = "I'm having trouble reaching my brain at the moment. Give me a moment to recover.";
      try {
        const audio = await synthesizeSpeech(degradedMsg);
        if (audio) audioQueue.add(audio);
      } catch (_) { /* TTS failure is non-fatal */ }
      await postToTextChannel(`⚠️ ${degradedMsg}`);
      postActivity(`🔴 **Task #${taskId}** skipped — gateway circuit breaker open`);
      return;
    }

    if (!isGatewayHealthy()) {
      console.warn(`🟡 Task #${taskId} — gateway unhealthy, proceeding with caution`);
    }

    console.log(`🧠 Task #${taskId} thinking...`);

    // Phase 1: Fast Ack (Haiku)
    // Buy time for the main model to think. Returns in ~1-2s.
    // Controlled by IMMEDIATE_ACKS_ENABLED and VOICE_ACK_ENABLED env flags (both default ON).
    // Set VOICE_ACK_ENABLED=false to suppress all acks (master flag).
    // Set IMMEDIATE_ACKS_ENABLED=false to suppress only the fast pre-emptive Haiku ack.
    if (IMMEDIATE_ACKS_ENABLED && VOICE_ACK_ENABLED) {
      try {
        const ackText = await generateAck(transcript);
        if (ackText) {
          console.log(`⚡ Ack: "${ackText}"`);
          const ackAudio = await synthesizeSpeech(ackText);
          if (ackAudio) audioQueue.add(ackAudio);
        }
      } catch (e) {
        console.warn(`⚠️ Ack failed: ${e.message}`);
      }
    }

    // ── Contextual Dispatch Ack (Jarvis-style) ───────────────────────
    // Fire contextual ack generation in parallel with the gateway request.
    // If the gateway returns empty/silent (sub-agent spawned), we speak the
    // pre-generated contextual ack. If the gateway returns a direct answer,
    // we discard the ack. This gives us ~0s latency on the ack when needed.
    let contextualAckPromise = null;
    if (AGENT_DISPATCH_ACK_ENABLED && !IMMEDIATE_ACKS_ENABLED) {
      // Only fire contextual ack if the old generic ack system is OFF
      // (avoids double-acking). Contextual ack replaces the generic system.
      contextualAckPromise = generateContextualAck(transcript).catch(err => {
        console.warn(`⚠️ Contextual ack failed: ${err.message}`);
        return null;
      });
    }

    // TTS pipeline for parallel sentence generation
    const ttsPipeline = new TtsPipeline(synthesizeSpeech, audioQueue, {
      maxConcurrent: 3,
      onError: (err) => console.error(`TTS pipeline error for task #${taskId}:`, err.message),
    });
    
    // ── Streaming TTS with pipelined delivery ──────────────────────────
    // Strategy: accumulate text into moderate chunks (~80-200 chars) and
    // feed them to the TtsPipeline which pre-generates 3 sentences ahead.
    // This avoids the old pattern of buffering 500 chars then dumping.
    //
    // Key changes from previous approach:
    // 1. Use TtsPipeline (parallel pre-generation + ordered playback)
    // 2. Non-blocking: pipeline.add() returns immediately
    // 3. Smaller chunks flush sooner → first audio arrives faster
    // 4. <p> markers still create natural pauses between paragraphs
    
    const BATCH_FLUSH_MIN = 40;   // Min chars before flushing -- lower for faster first-audio
    const BATCH_FLUSH_MAX = 150;  // Max chars before forced flush (keeps chunks digestible)
    let batchText = '';
    let batchNum = 0;
    
    // Feed a chunk to the TTS pipeline (non-blocking)
    let lastFlushedText = '';
    const flushToPipeline = (text) => {
      text = trimForVoice(text.replace(/<p>/g, '').trim());
      if (!text || text.length < 2) return;
      // Filter out agent signal fragments (NO_REPLY, HEARTBEAT_OK, bare NO)
      if (/^\s*(NO_REPLY|HEARTBEAT_OK|NO)\s*[.!?]*\s*$/i.test(text)) return;
      // Deduplicate repeated phrases (e.g. "On it, sir.On it, sir." -> "On it, sir.")
      const deduped = text.replace(/(.{8,}?[.!?])\s*\1/g, '$1');
      if (deduped !== text) {
        console.log(`🔁 Deduped chunk: "${text.substring(0, 40)}" → "${deduped.substring(0, 40)}"`);
        text = deduped;
      }
      if (!text || text.length < 2) return;
      // Skip if identical to last flushed chunk
      if (text === lastFlushedText) {
        console.log(`⏭️  Skipping duplicate chunk: "${text.substring(0, 40)}"`);
        return;
      }
      lastFlushedText = text;

      // Self-mute queue intercept — capture text instead of synthesizing
      if (MUTE_QUEUE_ENABLED && isMuteQueueActive()) {
        muteQueueAdd(text, 'task', 3);
        console.log(`🔇 Chunk intercepted → mute queue (${text.length} chars)`);
        return;
      }

      batchNum++;
      console.log(`🔊 Chunk #${batchNum}: ${text.length} chars → pipeline`);
      ttsPipeline.add(text);
    };
    
    const result = await generateResponseStreaming(transcript, history, signal, (sentence) => {
      sentence = trimForVoice(sentence);
      if (!sentence || sentence.length < 2) return;
      // Filter signal fragments (_NO, NO_, NO_REPLY, _NO_REPLY, HEARTBEAT_OK partials)
      if (/^\s*_?(NO_?R?E?P?L?Y?|HEARTBEAT_?O?K?|NO)\s*[.!?]*\s*$/i.test(sentence)) return;

      fullResponse += sentence + ' ';

      if (!firstAudioLogged) {
        firstAudioLogged = true;
        console.log(`⏱️  Task #${taskId} first sentence: ${Date.now() - startTime}ms`);
      }

      console.log(`📨 Task #${taskId} onSentence: "${sentence.substring(0, 60)}..." (${sentence.length} chars, tldr=${tldrModeEnabled}, disconnected=${userDisconnected}, ttsAvail=${isTTSAvailable()})`);

      if (!tldrModeEnabled) {
        if (userDisconnected) {
          postToTextChannel(`🎙️ ${sentence}`);
        } else if (!isTTSAvailable()) {
          postToTextChannel(`🔇 ${sentence}`);
        } else {
          // Handle <p> paragraph markers — flush before the break
          if (sentence.includes('<p>')) {
            const parts = sentence.split('<p>');
            batchText += parts[0] + ' ';
            if (batchText.trim().length >= BATCH_FLUSH_MIN) {
              flushToPipeline(batchText);
              batchText = '';
            }
            if (parts[1] && parts[1].trim()) {
              batchText += parts[1].trim() + ' ';
            }
          } else {
            batchText += sentence + ' ';
            // Flush when we have enough for a natural-sounding chunk
            if (batchText.length >= BATCH_FLUSH_MAX) {
              flushToPipeline(batchText);
              batchText = '';
            }
          }
        }
      }
    }, brainOptions);
    
    // Task was cancelled
    if (result.aborted) {
      console.log(`Task #${taskId} aborted`);
      ttsPipeline.clear();
      audioQueue.clear();
      postActivity(`**Task #${taskId}** cancelled after ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
      return;
    }

    // Agent signal (NO_REPLY / HEARTBEAT_OK) — nothing to say, silent drop
    // This is the primary indicator that a sub-agent was spawned.
    if (result.silent) {
      console.log(`🤫 Task #${taskId} silent/NO_REPLY (${((Date.now() - startTime) / 1000).toFixed(1)}s) — sub-agent likely spawned`);
      // ── Speak contextual dispatch ack ──
      if (contextualAckPromise) {
        try {
          const ackText = await contextualAckPromise;
          if (ackText) {
            console.log(`🎯 Contextual dispatch ack: "${ackText}"`);
            const ackAudio = await synthesizeSpeech(ackText);
            if (ackAudio) audioQueue.add(ackAudio);
            postActivity(`🎯 **Task #${taskId}** dispatch ack: "${ackText}"`);
          }
        } catch (e) {
          console.warn(`⚠️ Contextual ack speak failed: ${e.message}`);
        }
      }
      postActivity(`**Task #${taskId}** silent (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
      return;
    }

    // Empty response from gateway -- sub-agent spawned, callback expected via /speak
    if (result.empty) {
      console.log(`📭 Task #${taskId} empty response (${((Date.now() - startTime) / 1000).toFixed(1)}s) — sub-agent spawned, awaiting /speak callback`);
      // ── Speak contextual dispatch ack ──
      if (contextualAckPromise) {
        try {
          const ackText = await contextualAckPromise;
          if (ackText) {
            console.log(`🎯 Contextual dispatch ack: "${ackText}"`);
            const ackAudio = await synthesizeSpeech(ackText);
            if (ackAudio) audioQueue.add(ackAudio);
            postActivity(`🎯 **Task #${taskId}** dispatch ack: "${ackText}"`);
          }
        } catch (e) {
          console.warn(`⚠️ Contextual ack speak failed: ${e.message}`);
        }
      }
      postActivity(`**Task #${taskId}** returned empty response (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
      // Flush any pending text (e.g. "On it, sir.") from batchText into TTS pipeline
      if (batchText.trim().length > 0) {
        flushToPipeline(batchText);
        batchText = '';
      }
      await ttsPipeline.drain();
      return;
    }
    
    // Flush remaining text and wait for pipeline to finish
    console.log(`📊 Task #${taskId} final flush check: batchText="${batchText.substring(0, 40)}..." (${batchText.trim().length} chars, tldr=${tldrModeEnabled}, disconnected=${userDisconnected})`);
    if (batchText.trim().length > 0 && !tldrModeEnabled && !userDisconnected) {
      flushToPipeline(batchText);
      batchText = '';
    }
    // Wait for all queued TTS to finish generating and playing
    await ttsPipeline.drain();
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    // Strip any leaked signal fragments from the final text
    const fullText = (result.text || fullResponse || '')
      .replace(/\s*_?NO_?R?E?P?L?Y?\s*/gi, ' ')
      .replace(/\s*HEARTBEAT_?O?K?\s*/gi, ' ')
      .trim();
    console.log(`💬 Task #${taskId} done (${Date.now() - startTime}ms): "${fullText.substring(0, 80)}..."`);
    // Post Jarvis response to CC — split if over 2000 chars
    if (fullText) {
      const cleanCC = fullText
        .replace(/<p>/g, '\n\n')
        .replace(/\.{2,}/g, '.')           // collapse multiple periods
        .replace(/\.\s*\n\n\s*\./g, '.\n\n')  // period-newline-period → period-newline
        .replace(/\n\n\s*\.\s*/g, '\n\n')     // stray dot after newline
        .replace(/\n{3,}/g, '\n\n')        // collapse excess newlines
        .trim();
      for (let i = 0; i < cleanCC.length; i += 1990) {
        postToCC('🤖', cleanCC.substring(i, i + 1990));
      }
    }
    
    // ── Smart Output Length Enforcement (Phase 3) ──
    // Streaming already spoke every sentence via TTS pipeline above.
    // Only post full text to text channel if response was long (no re-speak).
    const outputResult = enforceOutputLength(fullText, tldrModeEnabled);
    if (outputResult.wasTruncated && !userDisconnected) {
      console.log(`📏 Response was long (${fullText.length} chars) — posting full text to channel (already spoken via streaming)`);
      // Post full response to text channel for reference
      await postToTextChannel(`📝 **Full Response (Task #${taskId}):**\n\n${outputResult.full}`);
      // NOTE: Do NOT re-speak here — streaming pipeline already delivered audio
    }
    
    // ── Full Transcript Mode: Post complete back-and-forth conversation as thread ──
    const transcriptModeEnabled = isTranscriptModeEnabled();
    if (transcriptModeEnabled && !userDisconnected) {
      console.log(`📝 Full transcript mode enabled — posting conversation as thread (task #${taskId})`);
      await postTranscriptThread(taskId, transcript, fullText, duration);
    }
    
    // Post completion to activity feed
    postActivity(`✅ **Task #${taskId}** complete (${duration}s)\n> ${truncate(fullText, 120)}`);
    
    // Update conversation history with full response
    const conv = conversations.get(userId);
    if (conv) {
      conv.history.push({ role: 'assistant', content: fullText });
      while (conv.history.length > 40) conv.history.shift();
    }

    // Detect if response invites follow-up (extends conversation window)
    const followUp = detectFollowUpLikely(fullText);
    if (followUp) console.log(`📋 Response invites follow-up — extending conversation window`);
    markBotResponse(userId, { followUpLikely: followUp });

    // ── Two-tier auto-sleep: sign-off phrase was embedded in a task request ──
    // The task is done, now transition to SLEEP as the user intended.
    // No farewell — the task response itself was the last thing spoken.
    const taskMeta = activeTasks.get(taskId);
    if (brainOptions.autoSleepAfterTask || taskMeta?.autoSleepAfterTask) {
      console.log(`Auto-sleep: task #${taskId} complete with sign-off — transitioning to SLEEP`);
      transition('SLEEP', 'auto-sleep-after-task');
      authenticatedSession = false;
      endConversationWindow(userId);
      postActivity(`😴 Auto-sleep after task #${taskId} (sign-off detected in request)`);
    }

    // Brief pending alerts on natural pause
    if (pendingAlertBriefingForUser && hasPendingAlerts() && activeTasks.size === 0) {
      const uid = pendingAlertBriefingForUser;
      pendingAlertBriefingForUser = null;
      setImmediate(() => briefPendingAlerts(uid));
    }
    
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(`❌ Task #${taskId} failed:`, err.message);
      postActivity(`❌ **Task #${taskId}** failed (${((Date.now() - startTime) / 1000).toFixed(1)}s): ${err.message}`);
      try {
        const audio = await synthesizeSpeech("I had trouble with that one. Try again?");
        if (audio) audioQueue.add(audio);
      } catch {}
    }
  } finally {
    // Guarantee task cleanup regardless of success/failure/abort
    activeTasks.delete(taskId);
  }
}

/**
 * Cancel all active background tasks
 */
function cancelAllTasks() {
  // Cancel pending debounced utterance
  if (_pendingUtterance.timer) {
    clearTimeout(_pendingUtterance.timer);
    _pendingUtterance.timer = null;
    _pendingUtterance.parts = [];
    _pendingUtterance.userId = null;
  }
  const count = activeTasks.size;
  for (const [taskId, task] of activeTasks) {
    task.controller.abort();
    console.log(`🛑 Cancelled task #${taskId}`);
  }
  activeTasks.clear();
  audioQueue.clear();
  isSpeaking = false;
  serverMuteOwner(false);
  console.log(`🛑 Cancelled ${count} active tasks, cleared all queues`);
  if (count > 0) postActivity(`🛑 **Cancelled ${count} task${count > 1 ? 's' : ''}** (user interrupt)`);
}

// Server mute owner during TTS playback -- prevents mic from picking up
// Jarvis's own audio (echo) and TV/ambient noise during speech output.
// Owner can still hear Jarvis; only their mic input is suppressed.
async function serverMuteOwner(mute) {
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;
    const member = guild.members.cache.get(ALLOWED_USERS[0]);
    if (!member?.voice?.channelId) return;
    // Only change if different from current state
    if (member.voice.serverMute === mute) return;
    await member.voice.setMute(mute, mute ? 'Jarvis speaking' : 'Jarvis done speaking');
    if (mute) console.log('🔇 Server-muted owner (Jarvis speaking)');
    else console.log('🔊 Server-unmuted owner (Jarvis done)');
  } catch (err) {
    // Non-fatal -- bot may lack permission
    console.warn(`Server mute ${mute ? 'on' : 'off'} failed: ${err.message}`);
  }
}

// ── Bluetooth Silence Padding ────────────────────────────────────────

function prependSilence(audioPath, durationMs) {
  if (durationMs <= 0 || !audioPath.endsWith('.wav')) return audioPath;
  try {
    const buf = readFileSync(audioPath);
    // Validate RIFF WAV header
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return audioPath;
    const channels = buf.readUInt16LE(22);
    const sampleRate = buf.readUInt32LE(24);
    const bitsPerSample = buf.readUInt16LE(34);
    // Find 'data' chunk — not always at offset 36
    let dataOffset = 12;
    while (dataOffset < buf.length - 8) {
      const chunkId = buf.toString('ascii', dataOffset, dataOffset + 4);
      const chunkSize = buf.readUInt32LE(dataOffset + 4);
      if (chunkId === 'data') break;
      dataOffset += 8 + chunkSize;
    }
    if (dataOffset >= buf.length - 8) return audioPath;
    const pcmStart = dataOffset + 8;
    const origDataSize = buf.readUInt32LE(dataOffset + 4);
    const silenceBytes = Math.floor(sampleRate * channels * (bitsPerSample / 8) * (durationMs / 1000));
    // Use low-amplitude noise instead of zeros -- pure silence triggers Opus DTX
    // (Discontinuous Transmission) which suppresses packets, so BT speaker never wakes.
    // Random values in [-10, +10] range for 16-bit PCM is ~0.03% amplitude -- inaudible.
    const silence = Buffer.alloc(silenceBytes);
    if (bitsPerSample === 16) {
      for (let i = 0; i < silenceBytes - 1; i += 2) {
        silence.writeInt16LE(Math.floor(Math.random() * 21) - 10, i);
      }
    } else {
      for (let i = 0; i < silenceBytes; i++) {
        silence[i] = Math.floor(Math.random() * 3); // near-zero for 8-bit
      }
    }
    const newDataSize = origDataSize + silenceBytes;
    // Build new WAV: copy header up to data chunk, patch sizes, silence, original PCM
    const header = Buffer.from(buf.subarray(0, pcmStart));
    header.writeUInt32LE(newDataSize + (pcmStart - 8), 4); // RIFF size
    header.writeUInt32LE(newDataSize, dataOffset + 4);      // data chunk size
    const padded = Buffer.concat([header, silence, buf.subarray(pcmStart, pcmStart + origDataSize)]);
    const paddedPath = audioPath.replace(/\.wav$/, '.bt.wav');
    writeFileSync(paddedPath, padded);
    console.log(`BT: padded ${durationMs}ms silence (${silenceBytes} bytes) to ${audioPath}`);
    return paddedPath;
  } catch (err) {
    console.warn(`BT silence pad failed: ${err.message}`);
    return audioPath;
  }
}

// ── Audio Playback ───────────────────────────────────────────────────

async function playAudio(audioPath) {
  isSpeaking = true;
  // Mute owner if not already handled by audioQueue
  const standalonePlay = !audioQueue.playing;
  if (standalonePlay) {
    serverMuteOwner(true);
    const btLeadMs = parseInt(process.env.BT_LEAD_IN_MS || '0');
    const padded = prependSilence(audioPath, btLeadMs);
    if (padded !== audioPath) audioPath = padded;
  }
  const playStart = Date.now();

  const { createReadStream: crs, statSync: fstatSync } = await import('fs');
  const fileStat = fstatSync(audioPath);
  // WAV at 22050 Hz, 16-bit mono = 44100 bytes/sec (~43 KB/s).
  // Previous formula used 5 KB/s, overestimating 8x — caused mute to hold 18+ seconds on 3s clips.
  const isWav = audioPath.endsWith('.wav');
  const bytesPerSec = isWav ? 44100 : 16000; // WAV 22050Hz mono 16-bit : MP3 ~128kbps
  const estimatedDurationMs = Math.max(1500, (fileStat.size / bytesPerSec) * 1000);

  const resource = createAudioResource(crs(audioPath));
  player.play(resource);

  return new Promise((resolve) => {
    let resolved = false;
    let onIdle, onError, timeoutId, checkInterval;

    const finish = (reason) => {
      if (resolved) return;
      resolved = true;
      // Remove ALL listeners we attached — prevents accumulation
      player.removeListener(AudioPlayerStatus.Idle, onIdle);
      player.removeListener('error', onError);
      if (timeoutId) clearTimeout(timeoutId);
      if (checkInterval) clearInterval(checkInterval);
      isSpeaking = false;
      if (standalonePlay) serverMuteOwner(false);
      resolve();
    };
    
    onIdle = () => {
      const elapsed = Date.now() - playStart;
      // Guard against spurious Idle before audio actually starts playing.
      // 500ms is enough — no real audio completes faster than that.
      if (elapsed < 500) {
        player.once(AudioPlayerStatus.Idle, onIdle);
        return;
      }
      bargeInEvents.clear();
      finish('idle');
    };
    
    player.once(AudioPlayerStatus.Idle, onIdle);
    onError = () => finish('error');
    player.once('error', onError);
    
    // Safety timeout: 2x estimated but cap at 15s — no single TTS sentence should take longer
    timeoutId = setTimeout(() => finish('timeout'), Math.min(estimatedDurationMs * 2, 15000));
    checkInterval = setInterval(() => {
      if (Date.now() - playStart >= estimatedDurationMs && player.state.status === AudioPlayerStatus.Idle) {
        finish('idle-polled');
      }
    }, 500);
  });
}

// ── WAV Helper ───────────────────────────────────────────────────────

function savePcmAsWav(pcmBuffer, outputPath) {
  return new Promise((resolve, reject) => {
    // Keep 48kHz -- Faster Whisper and torchaudio handle resampling internally.
    // Node-side downsampling degraded Whisper's no_speech_prob scores.
    const sampleRate = 48000, numChannels = 1, bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmBuffer.length;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(dataSize + 36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    const ws = createWriteStream(outputPath);
    ws.write(header);
    ws.end(pcmBuffer);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}

// ── Graceful Shutdown ────────────────────────────────────────────────

process.on('SIGINT', () => {
  cancelAllTasks();
  if (currentConnection) currentConnection.destroy();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cancelAllTasks();
  if (currentConnection) currentConnection.destroy();
  client.destroy();
  process.exit(0);
});

// ── Start ────────────────────────────────────────────────────────────

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN required. See .env.example');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
