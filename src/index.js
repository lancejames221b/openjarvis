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
import { generateResponse, generateResponseStreaming, generateTextResponse, generateAck, generateContextualAck, generateContextualInterim, trimForVoice, isGatewayCircuitOpen, dispatchViaWebhook, setCircuitBreakerNotifyCallback, getActivePersona, switchPersona, switchPersonaFull, setSwitchPersonaFullImpl } from './brain.js';
import { synthesizeSpeech, splitIntoSentences, isTTSAvailable, switchChatterboxVoice } from './tts.js';
import { OpusDecoder } from './opus-decoder.js';
import { checkWakeWord, markBotResponse, endConversationWindow, setOthersPresent, isOthersPresent, isContinuationPhrase, isFollowUpExpected, hasRecentContext, getEffectiveWindowMs, WAKE_WORD_ENABLED, WAKE_WORD_FUZZY, WAKE_WORD_PHRASES, VOICE_WAKE_WORD, VOICE_NAME, setPersonaWakeWords } from './wakeword.js';
import { queueAlert, hasPendingAlerts, getPendingAlerts, getAlertsByPriority, clearAlerts } from './alert-queue.js';
import { isHallucination, shouldSleep, shouldDismiss, isSideTalk, isTruncatedFragment, classifyIntent, hasTaskContent, setFollowUpExpectedCallback } from './intent-classifier.js';
import { startAlertWebhook, initAlertWebhook, setCurrentVoiceChannelId, setSpeakCallback, setMarkBotResponseCallback, setPostActivityCallback, setPostToTextCallback, hasPendingHandoffs, getPendingHandoffs, clearHandoffs, updateHealthState, endAllSessionPins, setDedupCallback, setDidTaskSpeakInlineCallback, setPersonaSwitchCallback, setPersonaCreateCallback } from './alert-webhook.js';
import { createTask, markStreaming, markStreamDone, markWorking, markCompleted as ledgerMarkCompleted, markFailed, isJustAck, reconcileOnStartup, getOrphanedTasks, getPendingFollowups, processOrphans, TaskState } from './task-ledger.js';
import { getTTSHealth } from './tts.js';
import { getSTTHealth, checkSttHealth } from './stt.js';
import { StreamingSTTSession } from './stt-streaming.js';
import { isTldrModeEnabled, generateTldr, isTranscriptModeEnabled } from './tldr-mode.js';
import { postTaskToThread } from './thread-router.js';
import { shouldBrief, markBriefingDelivered, generateBriefing } from './join-briefing.js';
import { initHud, hudTaskUpdate, hudQueueUpdate, hudRefresh } from './hud.js';
import { isMobileModeEnabled } from './mobile-mode.js';
import { getCurrentTtsProvider, getCurrentWakeWord } from './tts-toggle.js';
import { isVerifiedOwner, passesAuthGate, enrollmentState } from './auth.js';
import { resetIdleSleepTimer, isWakeUpCommand, WAKE_UP_PATTERNS, handleSleepCheck as fsmHandleSleepCheck, applyImplicitWakeOnUnmute, detectFollowUpLikely, wireFSMCallbacks, openAttentionWindow, closeAttentionWindow, isAttentionWindowActive } from './fsm.js';
import { dispatchCommand, isInterruptCommand } from './command-dispatch.js';
import { TtsPipeline } from './tts-pipeline.js';
import { getState, transition, STATES, canDeliverVoiceAlert, classifyAlertPriority, getStateInfo } from './bot-state.js';
// Task ledger stripped — voice bot is a thin pipe, no ack tracking needed
import { getPlayer, setPlayer, audioQueue as speechAudioQueue, playAudio as speechPlayAudio, speakAndWait, speakPhrase, speakText, enforceOutputLength, getIsSpeaking, setIsSpeaking, setVoiceConnection, preloadAckPhrases, getRandomCachedAck } from './speech-output.js';
import { activate as muteQueueActivate, deactivate as muteQueueDeactivate, isActive as isMuteQueueActive, addEntry as muteQueueAdd, hasEntries as muteQueueHasEntries, getSummary as muteQueueSummary, getDebriefText as muteQueueDebrief, getContextBlock as muteQueueContext, clear as muteQueueClear, getCount as muteQueueCount } from './mute-queue.js';
import logger from './logger.js';

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
    if (!_gatewayHealthy) logger.info('🟢 Gateway is healthy');
    _gatewayHealthy = true;
    return true;
  } catch (err) {
    _gatewayHealthy = false;
    logger.warn(`🔴 Gateway health check failed: ${err.message}`);
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
    if (removed > 0) logger.info(`🧹 Cleaned up ${removed} stale audio file(s) from /tmp`);
  } catch {}
}

async function startGatewayHealthCheck() {
  await cleanupStaleTmpAudio(); // Remove leftover TTS files from previous crashed runs
  logger.info('🏥 Running initial gateway health check...');
  const healthy = await checkGatewayHealth();
  if (healthy) {
    logger.info('✅ Gateway reachable on startup');
  } else {
    logger.warn('⚠️  Gateway unreachable on startup — will retry every 10s');
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
// Voice report channel: where task output lands as smart threads (e.g. #hud)
// Falls back to TEXT_CHANNEL_ID if not set.
const VOICE_REPORT_CHANNEL_ID = process.env.VOICE_REPORT_CHANNEL_ID || TEXT_CHANNEL_ID;
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
      logger.info(`🟢 Voice reconnect successful (was at attempt #${this.attempts})`);
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
  setInterval(async () => {
    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / 1024 / 1024);
    
    // Memory monitoring
    if (rssMb > MEMORY_CRITICAL_MB) {
      logger.error(`🔴 CRITICAL: Memory usage ${rssMb}MB > ${MEMORY_CRITICAL_MB}MB — attempting graceful restart`);
      postToTextChannel(`🔴 **Memory critical** (${rssMb}MB). Restarting gracefully.`);
      // Give time for the message to send, then exit (systemd will restart)
      setTimeout(() => process.exit(1), 2000);
    } else if (rssMb > MEMORY_WARNING_MB) {
      logger.warn(`🟡 Memory usage high: ${rssMb}MB > ${MEMORY_WARNING_MB}MB`);
    }
    
    // Event loop lag monitoring
    const now = Date.now();
    const lag = now - lastEventLoopCheck - HEALTH_CHECK_INTERVAL_MS;
    lastEventLoopCheck = now;
    
    if (lag > EVENT_LOOP_LAG_WARNING_MS) {
      eventLoopLagWarnings++;
      logger.warn(`🟡 Event loop lag: ${lag}ms (warning #${eventLoopLagWarnings})`);
      if (eventLoopLagWarnings >= 3) {
        logger.error(`🔴 Sustained event loop lag (${eventLoopLagWarnings} warnings)`);
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

    // Stuck server-mute watchdog — clear mute if no audio is playing and no active tasks
    // Catches cases where unmute failed due to disconnect, error, or crash during playback
    try {
      const guild = client.isReady() ? client.guilds.cache.get(GUILD_ID) : null;
      if (guild && ALLOWED_USERS[0]) {
        const member = guild.members.cache.get(ALLOWED_USERS[0]);
        if (member?.voice?.serverMute && activeTasks.size === 0 && !audioQueue?.playing && !isSpeaking) {
          logger.warn('🔧 Watchdog: detected stuck server mute with no active playback — clearing');
          await member.voice.setMute(false, 'Watchdog: clearing stuck server mute');
        }
      }
    } catch (err) {
      logger.warn(`Stuck-mute watchdog error: ${err.message}`);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
  
  logger.info('🏥 Process health monitor started (30s interval)');
}

// Conversation history per user (local backup — gateway session is primary)
const conversations = new Map(); // userId -> { history: [], lastActive: timestamp }
const CONVERSATION_TTL_MS = 60 * 60 * 1000; // Prune inactive conversations after 1 hour

function pruneConversations() {
  const cutoff = Date.now() - CONVERSATION_TTL_MS;
  for (const [userId, conv] of conversations.entries()) {
    if (conv.lastActive && conv.lastActive < cutoff) {
      conversations.delete(userId);
    }
  }
}
// Run pruning every 10 minutes
setInterval(pruneConversations, 10 * 60 * 1000);

// ── Orphan Task Detection (every 2 minutes) ──────────────────────────
// Catch tasks that were dispatched but never got a result (webhook didn't callback)
setInterval(() => {
  try {
    const orphans = processOrphans();
    if (orphans.length > 0) {
      for (const task of orphans) {
        logger.warn(`📋 Orphaned task #${task.taskId}: "${task.transcript}" — no result after ${((Date.now() - task.createdAt) / 1000).toFixed(0)}s`);
      }
      // Post to activity feed if postActivity is available
      const orphanList = orphans.map(t => `• #${t.taskId}: "${t.transcript.substring(0, 60)}"`).join('\n');
      logger.warn(`📋 ${orphans.length} orphaned tasks detected:\n${orphanList}`);
    }
  } catch (e) {
    logger.warn(`📋 Orphan check failed: ${e.message}`);
  }
}, 2 * 60 * 1000);

// ── Tunable Constants (env var overrides) ────────────────────────────
const REBUFF_COOLDOWN_MS = parseInt(process.env.SPEAKER_REBUFF_COOLDOWN_MS ?? '60000');
const TRANSCRIPT_DEDUP_MS = parseInt(process.env.TRANSCRIPT_DEDUP_MS ?? '15000');
const INFLIGHT_SIMILARITY_THRESHOLD = parseFloat(process.env.INFLIGHT_SIMILARITY_THRESHOLD ?? '0.75'); // Jaccard bigram overlap to absorb in-flight duplicate
const CONVERSATION_HISTORY_MAX = parseInt(process.env.CONVERSATION_HISTORY_MAX ?? '6');
// Chatterbox needs fewer, larger chunks — GPU inference per call is expensive (~2-5s each).
// Larger batches = fewer calls = lower total latency + better prosody (more context per chunk).
// Concurrency 2 (vs 3) avoids VRAM contention on single-GPU inference.
const _isChatterbox = (process.env.TTS_PROVIDER || 'piper').toLowerCase() === 'chatterbox';
const _isKokoro = (process.env.TTS_PROVIDER || 'piper').toLowerCase() === 'kokoro';
const _isFastTTS = _isChatterbox || _isKokoro; // both are fast enough for large batches
const TTS_PIPELINE_CONCURRENCY = parseInt(process.env.TTS_PIPELINE_CONCURRENCY ?? (_isChatterbox ? '2' : '3'));
const BATCH_FLUSH_MIN_CHARS = parseInt(process.env.TTS_BATCH_MIN_CHARS ?? '40');
// Chatterbox model.generate() has a ~250-char context limit — batches larger than that get
// internally split+concatenated in the Python service, and the concat can drop middle chunks.
// Keep Chatterbox batches at ≤200 so each flush is a single generate() call with no concat.
const BATCH_FLUSH_MAX_CHARS = parseInt(process.env.TTS_BATCH_MAX_CHARS ?? (_isChatterbox ? '200' : _isFastTTS ? '400' : '150'));

// Voice activity tracking
const userSpeaking = new Map();
const SILENCE_THRESHOLD_MS = process.env.VAD_TIMEOUT ? parseInt(process.env.VAD_TIMEOUT) : 1500;
const MIN_AUDIO_DURATION_MS = 300;

// Rolling partial STT state — keyed by userId
const partialTranscripts = new Map(); // userId -> { text, ts }
const partialInFlight = new Map();    // userId -> true (debounce: one partial STT per user at a time)

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

// ── /speak queue: hold incoming speaks while a task response is delivering ──
// Prevents cron results / sub-agent callbacks from interleaving mid-sentence.
let _ttsDeliveryActive = false;       // true while ttsPipeline is streaming to audioQueue
const _pendingSpeaks = [];            // { message, speakOpts } buffered during delivery

function setTTSDeliveryActive(val) { _ttsDeliveryActive = val; }
function isTTSDeliveryActive() { return _ttsDeliveryActive; }

async function flushPendingSpeaks() {
  while (_pendingSpeaks.length > 0) {
    const { message, speakOpts } = _pendingSpeaks.shift();
    logger.info(`🔔 Flushing queued /speak (${_pendingSpeaks.length} remaining): "${message.substring(0, 60)}"`);
    await _deliverSpeak(message, speakOpts);
  }
}

// The actual speak delivery — extracted so both immediate and deferred paths use it.
async function _deliverSpeak(message, speakOpts = {}) {
  if (!message || message.trim().length < 2) return;
  if (MUTE_QUEUE_ENABLED && isMuteQueueActive()) {
    const source = speakOpts.source || 'speak';
    const priority = speakOpts.priority || 3;
    muteQueueAdd(message.trim(), source, priority);
    logger.info(`🔇 /speak intercepted — queued for mute debrief (${source})`);
    return;
  }
  const wasAsleep = getState() === 'SLEEP';
  const sentences = splitIntoSentences(message);
  for (const sentence of sentences) {
    if (sentence.trim().length < 2) continue;
    const audio = await synthesizeSpeech(sentence.trim());
    if (audio) {
      audioQueue.add(audio);
    } else {
      postToTextChannel(`🔇 ${sentence}`);
    }
  }
  if (wasAsleep) openAttentionWindow();
}

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
    logger.info(`🔗 Merged ${parts.length} utterances: "${merged.substring(0, 80)}..."`);
  }

  // ── In-flight similarity check ───────────────────────────────────────
  // If an active task is already answering a semantically similar question,
  // absorb this utterance rather than dispatching a duplicate.
  // Handles "ask twice in different words" without requiring exact match.
  if (activeTasks.size > 0) {
    for (const [inflightId, inflightTask] of activeTasks) {
      if (inflightTask.userId !== userId) continue; // Only dedup per-user
      const sim = transcriptSimilarity(merged, inflightTask.transcript);
      if (sim >= INFLIGHT_SIMILARITY_THRESHOLD) {
        logger.info(`⏭️  In-flight task #${inflightId} covers this (similarity=${sim.toFixed(2)}) — absorbing duplicate: "${merged.substring(0, 60)}"`);
        postActivity(`⏭️ Absorbed duplicate (${(sim * 100).toFixed(0)}% similar to Task #${inflightId})\n> ${truncate(merged, 80)}`);
        return;
      }
    }
  }

  const taskId = ++taskIdCounter;
  const controller = new AbortController();
  activeTasks.set(taskId, { controller, transcript: merged, startTime: Date.now(), userId, autoSleepAfterTask });

  // ── Task Ledger: track lifecycle ──
  createTask(taskId, merged, userId);
  hudTaskUpdate(taskId, 'dispatched', { transcript: merged });

  const sleepTag = autoSleepAfterTask ? ' [auto-sleep]' : '';
  const speakerTag = speakerName ? ` [${speakerName}]` : '';
  logger.info({ taskId, userId, speakerName, autoSleepAfterTask, activeTasks: activeTasks.size, transcript: merged.substring(0, 60) }, `🚀 dispatching brain task`);

  postActivity(`🚀 **Task #${taskId}**${speakerTag}${sleepTag} started${activeTasks.size > 1 ? ` (${activeTasks.size} active)` : ''}\n> ${truncate(merged, 120)}`);

  const brainOptions = { taskId };
  if (speakerName) brainOptions.speaker = speakerName;
  if (sentiment) brainOptions.sentiment = sentiment;
  if (autoSleepAfterTask) brainOptions.autoSleepAfterTask = true;

  // Classify intent for model routing (haiku vs sonnet) + thread routing
  let _intentType = null;
  try {
    const classification = classifyIntent({ transcript: merged, speechDurationMs: 0, conversationDepth: conv ? conv.history.length : 0, isFollowUp: false, previousResponseType: null });
    if (classification?.type) {
      brainOptions.intentType = classification.type;
      _intentType = classification.type;
    }
  } catch (_) {}
  // Store intentType in activeTasks for thread routing at completion time
  if (_intentType) {
    const taskEntry = activeTasks.get(taskId);
    if (taskEntry) taskEntry.intentType = _intentType;
  }

  processBrainTask(taskId, userId, merged, conv ? [...conv.history] : [], controller.signal, brainOptions)
    .catch(err => logger.error(`Task #${taskId} error:`, err.message));
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

// isInterruptCommand imported from ./command-dispatch.js

// Voice-to-text handoff tracking
let userDisconnected = false;
let lastInteractionTime = Date.now(); // Init to now — prevents immediate idle disconnect on startup/restart

// Mute-gated output: when others present + owner unmuted, hold responses
let ownerMuted = false;
let lastUserMessage = '';
const ACTIVE_CONVERSATION_WINDOW_MS = parseInt(process.env.CONVERSATION_WINDOW_MS || '60000'); // default 60s, override via .env

// detectFollowUpLikely imported from ./fsm.js

// resetIdleSleepTimer imported from ./fsm.js — wired with callbacks below after declarations

// ── Session-Based Speaker Authentication ─────────────────────────────
// Like Siri/Google: verify speaker on wake word, trust the session after.
// Once "Hey Jarvis" passes speaker verification, all subsequent utterances
// are trusted until sleep/idle/disconnect. No per-utterance verification.
let authenticatedSession = false;
const SESSION_PASSPHRASE = process.env.SPEAKER_PASSPHRASE || '';  // secret phrase to force-authenticate

// Wire FSM callbacks — gives fsm.js access to local mutable state without circular deps
wireFSMCallbacks({
  getEnrollmentActive: () => enrollmentState.active,
  getAuthenticatedSession: () => authenticatedSession,
  setAuthenticatedSession: (val) => { authenticatedSession = val; },
  getPendingUtterance: () => _pendingUtterance,
  clearPendingUtterance: () => {
    if (_pendingUtterance.timer) {
      clearTimeout(_pendingUtterance.timer);
      _pendingUtterance.timer = null;
      _pendingUtterance.parts = [];
      _pendingUtterance.userId = null;
    }
  },
});

// WAKE_UP_PATTERNS, applyImplicitWakeOnUnmute, handleSleepCheck, isWakeUpCommand imported from ./fsm.js
// enrollmentState imported from ./auth.js

// ── Task Activity Feed ───────────────────────────────────────────────
// Posts task lifecycle events to the text channel so user can track
// what's happening when in voice (can't see the screen)

async function postActivity(message) {
  if (!ACTIVITY_FEED_ENABLED || !ACTIVITY_CHANNEL_ID || !client.isReady()) return;
  try {
    const channel = client.channels.cache.get(ACTIVITY_CHANNEL_ID);
    if (channel) return await channel.send(message);
  } catch (err) {
    logger.error('Activity post failed:', err.message);
  }
  return null;
}

// Pin/unpin removed — gateway handles all Discord interaction (has full perms)

function truncate(str, len = 80) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '…' : str;
}

// ── Audio Queue (for streaming TTS) ──────────────────────────────────

const AUDIO_QUEUE_MAX_SIZE = parseInt(process.env.AUDIO_QUEUE_MAX_SIZE || '50');

class AudioQueue {
  constructor() {
    this.queue = [];
    this.playing = false;
    this._holdTimer = null; // speaking hold — prevents jump between slow Chatterbox sentences
  }
  
  add(audioSource, metadata = {}) {
    // Cancel any pending "speaking done" hold — more audio arrived
    if (this._holdTimer) {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
    if (this.queue.length >= AUDIO_QUEUE_MAX_SIZE) {
      const dropped = this.queue.shift();
      logger.warn(`[AudioQueue] Max size (${AUDIO_QUEUE_MAX_SIZE}) reached — dropping oldest item: ${dropped.audioSource}`);
      try { unlinkSync(dropped.audioSource); } catch {}
    }
    this.queue.push({ audioSource, metadata });
    if (!this.playing) this.playNext();
  }
  
  clear() {
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
    this.queue = [];
    if (this.playing) {
      player.stop(true);
      this.playing = false;
    }
    serverMuteOwner(false);
  }
  
  async playNext() {
    if (this.queue.length === 0) {
      // Hold state briefly — Chatterbox may still be generating the next sentence.
      // If more audio arrives within the hold window, we resume without a jump/re-mute.
      const holdMs = parseInt(process.env.SPEAKING_HOLD_MS || '800');
      if (holdMs > 0 && this.playing) {
        this._holdTimer = setTimeout(() => {
          this._holdTimer = null;
          if (this.queue.length === 0) {
            this.playing = false;
            isSpeaking = false;
            serverMuteOwner(false);
          } else {
            this.playNext(); // audio arrived during hold — continue seamlessly
          }
        }, holdMs);
        return; // don't clear isSpeaking yet
      }
      this.playing = false;
      isSpeaking = false;
      serverMuteOwner(false);
      return;
    }
    // Cancel hold timer if we have audio to play
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }

    // Mute-gated: hold response when others present + owner unmuted
    // Skip mute-gating when wake word is active — wake word handles filtering
    if (isOthersPresent() && !ownerMuted && !WAKE_WORD_ENABLED) {
      logger.info(`🤫 Holding response — owner unmuted with others present (${this.queue.length} queued)`);
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
    try { await playAudioEnhanced(audioSource); } catch (err) { logger.error('Queue playback error:', err.message); }
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
  if (audio) { await playAudioEnhanced(audio); try { unlinkSync(audio); } catch {} }
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
  while (conv.history.length > CONVERSATION_HISTORY_MAX) conv.history.shift();
  
  clearAlerts();
}

async function briefPendingHandoffs(userId) {
  const handoffs = getPendingHandoffs();
  if (handoffs.length === 0) return;

  // Auto-focus on the most recent handoff's channel (belt-and-suspenders with /handoff endpoint)
  const latestWithChannel = [...handoffs].reverse().find(h => h.channelId);
  if (latestWithChannel) {
    const { setFocusById } = await import('./focus-state.js');
    setFocusById(latestWithChannel.channelId, latestWithChannel.channel || null);
    logger.info(`🎯 Voice auto-focused on #${latestWithChannel.channel || latestWithChannel.channelId} from handoff briefing`);
  }

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
  if (audio) { await playAudioEnhanced(audio); try { unlinkSync(audio); } catch {} }
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
  while (conv.history.length > CONVERSATION_HISTORY_MAX) conv.history.shift();
  
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
  
  const prompt = `You are ${VOICE_NAME}, a British AI butler. Generate ONE short greeting (under 15 words) for ${timeOfDay}. Dry wit welcome. No quotes, just the text.`;
  
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GATEWAY_TOKEN}`, 'x-openclaw-scopes': 'operator.write' },
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
  logger.info(`🤖 Jarvis Voice Bot online as ${client.user.tag}`);
  logger.info(`📡 Guild: ${GUILD_ID} | Voice: ${VOICE_CHANNEL_ID} | Multi-user: ${MULTI_USER_ENABLED} | Callback: ${WEBHOOK_CALLBACK_MODE}`);

  // Seed wake words + Chatterbox voice from the startup persona (VOICE_PERSONA env var, default: jarvis)
  const startupPersona = getActivePersona();
  setPersonaWakeWords(startupPersona.wakeWords || []);
  switchChatterboxVoice(startupPersona.voice).catch(e => logger.warn(`[startup] chatterbox voice seed error: ${e.message}`));
  
  initAlertWebhook(client, GUILD_ID, ALLOWED_USERS, scheduleBriefingOnPause);

  // ── Voice Session HUD ──
  initHud(client);
  hudRefresh();

  // ── Task Ledger: reconcile orphans from previous run ──
  try {
    const { orphans, pending } = reconcileOnStartup();
    if (orphans.length > 0 || pending.length > 0) {
      const orphanSummary = orphans.map(t => `• Task #${t.taskId}: "${t.transcript}"`).join('\n');
      const pendingSummary = pending.map(t => `• Task #${t.taskId}: "${t.transcript}" (${t.state})`).join('\n');
      const msg = [
        orphans.length > 0 ? `⚠️ **${orphans.length} orphaned tasks** from previous run:\n${orphanSummary}` : '',
        pending.length > 0 ? `⏳ **${pending.length} tasks** still awaiting follow-up:\n${pendingSummary}` : '',
      ].filter(Boolean).join('\n\n');
      logger.info(`📋 Ledger reconciliation:\n${msg}`);
    }
  } catch (e) {
    logger.warn(`📋 Ledger reconciliation failed: ${e.message}`);
  }
  
  // Wire up cross-path content deduplication (shared between messageCreate + /speak)
  setDedupCallback(_isDuplicateContent);

  // Wire up task-spoke-inline check so /speak can suppress redundant task-progress voice
  setDidTaskSpeakInlineCallback(didTaskSpeakInline);

  // Wire follow-up detection into the TV noise filter (intent-classifier.js)
  // When a follow-up is expected, short phrases like "yes please" bypass the TV filter
  setFollowUpExpectedCallback(() => isFollowUpExpected());
  
  // Wire up immediate TTS delivery for /speak endpoint
  // If a task response is actively streaming to audioQueue, buffer the speak
  // and flush it after the task finishes — no more mid-sentence interruptions.
  setSpeakCallback(async (message, speakOpts = {}) => {
    try {
      if (!message || message.trim().length < 2) return;
      if (isTTSDeliveryActive()) {
        logger.info(`🔔 /speak buffered (task delivery active): "${message.substring(0, 60)}"`);
        _pendingSpeaks.push({ message, speakOpts });
        return;
      }
      await _deliverSpeak(message, speakOpts);
    } catch (err) {
      logger.error('Speak callback TTS failed:', err.message);
    }
  });
  
  // Wire up conversation window refresh for /speak callback responses
  setMarkBotResponseCallback((userId, opts) => markBotResponse(userId, opts));

  // Wire up activity feed posting for /speak endpoint
  setPostActivityCallback((message) => postActivity(message));

  // Wire up circuit breaker Discord notifications
  setCircuitBreakerNotifyCallback((type) => {
    const cbChannelId = process.env.DISCORD_CIRCUIT_BREAKER_CHANNEL;
    if (!cbChannelId || !client.isReady()) return;
    const msg = type === 'open'
      ? '⚠️ Gateway circuit breaker OPEN — gateway unreachable'
      : '✅ Gateway circuit breaker CLOSED — gateway recovered';
    client.channels.fetch(cbChannelId)
      .then(ch => ch.send(msg))
      .catch(() => {});
  });

  // Wire up text channel posting for /speak endpoint (belt and suspenders)
  setPostToTextCallback((message) => postToTextChannel(message));

  // Wire up runtime persona switch for POST /persona endpoint
  // Wire the atomic switchPersonaFull implementation
  setSwitchPersonaFullImpl(async (name) => {
    const previous = getActivePersona();
    const p = switchPersona(name);
    setPersonaWakeWords(p.wakeWords || []);
    try {
      await Promise.race([
        switchChatterboxVoice(p.voice, { throwOnFail: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('voice switch timeout')), 10000)),
      ]);
      logger.info(`[persona] switchPersonaFull: ${previous.name} → ${p.name} (voice: ${p.voice}) ✅`);
    } catch (e) {
      // Revert personality and wake words on voice switch failure
      logger.warn(`[persona] voice switch failed (${e.message}) — reverting to ${previous.name}`);
      switchPersona(previous.name.toLowerCase());
      setPersonaWakeWords(previous.wakeWords || []);
      const err = new Error(`Voice switch failed: ${e.message}`);
      err.revertedTo = previous.name;
      throw err;
    }
    return { persona: p.name, voice: p.voice, wakeWords: p.wakeWords, previous: previous.name };
  });

  setPersonaSwitchCallback(async (name) => {
    const result = await switchPersonaFull(name);
    return { name: result.persona, voice: result.voice, wakeWords: result.wakeWords };
  });

  // Wire up runtime persona creation for POST /persona/create endpoint
  setPersonaCreateCallback(({ name, content, voice, ttsVoiceEdge, wakeWords, overwrite }) => {
    const filePath = join(__dirname, '..', 'personalities', `${name}.md`);
    if (!overwrite && existsSync(filePath)) {
      const err = new Error(`Persona '${name}' already exists — set overwrite: true to replace`);
      err.code = 'EEXIST';
      throw err;
    }
    // Build frontmatter
    const wakeWordsStr = `[${wakeWords.join(', ')}]`;
    const fm = [
      '---',
      `name: ${name.charAt(0).toUpperCase() + name.slice(1)}`,
      `voice: ${voice}`,
      ttsVoiceEdge ? `tts_voice_edge: ${ttsVoiceEdge}` : null,
      `wake_words: ${wakeWordsStr}`,
      '---',
    ].filter(Boolean).join('\n');
    writeFileSync(filePath, `${fm}\n${content}\n`, 'utf8');
    logger.info(`[persona] Created: ${filePath}`);
    // Return the parsed persona info WITHOUT switching active persona
    const displayName = name.charAt(0).toUpperCase() + name.slice(1);
    return { name: displayName, voice, ttsVoiceEdge: ttsVoiceEdge || null, wakeWords, content };
  });

  startAlertWebhook();
  startHealthMonitor();

  // Pre-cache ack phrases for instant zero-latency playback
  preloadAckPhrases(synthesizeSpeech).catch(err => logger.warn('Ack preload failed:', err.message));

  // Task ledger removed — voice bot is a thin pipe
  
  try {
    // Check if owner is already in a voice channel — follow them
    const guild = client.guilds.cache.get(GUILD_ID);
    let ownerChannel = null;
    try {
      const ownerMember = await guild.members.fetch(ALLOWED_USERS[0]);
      ownerChannel = ownerMember?.voice?.channelId;
      ownerMuted = !!ownerMember?.voice?.selfMute;
      if (ownerChannel) logger.info(`👀 Owner is in voice channel ${ownerChannel} (${ownerMuted ? 'muted' : 'unmuted'})`);
    } catch (e) {
      logger.info(`Could not fetch owner voice state: ${e.message}`);
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
          logger.info(`✅ Joined voice channel ${targetChannel}${ownerChannel ? ' (owner is here)' : ' (default)'}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
          joined = true;
          // Auto-enter record mode on startup if owner is in the record channel
          if (RECORD_CHANNEL_ID && targetChannel === RECORD_CHANNEL_ID) {
            startRecordMode(ALLOWED_USERS[0]);
          }
        } catch (err) {
          if (attempt < maxAttempts) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            logger.error(`⚠️ Join attempt ${attempt} failed: ${err.message} — retrying in ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            logger.error('⚠️ Failed to join voice channel after 3 attempts:', err.message);
            logger.info('🔄 Will auto-join when owner enters a voice channel');
          }
        }
      }
    } else {
      logger.info('🔄 No default channel and owner not in voice — waiting for owner to join');
    }
  } catch (err) {
    logger.error('⚠️ Failed to join voice channel:', err.message);
    logger.info('🔄 Will auto-join when owner enters a voice channel');
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
      logger.info(`▶️  Others left channel — playing ${audioQueue.queue.length} held response(s)`);
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
    logger.info(`🎙️ Owner ${ownerMuted ? 'MUTED' : 'UNMUTED'}`);

    if (ownerMuted) {
      // ── Owner just MUTED ──────────────────────────────────────────
      if (MUTE_QUEUE_ENABLED) {
        // Activate mute queue — subsequent TTS will be captured, not spoken
        muteQueueActivate();
        // Clear audio already queued/playing (don't dump it while they're muted)
        audioQueue.clear();
        logger.info(`🔇 Mute queue active — TTS will be queued until unmute`);
      } else {
        // Legacy behaviour: flush held responses on mute (mute-gated output)
        if (audioQueue && audioQueue.queue.length > 0 && !audioQueue.playing) {
          logger.info(`▶️  Owner muted — playing ${audioQueue.queue.length} held response(s)`);
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
            logger.info(`🔊 Mute queue debrief: ${count} entries — offering summary`);

            // Build conversation context so AI can answer follow-ups
            const ctxBlock = muteQueueContext();
            if (ctxBlock) {
              const userId = ALLOWED_USERS[0];
              if (!conversations.has(userId)) conversations.set(userId, { history: [], lastActive: Date.now() });
              const conv = conversations.get(userId);
              conv.history.push({ role: 'assistant', content: ctxBlock });
              while (conv.history.length > CONVERSATION_HISTORY_MAX) conv.history.shift();
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
              logger.info(`🎙️  Wake bypass active — unmute response does not require wake word`);
            }

            // Speak the summary (fires immediately, won't re-queue)
            try {
              const audio = await synthesizeSpeech(summary);
              if (audio) audioQueue.add(audio);
            } catch (err) {
              logger.error('Mute queue debrief TTS failed:', err.message);
            }

            // Clear queue after debrief offered (details available via conversation history)
            muteQueueClear();
          }
        } else {
          // Nothing queued — deactivate and optionally open implicit wake window
          muteQueueDeactivate();
          if (UNMUTE_IMPLICIT_WAKE) {
            applyImplicitWakeOnUnmute(newState.id, (val) => { authenticatedSession = val; });
          }
        }
      } else if (UNMUTE_IMPLICIT_WAKE) {
        // MUTE_QUEUE_ENABLED=false but unmute implicit wake still applies
        applyImplicitWakeOnUnmute(newState.id, (val) => { authenticatedSession = val; });
      }
    }
  }
  
  // User joined a voice channel (any channel in the guild)
  const joinedChannel = newState.channelId;
  const leftChannel = oldState.channelId;
  
  // User switched or joined a voice channel — follow them
  if (joinedChannel && joinedChannel !== currentVoiceChannelId) {
    logger.info(`🔀 Owner moved to channel ${joinedChannel} — following`);
    
    // Retry logic with exponential backoff
    let attempt = 0;
    const maxAttempts = 3;
    let joined = false;
    
    while (!joined && attempt < maxAttempts) {
      attempt++;
      try {
        await joinChannel(joinedChannel, { greeting: false });
        logger.info(`✅ Followed owner to ${joinedChannel}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        joined = true;
        // Auto-enter record mode for dedicated recording channel
        if (RECORD_CHANNEL_ID && joinedChannel === RECORD_CHANNEL_ID) {
          startRecordMode(newState.id);
        }
      } catch (err) {
        if (attempt < maxAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          logger.error(`⚠️ Follow attempt ${attempt} failed: ${err.message} — retrying in ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          logger.error(`❌ Failed to follow owner after ${maxAttempts} attempts: ${err.message}`);
        }
      }
    }
  }
  
  if (joinedChannel && (!leftChannel || leftChannel !== joinedChannel)) {
    userDisconnected = false; // Reset disconnect flag on join
    logger.info(`👋 User joined voice channel ${joinedChannel}`);
    // Auto-clear any stale server mute — can get stuck when user disconnects while muted.
    // Guild-level server mute persists across voice sessions, so clear it on join.
    if (newState.serverMute) {
      logger.info('🔊 Clearing stale server mute on owner join...');
      serverMuteOwner(false);
    }
    // Apply implicit wake on join when owner is not muted — same as unmute flow.
    // Allows Lance to start talking immediately after joining without wake word,
    // as long as UNMUTE_IMPLICIT_WAKE is enabled. Voiceprint still required.
    if (UNMUTE_IMPLICIT_WAKE && !newState.selfMute) {
      applyImplicitWakeOnUnmute(newState.id, (val) => { authenticatedSession = val; });
      logger.info(`🎙️ Implicit wake applied on join (owner joined unmuted)`);
    }
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
        const persona = getActivePersona();
        const audio = await synthesizeSpeech(`${persona.name} online. Using ${modelLabel}.`);
        if (audio) { await playAudioEnhanced(audio); try { unlinkSync(audio); } catch {} }
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
            logger.info(`📋 Active context detected from ${context.surface} — briefing user`);
            const briefMsg = `${context.topic ? context.topic + '. ' : ''}${context.summary.substring(0, 300)}`;
            const briefAudio = await synthesizeSpeech(briefMsg);
            if (briefAudio) {
              await playAudioEnhanced(briefAudio);
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
        logger.error(`⚠️ Failed to check active context: ${err.message}`);
      }
      
      // Brief pending alerts after greeting
      if (hasPendingAlerts()) {
        await briefPendingAlerts(newState.id);
      }
      // Brief pending handoffs
      if (hasPendingHandoffs()) {
        await briefPendingHandoffs(newState.id);
      }

      // ── Proactive Join Briefing (Phase 3) ────────────────────────
      // Calendar + active tasks + focus — spoken summary on voice join
      if (shouldBrief()) {
        try {
          const briefingText = await generateBriefing();
          if (briefingText) {
            logger.info(`[briefing] Delivering join briefing: ${briefingText.substring(0, 80)}...`);
            markBriefingDelivered();
            const briefAudio = await synthesizeSpeech(briefingText);
            if (briefAudio) {
              audioQueue.add(briefAudio);
            }
          } else {
            logger.info(`[briefing] Nothing to report — skipping`);
            markBriefingDelivered(); // still mark to avoid rapid retries
          }
        } catch (err) {
          logger.error(`[briefing] Failed: ${err.message}`);
        }
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
          logger.info(`🔊 Mute queue debrief on reconnect: ${count} entries`);
          // Inject context so AI can answer follow-ups
          const ctxBlock = muteQueueContext();
          if (ctxBlock) {
            const uid = newState.id;
            if (!conversations.has(uid)) conversations.set(uid, { history: [], lastActive: Date.now() });
            const conv = conversations.get(uid);
            conv.history.push({ role: 'assistant', content: ctxBlock });
            while (conv.history.length > CONVERSATION_HISTORY_MAX) conv.history.shift();
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
            logger.error('Mute queue reconnect debrief TTS failed:', err.message);
          }
          muteQueueClear();
        }
      }
    }, 500);
  }
  
  // User left voice entirely (not just switching channels)
  if (leftChannel && !joinedChannel) {
    logger.info(`👋 User left voice entirely`);
    userDisconnected = true;
    // If owner left while self-muted, deactivate the mute queue
    // so it's in the right state when they reconnect on another device
    if (MUTE_QUEUE_ENABLED && isMuteQueueActive()) {
      muteQueueDeactivate();
      logger.info(`🔇 Mute queue deactivated on disconnect (${muteQueueCount()} entries held for reconnect)`);
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
const DEDUP_CONTENT_TTL_MS = 90_000; // 90s window for content dedup (extended from 30s)

function _contentHash(text) {
  // Normalize before hashing: lowercase, strip punctuation, collapse whitespace
  // This catches "Signal is open, sir." vs "Signal is open sir" as the same hash
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  return `${normalized.substring(0, 100)}__${normalized.split(/\s+/).length}`;
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

// ── Transcript Bigram Similarity ──────────────────────────────────────
// Used to detect semantically similar utterances even when phrased differently.
// e.g. "what's the weather" vs "how's the weather looking" → high overlap
// e.g. "what's the weather" vs "set a timer for 5 minutes" → low overlap
function _normTokens(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
}

function _bigrams(tokens) {
  const bg = new Set();
  for (let i = 0; i < tokens.length - 1; i++) bg.add(`${tokens[i]}_${tokens[i+1]}`);
  // Also include unigrams for short phrases (< 4 words)
  if (tokens.length < 4) tokens.forEach(t => bg.add(t));
  return bg;
}

function _jaccardSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) { if (b.has(item)) intersection++; }
  return intersection / (a.size + b.size - intersection);
}

export function transcriptSimilarity(t1, t2) {
  const bg1 = _bigrams(_normTokens(t1));
  const bg2 = _bigrams(_normTokens(t2));
  return _jaccardSimilarity(bg1, bg2);
}

// ── Task Spoke Inline Tracker ─────────────────────────────────────────
// Tracks tasks that have already emitted TTS via the streaming pipeline.
// Used by /speak handler to suppress redundant task-progress voice output
// when the task already spoke its own result inline.
const _taskSpokeInline = new Map(); // taskId -> timestamp
const TASK_SPOKE_TTL_MS = 60_000; // 60s window

export function markTaskSpokeInline(taskId) {
  _taskSpokeInline.set(taskId, Date.now());
}

export function didTaskSpeakInline(taskId) {
  const now = Date.now();
  // Only suppress if we have a specific taskId match — never suppress based on
  // "some other task spoke recently". The old 10s ANY-task fallback was eating
  // legitimate sub-agent /speak callbacks. Sub-agents now include taskId in their
  // curl calls; if they don't, we let the speech through (better to double-speak
  // than to silently swallow a result).
  if (taskId) {
    const ts = _taskSpokeInline.get(taskId);
    if (ts && (now - ts) < TASK_SPOKE_TTL_MS) return true;
  }
  return false;
}

// Periodic cleanup of message ID cache
setInterval(() => {
  if (_processedMsgIds.size > DEDUP_MSG_ID_MAX) {
    _processedMsgIds.clear();
    logger.info('🧹 Cleared message ID dedup cache');
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
    logger.info(`⏭️  Dedup: skipping duplicate message ID ${message.id}`);
    return;
  }
  _processedMsgIds.add(message.id);
  
  // ── Deduplication: content hash (catches cross-path dupes from /speak) ──
  if (_isDuplicateContent(text)) {
    logger.info(`⏭️  Dedup: skipping duplicate content (${text.substring(0, 40)}...)`);
    return;
  }
  
  logger.info(`📩 Callback received (${text.length} chars, id: ${message.id}): "${text.substring(0, 80)}..."`);
  
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
        logger.error('Callback TTS failed:', err.message);
      }
    }
    
    const duration = ((Date.now() - lastInteractionTime) / 1000).toFixed(1);
    logger.info(`💬 Callback spoken (${duration}s since request)`);
  } else {
    // User not in voice — ping them in the text channel so they see it
    logger.info(`📝 Callback received but user not in voice — pinging in text channel`);
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

  logger.info(`@mention from ${message.author.tag} in #${message.channel.name}: "${content.substring(0, 80)}"`);

  // Show typing indicator while we process
  try { await message.channel.sendTyping(); } catch (_) {}

  try {
    const result = await generateTextResponse(content, {
      channelId: message.channelId,
      sessionUser: `agent:main:discord:channel:${message.channelId}`,
    });

    if (!result.text || result.text.length < 2) {
      // Agent probably spawned a sub-agent -- it'll post back on its own
      logger.info(`@mention: empty response (sub-agent likely spawned)`);
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

    logger.info(`@mention: replied (${response.length} chars)`);
  } catch (err) {
    logger.error(`@mention handler error:`, err.message);
    try {
      await message.reply("Having trouble processing that right now, sir.");
    } catch (_) {}
  }
});

// ── Voice-to-Text Handoff ────────────────────────────────────────────

async function sendDM(userId, message) {
  try {
    const user = await client.users.fetch(userId);
    logger.info(`📤 Sending DM to user ${userId}...`);
    await user.send(message);
    logger.info(`✅ DM sent successfully`);
    return true;
  } catch (err) {
    logger.error(`❌ Failed to send DM: ${err.message}`);
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
    logger.warn(`CC post failed: ${err.message}`);
  }
}

async function postToTextChannel(message) {
  if (!TEXT_CHANNEL_ID) {
    logger.warn('⚠️  No text channel configured, skipping channel post');
    return false;
  }
  
  try {
    const channel = client.channels.cache.get(TEXT_CHANNEL_ID);
    if (!channel) {
      logger.error(`❌ Channel ${TEXT_CHANNEL_ID} not found in cache`);
      return false;
    }
    
    logger.info(`📤 Posting to ${channel.name} (${TEXT_CHANNEL_ID})...`);
    await channel.send(message);
    logger.info(`✅ Posted to ${channel.name} successfully`);
    return true;
  } catch (err) {
    logger.error(`❌ Failed to post to channel: ${err.message}`);
    return false;
  }
}

/**
 * Post voice conversation as a thread (user question → thread with Jarvis response + task tracking)
 */
async function postTranscriptThread(taskId, userTranscript, jarvisResponse, duration) {
  // Use VOICE_REPORT_CHANNEL_ID (#hud) instead of TEXT_CHANNEL_ID (#jarvis-voice).
  // Posting to #jarvis-voice (which is also VOICE_CALLBACK_CHANNEL_ID) created a feedback
  // loop: the transcript message landed in the callback channel and could trigger a second
  // /speak path, causing jobs to be spoken twice. #hud is the correct target — it's already
  // used by postTaskToThread (thread-router) for all other voice task output.
  const targetChannelId = VOICE_REPORT_CHANNEL_ID || TEXT_CHANNEL_ID;
  if (!targetChannelId) {
    logger.warn('⚠️  No text channel configured, skipping transcript thread');
    return false;
  }
  
  try {
    const channel = client.channels.cache.get(targetChannelId);
    if (!channel) {
      logger.error(`❌ Channel ${targetChannelId} not found in cache`);
      return false;
    }
    
    // Post the initial message with task ID and user's question
    logger.info(`📤 Posting voice transcript thread (task #${taskId}) to ${channel.name} (#hud)...`);
    const initialMsg = await channel.send(`🎙️ **Task #${taskId}** | You: ${userTranscript}`);
    
    // Create a thread on that message with task ID in the name
    const thread = await initialMsg.startThread({
      name: `Task #${taskId}: ${userTranscript.substring(0, 40)}${userTranscript.length > 40 ? '...' : ''}`,
      autoArchiveDuration: 1440, // 24 hours
    });
    
    // Post Jarvis's full response with timing in the thread
    await thread.send(`**Jarvis Response:**\n${jarvisResponse}\n\n_Task completed in ${duration}s_`);
    
    logger.info(`✅ Posted voice transcript thread (task #${taskId}) to ${channel.name}`);
    return true;
  } catch (err) {
    logger.error(`❌ Failed to post transcript thread: ${err.message}`);
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
      logger.info(`REC: notification posted to #meeting-transcripts`);
    } else {
      logger.info(`REC: channel ${chId} not found for notification`);
    }
  } catch (err) {
    logger.error(`REC: notification failed: ${err.message}`);
  }

  logger.info(`REC: started -> ${recordMode.filePath}`);
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
    logger.error(`REC: failed to post stop notification: ${err.message}`);
  }

  logger.info(`REC: stopped (${durationStr}, ${entryCount} entries) -> ${filePath}`);

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
  logger.info(`REC: [${mm}:${ss}] "${text.substring(0, 50)}"`);
}

async function handleVoiceDisconnect(userId) {
  const timeSinceLastInteraction = Date.now() - lastInteractionTime;
  const wasRecentlyActive = timeSinceLastInteraction < ACTIVE_CONVERSATION_WINDOW_MS;
  
  // Handle in-flight tasks — they'll detect userDisconnected and post to text
  if (activeTasks.size > 0) {
    logger.info(`📤 ${activeTasks.size} tasks in flight — will handoff to text channel when ready`);
    return;
  }
  
  // Handle recent conversation handoff
  if (wasRecentlyActive && lastUserMessage) {
    logger.info(`📤 Active conversation detected — posting handoff note to text channel`);
    const handoffMsg = `🎙️ Voice session ended. Last topic: "${lastUserMessage}". Continuing in text.`;
    await postToTextChannel(handoffMsg);
    return;
  }
  
  // Idle disconnect — silent exit, ensure owner is not left server-muted
  serverMuteOwner(false);
  logger.info(`🔇 Idle disconnect (${Math.round(timeSinceLastInteraction / 1000)}s since last interaction) — no handoff`);
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
  logger.info(`🔗 Joining voice channel: ${channel.name} (${voiceChannelId})`);
  
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
    logger.error('🔴 Voice connection error:', err.message);
  });
  
  // Log state transitions for debugging
  connection.on('stateChange', (oldState, newState) => {
    logger.info(`🔊 Voice state: ${oldState.status} → ${newState.status}`);
  });

  // Wait for Ready state with timeout — destroy and retry if stuck
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    logger.error(`⚠️ Connection timeout (stuck in ${connection.state.status}) — destroying and retrying`);
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
      logger.info(`⚠️  Disconnected (attempt #${reconnectState.attempts}), rejoining in ${delay / 1000}s...`);
      
      // After 5 failed reconnects, notify text channel and stand by
      if (reconnectState.attempts >= 5 && !reconnectState.textModeNotified) {
        reconnectState.textModeNotified = true;
        logger.error('🔴 Voice connection unstable after 5 reconnect attempts');
        postToTextChannel('⚠️ **Voice connection unstable.** Standing by in text mode. Will keep retrying.');
      }
      
      setTimeout(async () => {
        try {
          await joinChannel(voiceChannelId);
          reconnectState.reset();
        } catch (err) {
          logger.error(`❌ Reconnect attempt #${reconnectState.attempts} failed: ${err.message}`);
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
            logger.info(`⚡ Barge-in — stopping playback`);
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

      // SimulStreaming STT — stream chunks to WhisperLiveKit WS as they arrive
      const streamingEnabled = process.env.STT_STREAMING_ENABLED !== 'false';
      let streamSession = null;
      if (streamingEnabled) {
        streamSession = new StreamingSTTSession(userId, {
          onPartial: (text) => {
            partialTranscripts.set(userId, { text, ts: Date.now() });
          },
          onConfirmed: (text) => {
            partialTranscripts.set(userId, { text, ts: Date.now() });
            logger.debug(`[SimulStream] confirmed for ${userId}: "${text.substring(0, 60)}"`);
          },
        });
        logger.debug(`[SimulStream] session started for ${userId}`);
      }

      // Second listener — stream chunks to WK (chunks[] push above is unchanged)
      decoder.on('data', (chunk) => {
        streamSession?.sendChunk(chunk);
      });

      // Clean up userSpeaking on error so future audio isn't blocked
      audioStream.once('error', (err) => {
        streamSession?.destroy();
        logger.error(`Audio stream error for ${userId}:`, err.message);
        userSpeaking.delete(userId);
        decoder.destroy();
      });

      decoder.once('error', () => {}); // Suppress unhandled error on destroy

      audioStream.once('end', async () => {
        userSpeaking.delete(userId);
        const totalBuffer = Buffer.concat(chunks);
        const durationMs = (totalBuffer.length / (48000 * 2)) * 1000;

        if (durationMs < MIN_AUDIO_DURATION_MS) {
          streamSession?.destroy();
          return;
        }

        // Finalize streaming session — sends EOF, waits up to 3s for last words
        let streamTranscript = null;
        if (streamSession) {
          try {
            streamTranscript = await streamSession.finish();
          } catch {
            streamSession.destroy();
          }
        }

        if (streamTranscript) {
          logger.info(`[SimulStream] final transcript for ${userId}: "${streamTranscript.substring(0, 80)}"`);
          partialTranscripts.delete(userId);
          await handleSpeech(userId, totalBuffer, streamTranscript);
        } else {
          // Fallback: check cached partial, then let handleSpeech transcribe via HTTP
          const partial = partialTranscripts.get(userId);
          if (partial && Date.now() - partial.ts < 500) {
            partialTranscripts.delete(userId);
            logger.info(`[SimulStream] using cached partial for ${userId}: "${partial.text.substring(0, 60)}"`);
            await handleSpeech(userId, totalBuffer, partial.text);
          } else {
            partialTranscripts.delete(userId);
            await handleSpeech(userId, totalBuffer);
          }
        }
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
    const persona = getActivePersona();
    const audio = await synthesizeSpeech(`${persona.name} online. Voice channel is live.`);
    if (audio) { await playAudioEnhanced(audio); try { unlinkSync(audio); } catch {} }
  } catch (err) {
    logger.error('Greeting failed:', err.message);
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
        logger.info('Enrollment cancelled by voice command');
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
        await fetch(`${process.env.SPEAKER_VERIFY_URL?.replace('/verify', '') || 'http://localhost:8767'}/enroll/reset`, { method: 'POST' }).catch(() => {});
        enrollmentState.clipsCollected = 0;
        enrollmentState.promptIndex = 0;
        enrollmentState.recorded = new Array(enrollmentState.prompts.length).fill(false);
        const firstPrompt = enrollmentState.currentPrompt();
        logger.info('Enrollment restarted from 1/10');
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
            logger.info(`Enrollment finalized early: ${enrollmentState.clipsCollected} clips`);
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
        logger.info(`Enrollment clip transcript: "${clipTranscript}"`);
        postToCC('Enrollment', clipTranscript);
      }

      const result = await enrollmentState.addClip(enrollWavPath);
      try { unlinkSync(enrollWavPath); } catch {}
      if (result.accepted) {
        const consistencyStr = result.consistency_score != null ? ` consistency=${result.consistency_score}` : '';
        logger.info(`Enrollment clip ${enrollmentState.clipsCollected}/${enrollmentState.clipsNeeded} accepted${consistencyStr}`);

        if (enrollmentState.learnMode) {
          postToCC('Learn', `Clip ${enrollmentState.clipsCollected} added. Keep going or say **"done"** to save.`);
          const audio = await synthesizeSpeech(`Got it. ${enrollmentState.clipsCollected} samples total. Keep going or say done.`);
          if (audio) { audioQueue.add(audio); }
        } else if (enrollmentState.clipsCollected >= enrollmentState.clipsNeeded) {
          const finalResult = await enrollmentState.finalize();
          if (finalResult.saved) {
            const count = finalResult.clips_saved || enrollmentState.clipsCollected;
            logger.info(`Enrollment complete: ${count} clips saved`);
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
        logger.info(`Enrollment clip rejected: ${result.reason}`);
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
      logger.error('Enrollment capture error:', err.message);
      try { unlinkSync(enrollWavPath); } catch {}
    }
    return;
  }

  try {
    // Per-request auth context — isolates auth state from concurrent handleSpeech calls.
    // Reading global authenticatedSession here gives us the session state at the moment
    // this specific speech event started processing, preventing races where a concurrent
    // request's auth write bleeds into this request's decision logic.
    const authCtx = { isOwner: authenticatedSession, userId };

    // 1. Transcribe (skip if already transcribed during queue)
    let rawTranscript;
    let sentiment = null;
    let needsEnrollment = false;
    let sttResult = null;
    if (preTranscribed) {
      rawTranscript = preTranscribed;
      logger.info(`(pre-transcribed) "${rawTranscript}"`);
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
    if (spkr && !isVerifiedOwner(spkr, 'medium')) {
      const trimmed = rawTranscript.trim();
      const _wwEscIdx = VOICE_WAKE_WORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const _wakeWordRe = new RegExp(`^(hey[,.]?\\s+)?(${_wwEscIdx}|jarvis)\\b`, 'i');
      const startsWithWakeWord = _wakeWordRe.test(trimmed)
        || WAKE_WORD_PHRASES.some(p => trimmed.toLowerCase().startsWith(p));
      if (startsWithWakeWord) {
        logger.info(`🎯 Wake word from non-owner embedding (confidence=${spkr.confidence} norm=${spkr.norm_score}) — passing to FSM gate`);
        // Let it through — FSM gate will handle wake-up with unauthenticated session
      } else {
        const isLong = rawTranscript.length > 80;
        if (spkr.confidence_tier === 'low' || spkr.norm_score < 0.5 || isLong) {
          logger.info(`🔇 Non-owner audio filtered (confidence=${spkr.confidence} norm=${spkr.norm_score} tier=${spkr.confidence_tier} len=${rawTranscript.length}): "${rawTranscript.substring(0, 50)}..."`);
          return;
        }
      }
    }

    // ── TV dialogue extraction: parse Jarvis command out of long noisy transcripts ──
    // When TV is playing, Whisper captures both TV dialogue and owner speech in one chunk.
    // Instead of dropping the whole thing, extract just the Jarvis command.
    // e.g. "...blah TV noise... Jarvis, check my messages. ...more TV noise..." → "Jarvis, check my messages."
    if (rawTranscript.length > 60 && getState() === 'SLEEP') {
      const _wakeTerms = [...new Set(['jarvis', 'gargis', 'service', VOICE_WAKE_WORD, ...WAKE_WORD_PHRASES])];
      const _wakeTermsRe = new RegExp(`\\b(${_wakeTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
      const jarvisIdx = rawTranscript.search(_wakeTermsRe);
      if (jarvisIdx > 20) {
        // Wake word is buried deep -- TV dialogue before it. Extract from wake word onward.
        const fromJarvis = rawTranscript.substring(jarvisIdx);
        const sentenceEnd = fromJarvis.match(/[.!?]\s/g);
        const extracted = sentenceEnd && sentenceEnd.length >= 2
          ? fromJarvis.substring(0, fromJarvis.indexOf(sentenceEnd[1]) + sentenceEnd[1].length).trim()
          : fromJarvis.substring(0, 200).trim();
        logger.info(`🔧 TV noise extraction: ${rawTranscript.length} chars → ${extracted.length} chars: "${extracted.substring(0, 80)}"`);
        rawTranscript = extracted;
      } else if (jarvisIdx === -1 && spkr && spkr.confidence_tier === 'low') {
        // Long transcript, no Jarvis, LOW confidence only -- pure TV dialogue
        logger.info(`🔇 TV dialogue filtered (norm=${spkr.norm_score} tier=${spkr.confidence_tier} len=${rawTranscript.length}): "${rawTranscript.substring(0, 60)}..."`);
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
    logger.info(`[FSM-gate] state=${currentState} speaker=${spkrTag} transcript="${rawTranscript.substring(0, 40)}..."`);

    // SLEEP: only wake-up commands pass (including fuzzy wake word when speaker verified)
    const spkrIsOwner = isVerifiedOwner(spkr, 'high');
    if (currentState === 'SLEEP') {
      // SLEEP wake logic:
      // 1. Explicit "Jarvis" patterns (WAKE_UP_PATTERNS) — always allowed
      // 2. Fuzzy wake (Whisper mishears: "Gerri's", "Gargis", "hey you") — only when HIGH confidence speaker
      //    Medium confidence was getting is_owner=true (benefit-of-the-doubt) which let any
      //    vocative prefix ("thank", "yeah", etc.) match. Require HIGH tier in SLEEP only.
      // 3. Everything else → drop silently.
      const cleanTranscript = rawTranscript.trim().replace(/[.,!?;:]+$/g, '');
      const strictWakeMatch = WAKE_UP_PATTERNS.some(p => p.test(cleanTranscript));
      // Fuzzy wake only for HIGH confidence verified speaker (not medium benefit-of-the-doubt)
      const sleepSpkrVerified = isVerifiedOwner(spkr, 'high');
      const sleepWakeMatch = strictWakeMatch || isWakeUpCommand(cleanTranscript, sleepSpkrVerified);
      if (sleepWakeMatch) {
        const wakeSpkr = sttResult?.speakerInfo;
        // Allow wake word even with TV-corrupted embeddings — "Jarvis" is rare on TV.
        // Session stays unauthenticated so follow-up commands need clean speaker verify.
        transition('ACTIVE', 'wake-word');
        authCtx.isOwner = isVerifiedOwner(wakeSpkr, 'high');
        authenticatedSession = authCtx.isOwner;
        resetIdleSleepTimer();
        // Strip wake word prefix: try standard patterns first, fall back to fuzzy vocative
        // Strip wake word prefix: try configured wake word first, then "jarvis" (legacy), then fuzzy vocative
        const _wwStripEsc = VOICE_WAKE_WORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const _wakeStripRe = new RegExp(`^(hey\\s+)?(${_wwStripEsc}|jarvis)[,.]?\\s*`, 'i');
        let stripped = rawTranscript.replace(_wakeStripRe, '').trim();
        if (stripped === rawTranscript.trim()) {
          // Standard strip didn't match — try WAKE_WORD_PHRASES prefixes
          const _matchedPhrase = WAKE_WORD_PHRASES.find(p => rawTranscript.toLowerCase().startsWith(p));
          if (_matchedPhrase) {
            stripped = rawTranscript.substring(_matchedPhrase.length).replace(/^[,.\s]+/, '').trim();
          } else {
            // Last resort: fuzzy vocative prefix ([word], sentence)
            stripped = rawTranscript.replace(/^[a-zA-Z]{1,12}[,.]?\s+/i, '').trim();
          }
        }
        if (stripped.length > 2) {
          logger.info(`SLEEP -> ACTIVE with command (authenticated=${authCtx.isOwner}): "${stripped}"`);
          // fall through to process
        } else {
          logger.info(`SLEEP -> ACTIVE (bare wake word, authenticated=${authCtx.isOwner})`);
          const audio = await synthesizeSpeech('Back online. What do you need?');
          if (audio) { audioQueue.add(audio); }
          markBotResponse(userId);
          return;
        }
      } else if (isAttentionWindowActive()) {
        // Post-speak attention window: Jarvis just reported a task result while in SLEEP.
        // Routes through the central auth gate (context='attention') — same strictness as
        // a wake word. Any future auth changes in passesAuthGate apply here automatically.
        const { authorized: attentionAuth } = passesAuthGate(spkr, { context: 'attention' });
        if (!attentionAuth) {
          logger.info(`👂 Post-speak attention window: auth gate rejected speaker (${spkrTag}) — keeping window open`);
          return; // not the owner — drop silently, keep window open for the real user
        }
        logger.info(`👂 Post-speak attention window: auth gate passed (${spkrTag}) — "${rawTranscript.substring(0, 60)}"`);
        transition('ACTIVE', 'post-speak-attention');
        authCtx.isOwner = true;
        authenticatedSession = true;
        closeAttentionWindow();
        resetIdleSleepTimer();
        // fall through to process
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
        authCtx.isOwner = isVerifiedOwner(wakeSpkr, 'high');
        authenticatedSession = authCtx.isOwner;
        resetIdleSleepTimer();
        // fall through -- checkWakeWord handles transcript cleaning
      } else if (isContinuationPhrase(rawTranscript) && hasRecentContext(userId)) {
        // Follow-up to recent conversation -- no wake word needed
        logger.info(`💬 Continuation phrase in IDLE: "${rawTranscript.substring(0, 50)}" -- resuming`);
        transition('ACTIVE', 'continuation-from-idle');
        authCtx.isOwner = true;
        authenticatedSession = true; // trust context -- was authenticated before IDLE
        resetIdleSleepTimer();
        // fall through to process
      } else if (isVerifiedOwner(spkr, 'high') && hasRecentContext(userId) && isFollowUpExpected()) {
        // Verified owner responding to an alert/prompt -- speaker ID is the auth
        logger.info(`Owner response to alert/prompt in IDLE (speaker=${spkr.confidence} tier=${spkr.confidence_tier}) -- no wake word needed`);
        transition('ACTIVE', 'owner-response-from-idle');
        authCtx.isOwner = true;
        authenticatedSession = true;
        resetIdleSleepTimer();
        // fall through to process
      } else {
        return; // drop non-wake-word audio in IDLE
      }
    }

    // Filter Whisper hallucinations — phantom phrases from silence/ambient
    if (isHallucination(rawTranscript)) {
      logger.info(`Whisper hallucination filtered: "${rawTranscript}"`);
      return;
    }

    logger.info(`📝 "${rawTranscript}" (${Date.now() - startTime}ms)`);
    postToCC('🎤', rawTranscript);

    // ── Pre-wake-word sleep check (two-tier) ──
    // Tier 1: Standalone sleep — pure sleep command, no task content → immediate sleep
    // Tier 2: Sign-off + task — "we're good, check my email" → dispatch task, auto-sleep after
    const _wwPreSleepEsc = VOICE_WAKE_WORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const _preSleepWakeRe = new RegExp(`\\b(jarvis|${_wwPreSleepEsc})\\b`, 'gi');
    const preSleepCheck = rawTranscript.toLowerCase().replace(/[.,!?]/g, '').replace(_preSleepWakeRe, '').trim();
    if (await fsmHandleSleepCheck(preSleepCheck, 'voice-command-pre-wake', userId, _pendingUtterance, synthesizeSpeech, audioQueue)) return;
    // If fsmHandleSleepCheck returned false with autoSleepAfterTask set, fall through to dispatch

    // Log sentiment if detected
    if (sentiment && sentiment.sentiment) {
      const scoreStr = sentiment.sentiment_score != null ? ` (${sentiment.sentiment_score.toFixed(2)})` : '';
      logger.info(`🎭 Sentiment: ${sentiment.sentiment}${scoreStr}`);
      postActivity(`🎭 Sentiment: ${sentiment.sentiment}${scoreStr}`);
    }

    // 2. Wake word check
    // For fuzzy wake word: accept medium confidence tier too — Whisper mishears "Jarvis" as
    // phonetically similar words (Curtis, Gervas, jargos) which score medium, not high.
    // High confidence = strong match; medium = likely owner with codec degradation.
    const speakerLikelyOwner = isVerifiedOwner(spkr, 'medium');
    const { detected, cleanedTranscript, wakeWordUsed } = checkWakeWord(rawTranscript, userId, speakerLikelyOwner);
    if (!detected) return;

    // ── Session-Based Speaker Authentication ──
    // Like Siri/Google: verify on wake word, trust the session after.
    // Uses authCtx (per-request snapshot) to avoid races with concurrent handleSpeech calls.
    // Writes still propagate to the global for session persistence (sleep timers, FSM, etc.).
    const speakerInfo = sttResult?.speakerInfo;
    if (speakerInfo && !authCtx.isOwner) {
      // Wake word detected -- this is the authentication moment
      // confidence_tier from server: "high" (auto-accept), "medium" (accept in session context), "low" (reject)
      if (isVerifiedOwner(speakerInfo, 'high')) {
        authCtx.isOwner = true;
        authenticatedSession = true;
        const tier = speakerInfo.confidence_tier || 'unknown';
        logger.info(`Session authenticated (wake word confidence=${speakerInfo.confidence} tier=${tier})`);
      } else {
        // Check for passphrase override
        const cleanLowerAuth = cleanedTranscript.toLowerCase().replace(/[.,!?]/g, '').trim();
        if (SESSION_PASSPHRASE && cleanLowerAuth.includes(SESSION_PASSPHRASE.toLowerCase())) {
          authCtx.isOwner = true;
          authenticatedSession = true;
          logger.info(`🔓 Session authenticated (passphrase override, confidence=${speakerInfo.confidence})`);
        } else {
          // Speaker doesn't match on wake word — reject with throttled rebuff
          const now = Date.now();
          if (!handleSpeech._lastRebuff || now - handleSpeech._lastRebuff > REBUFF_COOLDOWN_MS) {
            handleSpeech._lastRebuff = now;
            const rebuffs = [
              "I'm sorry, I only respond to my principal's voice.",
              "Voice not recognized. Access denied.",
              "I don't recognize you. Only my principal can wake me.",
            ];
            const rebuff = rebuffs[Math.floor(Math.random() * rebuffs.length)];
            logger.info(`🔒 Wake word rejected: confidence=${speakerInfo.confidence}`);
            try {
              const audio = await synthesizeSpeech(rebuff);
              if (audio) { audioQueue.add(audio); }
            } catch {}
          } else {
            logger.info(`🔒 Wake word rejected (throttled): confidence=${speakerInfo.confidence}`);
          }
          return;
        }
      }
    } else if (authCtx.isOwner) {
      // Session authenticated -- but still reject clearly non-owner audio (TV/ambient)
      // The per-utterance filter above catches most, but double-check here for safety
      if (speakerInfo && !isVerifiedOwner(speakerInfo, 'medium') && speakerInfo.confidence_tier === 'low') {
        logger.info(`🔇 Active session: non-owner audio rejected (confidence=${speakerInfo.confidence} tier=${speakerInfo.confidence_tier})`);
        return;
      }
      // Medium-tier floor: 0.35 raw minimum in active sessions
      // (was 0.45 but that rejected Lance through Discord voice codec too aggressively)
      if (speakerInfo && speakerInfo.confidence_tier === 'medium' && speakerInfo.confidence < 0.35) {
        logger.info(`🔇 Active session: medium-tier below floor rejected (confidence=${speakerInfo.confidence})`);
        return;
      }
      if (speakerInfo) {
        logger.info(`Session active (confidence=${speakerInfo.confidence} tier=${speakerInfo.confidence_tier || ''})`);
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
    if (await fsmHandleSleepCheck(cleanLower, 'voice-command', userId, _pendingUtterance, synthesizeSpeech, audioQueue)) return;
    // If fsmHandleSleepCheck returned false with autoSleepAfterTask set, fall through to task dispatch
    // ──────────────────────────────────────────────────────

    // ── Enrollment Gating: no voiceprint enrolled (strict mode) ──
    // Only allow "enroll my voice" and sleep commands; block everything else.
    // Placed after wake word + sleep check so "Jarvis, go to sleep" works without auth.
    if (needsEnrollment) {
      const isEnrollCmd = rawTranscript.match(/(en\s*roll|in\s*roll|and\s*roll|can\s*roll|un\s*roll)\s*(my\s*)?voice/i);
      if (!isEnrollCmd) {
        if (!handleSpeech._lastEnrollPrompt || Date.now() - handleSpeech._lastEnrollPrompt > 30000) {
          handleSpeech._lastEnrollPrompt = Date.now();
          logger.info('No voiceprint enrolled -- prompting enrollment');
          const audio = await synthesizeSpeech('No voiceprint on file. Say "Jarvis, enroll my voice" to set up speaker verification.');
          if (audio) { audioQueue.add(audio); }
        }
        return;
      }
    }

    // 3. Stop words — dismiss phrases that don't need a response (length-gated)
    const dismissResult = shouldDismiss(cleanedTranscript);
    if (dismissResult.dismiss) {
      logger.info(`🤚 Stop word dismissed (${dismissResult.reason}): "${cleanedTranscript}"`);
      return;
    }

    // 3b. Side-talk — short non-directed speech in conversation window
    // Pass inConversationWindow so coherence gate doesn't drop short follow-up replies
    const inConvWindow = hasRecentContext(userId);
    if (isSideTalk(cleanedTranscript, wakeWordUsed, inConvWindow)) {
      logger.info(`💭 Side-talk dismissed (no wake word, short, convWindow=${inConvWindow}): "${cleanedTranscript}"`);
      return;
    }

    // 3c. Truncated fragment — VAD fired mid-sentence (pause > VAD_TIMEOUT).
    // Silently drop rather than responding with "sounds like that got clipped."
    // Only applies when no wake word was used (wake-word utterances proceed regardless).
    if (!wakeWordUsed && isTruncatedFragment(rawTranscript)) {
      logger.info(`✂️ Truncated fragment silently dropped: "${rawTranscript.substring(0, 60)}"`);
      return;
    }

    // 4. Bare wake word — just "Jarvis" / "Jarvis." / "Jarvis?" with no real command.
    const bareCheck = cleanedTranscript.replace(/[.,!?;:\-'"]/g, '').trim();
    if (!bareCheck || bareCheck.length === 0) {
      logger.info(`🎯 Bare wake word — acknowledging`);
      const acks = ['Sir?', 'At your service.', 'Yes, sir?', 'How can I help?', 'Listening.'];
      const ack = acks[Math.floor(Math.random() * acks.length)];
      const audio = await synthesizeSpeech(ack);
      if (audio) { audioQueue.add(audio); audioQueue.playNext(); }
      markBotResponse(userId);
      return;
    }

    // Track interaction for handoff detection
    lastInteractionTime = Date.now();
    lastUserMessage = cleanedTranscript.substring(0, 100);

    // ── Command dispatch — routes mode toggles, enrollment, interrupts, or brain call ──
    const dispatchResult = dispatchCommand(rawTranscript, cleanedTranscript, userId, ALLOWED_USERS, enrollmentState);

    if (dispatchResult.type === 'mode_toggle') {
      if (dispatchResult.mode === 'tldr' && dispatchResult.success) {
        const newState = dispatchResult.enabled ? 'enabled' : 'disabled';
        logger.info(`🎙️ Voice TL;DR mode ${newState}`);
        const ack = await synthesizeSpeech(`Voice TL;DR mode ${newState}.`);
        if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      } else if (dispatchResult.mode === 'transcript' && dispatchResult.success) {
        const newState = dispatchResult.enabled ? 'enabled' : 'disabled';
        logger.info(`📝 Voice full transcript mode ${newState}`);
        const ack = await synthesizeSpeech(`Full transcript mode ${newState}.`);
        if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      } else if (dispatchResult.mode === 'ask' && dispatchResult.success) {
        logger.info(`🛡️ Ask mode ${dispatchResult.enabled ? 'enabled' : 'disabled'}`);
        const ack = await synthesizeSpeech(dispatchResult.enabled
          ? `Ask mode enabled. I'll confirm before taking any actions.`
          : `Ask mode disabled. Executing freely.`);
        if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      } else if (dispatchResult.mode === 'tts' && dispatchResult.success) {
        const p = dispatchResult.provider;
        const voiceName = p === 'edge' ? 'Sonia' : p === 'piper' ? 'JARVIS' : p === 'chatterbox' ? 'Lance clone' : p;
        logger.info(`🎭 Switched to ${p} TTS (${voiceName})`);
        if (dispatchResult.needsRestart) {
          const ack = await synthesizeSpeech(`Switching to ${voiceName} voice. Restarting now.`);
          if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
          setTimeout(async () => {
            const { execSync } = await import('child_process');
            try { execSync('systemctl --user restart jarvis-voice'); }
            catch (e) { logger.error('voice restart failed:', e.message); }
          }, 1500);
        } else {
          const ack = await synthesizeSpeech(`Switched to ${voiceName} voice.`);
          if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
        }
      } else if (dispatchResult.mode === 'mobile' && dispatchResult.success) {
        const newState = dispatchResult.enabled ? 'enabled' : 'disabled';
        logger.info(`📱 Mobile mode ${newState}`);
        const ack = await synthesizeSpeech(dispatchResult.enabled
          ? `Mobile mode on. I'll narrate as I work and keep you updated hands-free.`
          : `Mobile mode off. Back to standard voice output.`);
        if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      }
      return;
    }

    if (dispatchResult.type === 'persona_switch') {
      const { persona, voice, wakeWords } = dispatchResult;
      logger.info(`🎭 Persona switch requested: ${persona} (voice: ${voice})`);
      // 1. Speak ack in OLD voice (instant feedback before GPU pre-warm)
      const ack = await synthesizeSpeech(`Switching to ${persona}.`);
      if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      // 2. Atomic switch: await voice clone + rollback on failure
      try {
        await switchPersonaFull(persona.toLowerCase());
        logger.info(`🎭 Persona switch complete: ${persona} ✅`);
        // 3. Confirmation spoken in NEW voice
        const confirm = await synthesizeSpeech(`${persona} online.`);
        if (confirm) { await playAudioEnhanced(confirm); try { unlinkSync(confirm); } catch {} }
      } catch (e) {
        logger.warn(`[persona] switch failed, reverting: ${e.message}`);
        const revertName = e.revertedTo || 'previous persona';
        const errAck = await synthesizeSpeech(`Voice switch failed. Staying on ${revertName}.`);
        if (errAck) { await playAudioEnhanced(errAck); try { unlinkSync(errAck); } catch {} }
      }
      return;
    }

    // ── Channel focus commands ──────────────────────────────────────────
    if (dispatchResult.type === 'focus_set') {
      const { channelName, purpose } = dispatchResult;
      logger.info(`🎯 Focus set: #${channelName}`);
      const msg = purpose
        ? `Focused on ${channelName}. ${purpose.substring(0, 80)}.`
        : `Focused on ${channelName}.`;
      const ack = await synthesizeSpeech(msg);
      if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      return;
    }

    if (dispatchResult.type === 'focus_clear') {
      logger.info('🎯 Focus cleared');
      const ack = await synthesizeSpeech('Focus cleared. No channel context active.');
      if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      return;
    }

    if (dispatchResult.type === 'focus_query') {
      const { focus } = dispatchResult;
      const msg = focus
        ? `Currently focused on ${focus.channelName}.`
        : 'No channel focus set. Say "focus on" followed by a channel name to set one.';
      const ack = await synthesizeSpeech(msg);
      if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      return;
    }

    if (dispatchResult.type === 'channel_list') {
      const { channels } = dispatchResult;
      const names = channels.slice(0, 10).map(c => c.name);
      const msg = `Available channels: ${names.join(', ')}. ${channels.length > 10 ? `And ${channels.length - 10} more.` : ''}`;
      const ack = await synthesizeSpeech(msg);
      if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      return;
    }

    if (dispatchResult.type === 'persona_list') {
      const { available, current } = dispatchResult;
      const others = available.filter(p => p !== current.toLowerCase());
      const listText = others.length
        ? `Current persona is ${current}. Available: ${others.join(', ')}.`
        : `Only ${current} is available.`;
      logger.info(`📋 Persona list: ${available.join(', ')} (active: ${current})`);
      const ack = await synthesizeSpeech(listText);
      if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      return;
    }

    if (dispatchResult.type === 'enrollment') {
      if (dispatchResult.action === 'cancel') {
        enrollmentState.cancel();
        const audio = await synthesizeSpeech('Enrollment cancelled.');
        if (audio) { await playAudioEnhanced(audio); try { unlinkSync(audio); } catch {} }
        return;
      }
      if (dispatchResult.action === 'restart') {
        try {
          const { unlinkSync: ul } = await import('fs');
          const { join: j } = await import('path');
          const home = process.env.HOME || '/tmp';
          const vp1 = j(home, '.jarvis', 'owner_voiceprint.npy');
          const vp2 = j(home, '.jarvis', 'owner_voiceprints.npy');
          try { ul(vp1); } catch {}
          try { ul(vp2); } catch {}
          await fetch(`${process.env.SPEAKER_VERIFY_URL?.replace('/verify', '') || 'http://localhost:8767'}/enroll/reset`, { method: 'POST' }).catch(() => {});
          logger.info('Voiceprints wiped — starting fresh enrollment');
        } catch (e) { logger.error('Voiceprint wipe error:', e.message); }
        // Fall through to start enrollment below
      }
      if (dispatchResult.action === 'learn') {
        enrollmentState.start(userId, true);
        logger.info('Learn mode started — adding samples to voiceprint');
        postToCC('🎙️ Learn Mode', 'Speak naturally. Each clip improves your voiceprint. Say **"done"** to save.');
        const audio = await synthesizeSpeech('Learn mode on. Just talk naturally and I\'ll add each clip to your voiceprint. Say done when finished.');
        if (audio) { await playAudioEnhanced(audio); try { unlinkSync(audio); } catch {} }
        return;
      }
      if (dispatchResult.action === 'start' || dispatchResult.action === 'restart') {
        enrollmentState.start(userId);
        const firstPrompt = enrollmentState.currentPrompt();
        logger.info(`Voice enrollment started -- ${enrollmentState.clipsNeeded} guided phrases`);
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
        if (audio) { await playAudioEnhanced(audio); try { unlinkSync(audio); } catch {} }
        return;
      }
    }

    if (dispatchResult.type === 'interrupt') {
      logger.info(`⛔ Interrupt command: "${rawTranscript}"`);
      cancelAllTasks();
      const stopAudio = await synthesizeSpeech('Stopped.');
      if (stopAudio) { await playAudioEnhanced(stopAudio); try { unlinkSync(stopAudio); } catch {} }
      return;
    }

    if (dispatchResult.type === 'stop_word' || dispatchResult.type === 'side_talk') {
      return;
    }

    if (dispatchResult.type === 'bare_wake') {
      markBotResponse(userId);
      const chime = await synthesizeSpeech('Yes?');
      if (chime) { playAudioEnhanced(chime).then(() => { try { unlinkSync(chime); } catch {} }).catch(() => {}); }
      return;
    }

    // dispatchResult.type === 'brain' — fall through to background brain call
    const transcript = dispatchResult.transcript || cleanedTranscript;

    // ── Background brain call (async — non-blocking) ──
    
    if (!conversations.has(userId)) conversations.set(userId, { history: [], lastActive: Date.now() });
    const conv = conversations.get(userId);
    conv.lastActive = Date.now();
    
    // Add user message to history immediately
    conv.history.push({ role: 'user', content: transcript });
    while (conv.history.length > CONVERSATION_HISTORY_MAX) conv.history.shift();
    
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
    if (lastSeen && now - lastSeen < TRANSCRIPT_DEDUP_MS) {
      logger.info(`⏭️  Transcript dedup: skipping duplicate "${transcript.substring(0, 40)}..." (${now - lastSeen}ms ago)`);
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
    logger.error({ err }, `❌ Speech dispatch error: ${err.message}`);
    // Only give audio feedback for real STT service failures (not empty/ambient noise)
    if (err.message && err.message.includes('STT failed') && !err.message.includes('Empty transcript')) {
      try {
        const failAudio = await synthesizeSpeech("I couldn't understand that. Could you try again?");
        if (failAudio) { await playAudioEnhanced(failAudio); try { unlinkSync(failAudio); } catch {} }
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
      logger.warn(`🔴 Task #${taskId} — gateway circuit breaker is open, informing user`);
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
      logger.warn(`🟡 Task #${taskId} — gateway unhealthy, proceeding with caution`);
    }

    logger.info({ taskId, transcript: transcript.substring(0, 60), gatewayHealthy: isGatewayHealthy() }, '🧠 brain task processing');

    // Phase 1: Fast Ack (Haiku)
    // Buy time for the main model to think. Returns in ~1-2s.
    // Controlled by IMMEDIATE_ACKS_ENABLED and VOICE_ACK_ENABLED env flags (both default ON).
    // Set VOICE_ACK_ENABLED=false to suppress all acks (master flag).
    // Set IMMEDIATE_ACKS_ENABLED=false to suppress only the fast pre-emptive Haiku ack.
    if (IMMEDIATE_ACKS_ENABLED && VOICE_ACK_ENABLED) {
      const cachedAck = getRandomCachedAck();
      if (cachedAck) {
        audioQueue.add(cachedAck);
        logger.info('⚡ Playing cached ack');
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
        logger.warn(`⚠️ Contextual ack failed: ${err.message}`);
        return null;
      });
    }

    // ── ACTION Intent → Webhook Dispatch (with tools) ─────────────────
    // /v1/chat/completions has NO tool access — the model can't call sessions_spawn.
    // For ACTION intents, dispatch via /hooks/agent which triggers a full agent turn
    // with tools. The result comes back via /speak callback. This is the ONLY path
    // that can actually execute actions.
    const actionIntents = new Set(['ACTION', 'EMAIL_ACTION', 'CALENDAR_ACTION']);
    const intentType = brainOptions.intentType || 'QUERY';
    if (actionIntents.has(intentType)) {
      logger.info(`🚀 Task #${taskId} intent=${intentType} → webhook dispatch (full tools)`);
      
      // Speak contextual ack while webhook processes
      if (contextualAckPromise) {
        try {
          const ackText = await contextualAckPromise;
          if (ackText) {
            logger.info(`🎯 Contextual dispatch ack: "${ackText}"`);
            const ackAudio = await synthesizeSpeech(ackText);
            if (ackAudio) audioQueue.add(ackAudio);
          }
        } catch (e) {
          logger.warn(`⚠️ Contextual ack failed: ${e.message}`);
        }
      }

      const webhookResult = await dispatchViaWebhook(transcript, history, {
        ...brainOptions,
        taskId,
      });

      if (webhookResult.dispatched) {
        markWorking(taskId);  // Ledger: task is now working via webhook
        hudTaskUpdate(taskId, 'working');
        postActivity(`🚀 **Task #${taskId}** dispatched via webhook (${intentType}) — awaiting /speak callback`);
        logger.info(`📨 Task #${taskId} dispatched successfully — result will arrive via /speak`);
      } else {
        markFailed(taskId, webhookResult.error);  // Ledger: dispatch failed
        hudTaskUpdate(taskId, 'failed');
        logger.error(`❌ Task #${taskId} webhook dispatch failed: ${webhookResult.error}`);
        const failMsg = "I'm having trouble dispatching that right now, sir.";
        try {
          const audio = await synthesizeSpeech(failMsg);
          if (audio) audioQueue.add(audio);
        } catch (_) {}
        postActivity(`❌ **Task #${taskId}** webhook dispatch failed: ${webhookResult.error}`);
      }
      return;
    }

    // ── KNOWLEDGE Intent → Streaming TTS (no tools needed) ────────────
    // TTS pipeline for parallel sentence generation
    const ttsPipeline = new TtsPipeline(synthesizeSpeech, audioQueue, {
      maxConcurrent: TTS_PIPELINE_CONCURRENCY,
      onError: (err) => logger.error(`TTS pipeline error for task #${taskId}:`, err.message),
    });
    setTTSDeliveryActive(true);
    
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
    
    const BATCH_FLUSH_MIN = BATCH_FLUSH_MIN_CHARS;   // Min chars before flushing -- lower for faster first-audio
    const BATCH_FLUSH_MAX = BATCH_FLUSH_MAX_CHARS;  // Max chars before forced flush (keeps chunks digestible)
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
        logger.info(`🔁 Deduped chunk: "${text.substring(0, 40)}" → "${deduped.substring(0, 40)}"`);
        text = deduped;
      }
      if (!text || text.length < 2) return;
      // Skip if identical to last flushed chunk
      if (text === lastFlushedText) {
        logger.info(`⏭️  Skipping duplicate chunk: "${text.substring(0, 40)}"`);
        return;
      }
      lastFlushedText = text;

      // Self-mute queue intercept — capture text instead of synthesizing
      if (MUTE_QUEUE_ENABLED && isMuteQueueActive()) {
        muteQueueAdd(text, 'task', 3);
        logger.info(`🔇 Chunk intercepted → mute queue (${text.length} chars)`);
        return;
      }

      batchNum++;
      logger.info(`🔊 Chunk #${batchNum}: ${text.length} chars → pipeline`);
      // Mark this task as having spoken inline — suppresses redundant /speak task-progress voice
      if (batchNum === 1) markTaskSpokeInline(taskId);
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
        markStreaming(taskId);  // Ledger: first tokens received
        hudTaskUpdate(taskId, 'streaming');
        logger.info(`⏱️  Task #${taskId} first sentence: ${Date.now() - startTime}ms`);
      }

      logger.info(`📨 Task #${taskId} onSentence: "${sentence.substring(0, 60)}..." (${sentence.length} chars, tldr=${tldrModeEnabled}, disconnected=${userDisconnected}, ttsAvail=${isTTSAvailable()})`);

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
            // Flush BEFORE adding if this sentence would exceed max
            // (prevents 500+ char chunks that cause Chatterbox repetition)
            if (batchText.length > 0 && (batchText.length + sentence.length) > BATCH_FLUSH_MAX) {
              // Only flush if batchText ends with sentence-ending punctuation
              // to avoid splitting mid-sentence when brain.js sends partial chunks
              if (/[.!?]["''")\]]*\s*$/.test(batchText.trim())) {
                flushToPipeline(batchText);
                batchText = '';
              } else if (batchText.length > BATCH_FLUSH_MAX * 1.5) {
                // Hard safety limit — flush even mid-sentence if way too long
                flushToPipeline(batchText);
                batchText = '';
              }
              // else: keep accumulating — text doesn't look like a complete sentence yet
            }
            batchText += sentence + ' ';
            // Also flush if batch already hit min and the BATCH ends on a sentence boundary
            // (changed: check batchText ends with punctuation, not just sentence length)
            if (batchText.length >= BATCH_FLUSH_MIN && /[.!?]["''")\]]*\s*$/.test(batchText.trim())) {
              flushToPipeline(batchText);
              batchText = '';
            }
          }
        }
      }
    }, brainOptions);
    
    // Task was cancelled
    if (result.aborted) {
      markFailed(taskId, 'aborted');  // Ledger: task aborted
      hudTaskUpdate(taskId, 'failed');
      logger.info(`Task #${taskId} aborted`);
      ttsPipeline.clear();
      audioQueue.clear();
      setTTSDeliveryActive(false);
      flushPendingSpeaks().catch(() => {});
      postActivity(`**Task #${taskId}** cancelled after ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
      return;
    }

    // Agent signal (NO_REPLY / HEARTBEAT_OK) — nothing to say, silent drop
    // This is the primary indicator that a sub-agent was spawned.
    if (result.silent) {
      logger.info(`🤫 Task #${taskId} silent/NO_REPLY (${((Date.now() - startTime) / 1000).toFixed(1)}s) — sub-agent likely spawned`);
      // ── Speak contextual dispatch ack ──
      if (contextualAckPromise) {
        try {
          const ackText = await contextualAckPromise;
          if (ackText) {
            logger.info(`🎯 Contextual dispatch ack: "${ackText}"`);
            const ackAudio = await synthesizeSpeech(ackText);
            if (ackAudio) audioQueue.add(ackAudio);
            postActivity(`🎯 **Task #${taskId}** dispatch ack: "${ackText}"`);
          }
        } catch (e) {
          logger.warn(`⚠️ Contextual ack speak failed: ${e.message}`);
        }
      }
      postActivity(`**Task #${taskId}** silent (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
      return;
    }

    // Empty response from gateway -- sub-agent spawned, callback expected via /speak
    if (result.empty) {
      logger.info(`📭 Task #${taskId} empty response (${((Date.now() - startTime) / 1000).toFixed(1)}s) — sub-agent spawned, awaiting /speak callback`);
      // ── Speak contextual dispatch ack ──
      if (contextualAckPromise) {
        try {
          const ackText = await contextualAckPromise;
          if (ackText) {
            logger.info(`🎯 Contextual dispatch ack: "${ackText}"`);
            const ackAudio = await synthesizeSpeech(ackText);
            if (ackAudio) audioQueue.add(ackAudio);
            postActivity(`🎯 **Task #${taskId}** dispatch ack: "${ackText}"`);
          }
        } catch (e) {
          logger.warn(`⚠️ Contextual ack speak failed: ${e.message}`);
        }
      }
      postActivity(`**Task #${taskId}** returned empty response (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
      // Flush any pending text (e.g. "On it, sir.") from batchText into TTS pipeline
      if (batchText.trim().length > 0) {
        flushToPipeline(batchText);
        batchText = '';
      }
      await ttsPipeline.drain();
      setTTSDeliveryActive(false);
      await flushPendingSpeaks();
      return;
    }
    
    // ── Hallucination Detection ──────────────────────────────────────
    // If intent was ACTION but gateway returned spoken text (not NO_REPLY),
    // it likely hallucinated a response instead of calling sessions_spawn.
    // Log a warning so we can track this. The text still plays (better than
    // silence), but this makes the failure visible.
    const intentCategory = brainOptions.intentType || 'QUERY';
    const isActionIntent = ['ACTION', 'EMAIL_ACTION', 'CALENDAR_ACTION'].includes(intentCategory);
    const gatewayActuallySpoke = batchNum > 0; // at least one chunk went to TTS
    if (isActionIntent && gatewayActuallySpoke && !result.silent && !result.empty) {
      logger.warn(`⚠️  HALLUCINATION DETECTED: Task #${taskId} intent=${intentCategory} but gateway returned text instead of spawning. User heard: "${fullResponse.substring(0, 100)}..."`);
      postActivity(`⚠️ **Task #${taskId}** possible hallucination — intent was ${intentCategory} but gateway spoke text instead of spawning a sub-agent.`);
    }

    // Flush remaining text and wait for pipeline to finish
    logger.info(`📊 Task #${taskId} final flush check: batchText="${batchText.substring(0, 40)}..." (${batchText.trim().length} chars, tldr=${tldrModeEnabled}, disconnected=${userDisconnected})`);
    if (batchText.trim().length > 0 && !tldrModeEnabled && !userDisconnected) {
      flushToPipeline(batchText);
      batchText = '';
    }
    // Wait for all queued TTS to finish generating and playing
    await ttsPipeline.drain();
    setTTSDeliveryActive(false);
    await flushPendingSpeaks();
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    // Strip any leaked signal fragments from the final text
    const fullText = (result.text || fullResponse || '')
      .replace(/(?:^|\s)_?NO_?REPLY(?:\s|[.!?]|$)/gi, ' ')
      .replace(/(?:^|\s)HEARTBEAT_?OK(?:\s|[.!?]|$)/gi, ' ')
      .trim();
    logger.info(`💬 Task #${taskId} done (${Date.now() - startTime}ms): "${fullText.substring(0, 80)}..."`);
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
    
    // enforceOutputLength retained for TL;DR mode only — no channel posting needed here
    // Full response is already in the task thread; streaming pipeline spoke everything.
    if (tldrModeEnabled) enforceOutputLength(fullText, true);

    // ── Smart Thread Routing: Always post to #hud as a thread when configured ──
    // Groups results by intent category — same category within TTL continues the thread.
    // ── Full Transcript Mode: Post complete back-and-forth conversation as thread ──
    // When transcript mode is on, it replaces postTaskToThread to avoid double-posting.
    const transcriptModeEnabled = isTranscriptModeEnabled();
    if (transcriptModeEnabled && !userDisconnected) {
      logger.info(`📝 Full transcript mode enabled — posting conversation as thread (task #${taskId})`);
      await postTranscriptThread(taskId, transcript, fullText, duration);
    } else if (VOICE_REPORT_CHANNEL_ID && fullText) {
      const taskMeta = activeTasks.get(taskId);
      const intentCategory = taskMeta?.intentType || brainOptions.intentType || 'ACTION';
      logger.info(`📤 Posting task #${taskId} (${intentCategory}) to thread in channel ${VOICE_REPORT_CHANNEL_ID}`);
      postTaskToThread(client, VOICE_REPORT_CHANNEL_ID, intentCategory, taskId, transcript, fullText, duration)
        .catch(err => logger.error(`[ThreadRouter] postTaskToThread failed for task #${taskId}: ${err.message}`));
    }
    
    // ── Task Ledger: mark completion ──
    // Check if the response was just an ack (sub-agent spawned, real work pending)
    if (isJustAck(fullText)) {
      markWorking(taskId);
      hudTaskUpdate(taskId, 'working');
      logger.info(`📋 Task #${taskId} response was just an ack — marked WORKING, awaiting /speak callback`);
    } else {
      ledgerMarkCompleted(taskId, 'voice-streaming', fullText?.substring(0, 300));
      hudTaskUpdate(taskId, 'completed');
    }

    // Post completion to activity feed
    postActivity(`✅ **Task #${taskId}** complete (${duration}s)\n> ${truncate(fullText, 120)}`);
    
    // Update conversation history with full response
    const conv = conversations.get(userId);
    if (conv) {
      conv.history.push({ role: 'assistant', content: fullText });
      while (conv.history.length > CONVERSATION_HISTORY_MAX) conv.history.shift();
    }

    // Detect if response invites follow-up (extends conversation window)
    const followUp = detectFollowUpLikely(fullText);
    if (followUp) logger.info(`📋 Response invites follow-up — extending conversation window`);
    markBotResponse(userId, { followUpLikely: followUp });

    // ── Two-tier auto-sleep: sign-off phrase was embedded in a task request ──
    // The task is done, now transition to SLEEP as the user intended.
    // No farewell — the task response itself was the last thing spoken.
    const taskMeta = activeTasks.get(taskId);
    if (brainOptions.autoSleepAfterTask || taskMeta?.autoSleepAfterTask) {
      logger.info(`Auto-sleep: task #${taskId} complete with sign-off — transitioning to SLEEP`);
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
      markFailed(taskId, err.message);  // Ledger: task failed
      hudTaskUpdate(taskId, 'failed');
      logger.error(`❌ Task #${taskId} failed:`, err.message);
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
    logger.info(`🛑 Cancelled task #${taskId}`);
  }
  activeTasks.clear();
  audioQueue.clear();
  isSpeaking = false;
  serverMuteOwner(false);
  logger.info(`🛑 Cancelled ${count} active tasks, cleared all queues`);
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
    if (mute) logger.info('🔇 Server-muted owner (Jarvis speaking)');
    else logger.info('🔊 Server-unmuted owner (Jarvis done)');
  } catch (err) {
    // Non-fatal -- bot may lack permission
    logger.warn(`Server mute ${mute ? 'on' : 'off'} failed: ${err.message}`);
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
    logger.info(`BT: padded ${durationMs}ms silence (${silenceBytes} bytes) to ${audioPath}`);
    return paddedPath;
  } catch (err) {
    logger.warn(`BT silence pad failed: ${err.message}`);
    return audioPath;
  }
}

// ── Audio Playback ───────────────────────────────────────────────────
// playAudioEnhanced wraps the base speechPlayAudio from speech-output.js with
// Bluetooth silence padding and server-mute logic needed by the voice bot.

async function playAudioEnhanced(audioPath) {
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
  // WAV at 24000 Hz, 16-bit mono = 48000 bytes/sec (Chatterbox TTS native format).
  // Previous formula used 22050 Hz (44100 bytes/sec) — off by 8.5%; corrected to 24000 Hz.
  const isWav = audioPath.endsWith('.wav');
  const bytesPerSec = isWav ? 48000 : 16000; // WAV 24000Hz mono 16-bit (Chatterbox) : MP3 ~128kbps
  const estimatedDurationMs = Math.max(1500, (fileStat.size / bytesPerSec) * 1000);

  const resource = createAudioResource(crs(audioPath));
  player.play(resource);

  return new Promise((resolve) => {
    let resolved = false;
    let onIdle, onError, timeoutId, checkInterval;

    // finish() is idempotent (resolved guard) and called by ALL exit paths:
    //   onIdle (normal completion), onError (player error),
    //   timeoutId (safety cap), checkInterval (poll fallback).
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

// ── Global Error Handlers ─────────────────────────────────────────────

process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ Unhandled Promise Rejection:');
  logger.error('Promise:', promise);
  logger.error('Reason:', reason instanceof Error ? reason.stack : reason);
  logger.error('⚠️  Attempting graceful degradation — bot remains running');
});

process.on('uncaughtException', (err) => {
  logger.error('❌ Uncaught Exception:');
  logger.error(err.stack || err);
  logger.error('⚠️  Attempting graceful shutdown...');
  try {
    cancelAllTasks();
    if (currentConnection) currentConnection.destroy();
    client.destroy();
  } catch (cleanupErr) {
    logger.error('❌ Cleanup error during uncaughtException handler:', cleanupErr);
  }
  setTimeout(() => process.exit(1), 1000);
});

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

const REQUIRED_ENV = [
  'DISCORD_TOKEN',
  'DISCORD_GUILD_ID',
  'CLAWDBOT_GATEWAY_URL',
  'SPEAKER_VERIFY_URL',
];
const missing = REQUIRED_ENV.filter(v => !process.env[v]);
if (missing.length > 0) {
  logger.error(`[startup] Missing required env vars: ${missing.join(', ')}`);
  logger.error('[startup] See .env.example for reference. Exiting.');
  process.exit(1);
}

// STT provider health check — warns if local provider unreachable, never exits
checkSttHealth().catch(() => {});

client.login(process.env.DISCORD_TOKEN);
