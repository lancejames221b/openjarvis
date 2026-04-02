/**
 * Alert Webhook - HTTP server for external alerts, voice delivery & smart reminders
 * 
 * POST /alert   — Queue alert for voice briefing (on join or next pause)
 * POST /speak   — Immediate TTS delivery if user is in voice (for cron results, etc.)
 * POST /remind  — Smart reminder with multi-tier escalation
 * GET  /health  — Process health + component status
 * 
 * Receives alerts from monitoring systems, cron jobs, and sub-agents.
 */

import express from 'express';
import { queueAlert, getPendingAlerts, clearAlerts } from './alert-queue.js';
import { markCompleted, getActiveTasks, getLedgerStats } from './task-ledger.js';
import { hudTaskUpdate } from './hud.js';
import { setActiveAlert } from './alert-context.js';
import { getState, transition, canDeliverVoiceAlert, classifyAlertPriority } from './bot-state.js';
import { setFocusById } from './focus-state.js';
import logger from './logger.js';

const app = express();
app.use(express.json({ limit: '50kb' })); // Larger limit for cron results

const WEBHOOK_PORT = process.env.ALERT_WEBHOOK_PORT || 3335;
const WEBHOOK_TOKEN = process.env.ALERT_WEBHOOK_TOKEN || 'change-me';
const ALERTS_ALSO_POST_TEXT = process.env.ALERTS_ALSO_POST_TEXT !== 'false'; // Mirror all alerts and voice results to text channel

const ESCALATION_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour before escalation
const ESCALATION_CHECK_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

// ── Smart Reminder Escalation ────────────────────────────────────────
// Tiers: 0=voice (immediate), 1=text (1min), 2=DM (15min), 3=clawdbot gateway (30min)
const REMINDER_ESCALATION_TIERS = [
  { name: 'voice',    delayMs: 0 },
  { name: 'text',     delayMs: 60 * 1000 },        // 1 minute
  { name: 'dm',       delayMs: 15 * 60 * 1000 },   // 15 minutes
  { name: 'gateway',  delayMs: 30 * 60 * 1000 },   // 30 minutes
];
const REMINDER_CHECK_INTERVAL_MS = 60 * 1000; // Check every 60s
const pendingReminders = new Map(); // id -> reminder state
let reminderIdCounter = 0;
let reminderCheckInterval = null;

let client = null; // Will be set by main bot
let GUILD_ID = null;
let ALLOWED_USERS = [];
let currentVoiceChannelId = null;
let briefOnPauseCallback = null; // Callback to trigger briefing on next pause
let speakCallback = null; // Callback for immediate TTS delivery
let markBotResponseCallback = null; // Callback to refresh conversation window after speaking
let postActivityCallback = null; // Callback for activity feed
let postToTextCallback = null; // Callback for posting to text channel
let postToThreadCallback = null; // Callback for posting task-progress / background-agent results to #hud as threads
let personaSwitchCallback = null; // Callback for runtime persona switch (set by index.js)
let personaCreateCallback = null; // Callback for runtime persona creation (set by index.js)
let escalationInterval = null; // Periodic stale alert check

// ── Health Monitoring State (populated by index.js) ──────────────────
let healthState = {
  startedAt: Date.now(),
  lastSuccessfulInteraction: null,
  gatewayHealthy: false,
  ttsHealth: 'unknown',
  sttHealth: 'unknown',
  activeTaskCount: 0,
  reconnectAttempts: 0,
};

export function updateHealthState(updates) {
  Object.assign(healthState, updates);
}

export function initAlertWebhook(discordClient, guildId, allowedUsers, briefCallback) {
  client = discordClient;
  GUILD_ID = guildId;
  ALLOWED_USERS = allowedUsers;
  briefOnPauseCallback = briefCallback;
  
  // Start periodic escalation check for stale alerts
  if (escalationInterval) clearInterval(escalationInterval);
  escalationInterval = setInterval(checkStaleAlerts, ESCALATION_CHECK_INTERVAL_MS);
  logger.info('🔔 Alert escalation check enabled (1hr threshold, 5min interval)');
  
  // Start periodic reminder escalation check
  if (reminderCheckInterval) clearInterval(reminderCheckInterval);
  reminderCheckInterval = setInterval(checkReminderEscalation, REMINDER_CHECK_INTERVAL_MS);
  logger.info('⏰ Reminder escalation check enabled (60s interval)');
}

/**
 * Check for queued alerts older than ESCALATION_THRESHOLD_MS.
 * If found and user is not in voice, escalate to Discord text channel.
 */
async function checkStaleAlerts() {
  const alerts = getPendingAlerts();
  if (alerts.length === 0) return;
  
  const now = Date.now();
  const staleAlerts = alerts.filter(a => now - a.timestamp >= ESCALATION_THRESHOLD_MS);
  
  if (staleAlerts.length === 0) return;
  
  // Only escalate if user is NOT in voice (if in voice, they'll get briefed on pause)
  const userInVoice = isUserInVoice(ALLOWED_USERS[0]);
  if (userInVoice) return;
  
  // Escalate to text channel
  const TEXT_CHANNEL_ID = process.env.DISCORD_TEXT_CHANNEL_ID;
  if (!client || !TEXT_CHANNEL_ID) return;
  
  try {
    const channel = client.channels.cache.get(TEXT_CHANNEL_ID);
    if (!channel) return;
    
    for (const alert of staleAlerts) {
      const ageMin = Math.round((now - alert.timestamp) / 60_000);
      const escalationMsg = `📢 **Missed voice alert** (${ageMin}m ago): ${alert.message}`;
      await channel.send(escalationMsg);
      logger.info(`📢 Escalated stale alert to text: "${alert.message.substring(0, 60)}..." (${ageMin}m old)`);
    }
    
    // Clear the escalated alerts so they don't re-escalate
    clearAlerts();
  } catch (err) {
    logger.error(`❌ Alert escalation failed: ${err.message}`);
  }
}

// ── Smart Reminder Escalation Logic ──────────────────────────────────

/**
 * Check all pending reminders and escalate as needed
 */
async function checkReminderEscalation() {
  const now = Date.now();
  
  for (const [id, reminder] of pendingReminders) {
    // Skip acknowledged or expired reminders
    if (reminder.acknowledgedAt) {
      pendingReminders.delete(id);
      continue;
    }
    
    // Skip reminders that haven't fired yet
    if (reminder.fireTime > now) continue;
    
    const elapsed = now - reminder.fireTime;
    
    // Determine which tier we should be at based on elapsed time
    let targetTier = 0;
    for (let i = REMINDER_ESCALATION_TIERS.length - 1; i >= 0; i--) {
      if (elapsed >= REMINDER_ESCALATION_TIERS[i].delayMs) {
        targetTier = i;
        break;
      }
    }
    
    // If we already attempted this tier, skip
    if (targetTier <= reminder.tier && reminder.attempts.length > 0) continue;
    
    // Escalate to the target tier
    reminder.tier = targetTier;
    await executeReminderTier(id, reminder);
  }
}

/**
 * Execute delivery for a reminder at its current tier
 */
async function executeReminderTier(id, reminder) {
  const tier = REMINDER_ESCALATION_TIERS[reminder.tier];
  const now = Date.now();
  
  logger.info(`⏰ Reminder #${id} escalating to tier ${reminder.tier} (${tier.name}): "${reminder.message.substring(0, 60)}..."`);
  
  reminder.attempts.push({ tier: reminder.tier, tierName: tier.name, timestamp: now });
  
  try {
    switch (tier.name) {
      case 'voice': {
        // Tier 0: TTS if user is in voice channel
        const userInVoice = isUserInVoice(ALLOWED_USERS[0]);
        if (userInVoice && speakCallback) {
          speakCallback(`Reminder: ${reminder.message}`);
          reminder.delivered = true;
          logger.info(`🔊 Reminder #${id} delivered via voice`);
        } else {
          logger.info(`⏭️  Reminder #${id}: user not in voice, will escalate to text`);
        }
        break;
      }
      
      case 'text': {
        // Tier 1: Post to text channel
        const TEXT_CHANNEL_ID = process.env.DISCORD_TEXT_CHANNEL_ID;
        if (client && TEXT_CHANNEL_ID) {
          const channel = client.channels.cache.get(TEXT_CHANNEL_ID);
          if (channel) {
            await channel.send(`⏰ **Reminder**: ${reminder.message}`);
            reminder.delivered = true;
            logger.info(`📝 Reminder #${id} delivered via text channel`);
          }
        }
        break;
      }
      
      case 'dm': {
        // Tier 2: DM the user
        if (client && ALLOWED_USERS[0]) {
          try {
            const user = await client.users.fetch(ALLOWED_USERS[0]);
            await user.send(`⏰ **Reminder** (unacknowledged for ${Math.round((now - reminder.fireTime) / 60_000)}m): ${reminder.message}`);
            reminder.delivered = true;
            logger.info(`📱 Reminder #${id} delivered via DM`);
          } catch (err) {
            logger.error(`❌ Reminder #${id} DM failed: ${err.message}`);
          }
        }
        break;
      }
      
      case 'gateway': {
        // Tier 3: Send through Clawdbot gateway to reach whatever channel the owner is active on
        try {
          const GATEWAY_URL = process.env.CLAWDBOT_GATEWAY_URL || 'http://127.0.0.1:22100';
          const GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN;
          
          const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${GATEWAY_TOKEN}`,
              'x-openclaw-scopes': 'operator.write',
            },
            body: JSON.stringify({
              messages: [
                {
                  role: 'system',
                  content: 'You are delivering an urgent reminder to the user. This reminder has gone unacknowledged for 30+ minutes across voice, text, and DM. Deliver it clearly and concisely.',
                },
                {
                  role: 'user',
                  content: `URGENT REMINDER (unacknowledged for ${Math.round((now - reminder.fireTime) / 60_000)} minutes): ${reminder.message}`,
                },
              ],
              max_tokens: 200,
              user: 'jarvis-voice-reminder-escalation',
            }),
            signal: AbortSignal.timeout(15_000),
          });
          
          if (res.ok) {
            reminder.delivered = true;
            logger.info(`🌐 Reminder #${id} delivered via Clawdbot gateway`);
          } else {
            logger.error(`❌ Reminder #${id} gateway delivery failed: ${res.status}`);
          }
        } catch (err) {
          logger.error(`❌ Reminder #${id} gateway delivery failed: ${err.message}`);
        }
        break;
      }
    }
    
    // If we've exhausted all tiers, mark as done to prevent infinite loops
    if (reminder.tier >= REMINDER_ESCALATION_TIERS.length - 1) {
      logger.info(`✅ Reminder #${id} exhausted all escalation tiers`);
      // Keep in map for acknowledgment tracking but don't escalate further
    }
    
  } catch (err) {
    logger.error(`❌ Reminder #${id} tier ${tier.name} execution error: ${err.message}`);
  }
}

/**
 * Acknowledge a reminder by ID (stops further escalation)
 */
export function acknowledgeReminder(id) {
  const reminder = pendingReminders.get(id);
  if (reminder) {
    reminder.acknowledgedAt = Date.now();
    logger.info(`✅ Reminder #${id} acknowledged`);
    pendingReminders.delete(id);
    return true;
  }
  return false;
}

/**
 * Get all pending reminders
 */
export function getPendingReminders() {
  return [...pendingReminders.entries()].map(([id, r]) => ({ id, ...r }));
}

export function setSpeakCallback(cb) {
  speakCallback = cb;
}

export function setMarkBotResponseCallback(cb) {
  markBotResponseCallback = cb;
}

export function setPostActivityCallback(cb) {
  postActivityCallback = cb;
}

export function setPostToTextCallback(cb) {
  postToTextCallback = cb;
}

// Register a callback that posts task-progress / background-agent results to #hud as a thread.
// Signature: (transcript, fullText, intentCategory, taskId) => void
export function setPostToThreadCallback(cb) {
  postToThreadCallback = cb;
}

export function setCurrentVoiceChannelId(channelId) {
  currentVoiceChannelId = channelId;
}

export function setPersonaSwitchCallback(cb) {
  personaSwitchCallback = cb;
}

export function setPersonaCreateCallback(cb) {
  personaCreateCallback = cb;
}

app.post('/alert', async (req, res) => {
  // Verify token
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { message, priority, fullDetails, source, priorityLevel: explicitLevel } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message required' });
  }

  const numericPriority = explicitLevel || classifyAlertPriority({ message, priority, source });

  const alert = {
    message,
    priority: priority || 'normal',
    priorityLevel: numericPriority,
    fullDetails: fullDetails || null,
    source: source || 'external',
  };

  queueAlert(alert);

  const userInVoice = isUserInVoice(ALLOWED_USERS[0]);
  const shouldVoice = canDeliverVoiceAlert(numericPriority);

  // Always mirror alerts to text channel when flag is on
  if (ALERTS_ALSO_POST_TEXT && postToTextCallback) {
    const badge = ['', 'P1 CRITICAL', 'P2 URGENT', 'P3', 'P4', 'P5'][numericPriority] || 'P3';
    const src = alert.source ? ` (${alert.source})` : '';
    postToTextCallback(`[${badge}] Alert${src}: ${alert.message}`);
  }

  if (!userInVoice) {
    // Not in voice -- P1/P2 get DM notification
    if (numericPriority <= 2) await sendTextNotification(alert);
  } else if (shouldVoice && speakCallback) {
    const currentState = getState();
    logger.info(`[P${numericPriority}] Alert in ${currentState}: "${message.substring(0, 60)}"`);

    if (currentState === 'SLEEP' || currentState === 'IDLE') {
      transition('ALERT', `p${numericPriority}-alert`);
      const prefix = numericPriority === 1 ? 'Sir, I need your attention. ' : 'Apologies for the interruption. ';
      speakCallback(prefix + message);
      // Return to previous state after delivery
      setTimeout(() => {
        if (getState() === 'ALERT') transition(currentState, 'alert-delivered');
      }, 5000);
    } else {
      speakCallback(message);
    }
  } else {
    // Low-priority or can't deliver voice -- queue for next pause
    if (briefOnPauseCallback) {
      briefOnPauseCallback(ALLOWED_USERS[0]);
    }
  }

  res.json({ ok: true, queued: true, userInVoice, priorityLevel: numericPriority, state: getState() });
});

/**
 * POST /speak — Immediate TTS delivery
 * 
 * If user is in voice: speaks the message immediately via TTS
 * If user is not in voice: posts to text channel + queues as alert
 * 
 * Body: { message: string, source?: string, textChannel?: string }
 */
// Content dedup imported from index.js (shared across both callback paths)
let _isDuplicateContentFn = null;
export function setDedupCallback(fn) { _isDuplicateContentFn = fn; }

let _didTaskSpeakInlineFn = null;
export function setDidTaskSpeakInlineCallback(fn) { _didTaskSpeakInlineFn = fn; }

// ── Semantic /speak dedup ─────────────────────────────────────────────
// Tracks recently spoken texts to suppress near-duplicate /speak callbacks
// even when phrased differently. "Signal is open, sir." vs "I've opened Signal, sir."
// are different hashes but same intent — word-overlap catches them.
const _recentSpokenTexts = []; // [{text, ts, source}]
const SEMANTIC_DEDUP_WINDOW_MS = 90_000; // 90s
const SEMANTIC_DEDUP_OVERLAP_THRESHOLD = parseFloat(process.env.SEMANTIC_DEDUP_THRESHOLD || '0.72'); // 72% word overlap required — raised from 0.45 to avoid suppressing valid /speak callbacks
const SEMANTIC_DEDUP_RECENCY_MS = 30_000; // Only suppress if prior speak was within 30s

function _wordSet(text) {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
}

function _wordOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) { if (b.has(w)) shared++; }
  return shared / Math.max(a.size, b.size);
}

/**
 * Detect if a /speak message is about opening something on screen.
 * Matches: "on your screen", "opened X", "pulling up", "it's open", etc.
 */
function _isScreenOpenMessage(msg) {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  const patterns = [
    'on your screen',
    'on your mac',
    'on your desktop',
    'opened ',
    'opening ',
    'pulling up',
    'pulled up',
    'it\'s open',
    'is open',
    'brought up',
    'bringing up',
  ];
  return patterns.some(p => lower.includes(p));
}

function _isSemanticDuplicate(message, incomingTaskId = null) {
  const now = Date.now();
  const incoming = _wordSet(message);
  // Prune old entries outside the full dedup window
  while (_recentSpokenTexts.length > 0 && now - _recentSpokenTexts[0].ts > SEMANTIC_DEDUP_WINDOW_MS) {
    _recentSpokenTexts.shift();
  }
  for (const entry of _recentSpokenTexts) {
    // Only suppress if prior speak was within 30s (recency gate)
    if (now - entry.ts > SEMANTIC_DEDUP_RECENCY_MS) continue;
    // If both have a taskId, they must match (don't suppress cross-task results)
    if (incomingTaskId && entry.taskId && incomingTaskId !== entry.taskId) continue;
    const overlap = _wordOverlap(incoming, entry.words);
    if (overlap >= SEMANTIC_DEDUP_OVERLAP_THRESHOLD) {
      logger.info(`🔇 Semantic /speak dedup: ${(overlap*100).toFixed(0)}% overlap with recent "${entry.text.substring(0,40)}" (task=${entry.taskId || 'n/a'}, age=${now - entry.ts}ms)`);
      return true;
    }
  }
  return false;
}

function _recordSpoken(message, source, taskId = null) {
  _recentSpokenTexts.push({ text: message, words: _wordSet(message), ts: Date.now(), source, taskId });
  if (_recentSpokenTexts.length > 10) _recentSpokenTexts.shift(); // cap at 10
}

/**
 * Record content spoken via the inline TTS pipeline (not /speak endpoint)
 * so that the /speak semantic dedup can suppress near-duplicate task-progress.
 * Call this from the streaming TTS path in index.js.
 */
export function recordInlineSpoken(message) {
  _recordSpoken(message, 'inline');
}

// ── /speak in-flight mutex: prevents race-condition double-speak ─────
// Two simultaneous HTTP requests for identical content can both pass the
// hash dedup if body parsing completes in the same event-loop tick before
// either handler records the hash. This 200ms window closes that gap.
const _inFlightSpeaks = new Map(); // normalizedKey -> timestamp
const IN_FLIGHT_TTL_MS = 200;

function _isInFlight(message) {
  const key = message.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80);
  const now = Date.now();
  const last = _inFlightSpeaks.get(key);
  if (last && now - last < IN_FLIGHT_TTL_MS) return true;
  _inFlightSpeaks.set(key, now);
  if (_inFlightSpeaks.size > 50) {
    for (const [k, t] of _inFlightSpeaks) {
      if (now - t > IN_FLIGHT_TTL_MS * 5) _inFlightSpeaks.delete(k);
    }
  }
  return false;
}

app.post('/speak', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { message, source, textChannel, taskId } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'message required' });
  }
  
  // ── In-flight race dedup (200ms window) — catches simultaneous identical requests ──
  if (_isInFlight(message)) {
    logger.info(`⏭️  /speak in-flight dedup: skipping race duplicate (${message.substring(0, 40)}...)`);
    return res.json({ ok: true, delivered: 'inflight-dedup-skip' });
  }

  // ── Cross-path content deduplication (exact hash) ──
  if (_isDuplicateContentFn && _isDuplicateContentFn(message)) {
    logger.info(`⏭️  /speak dedup: skipping duplicate content (${message.substring(0, 40)}...)`);
    return res.json({ ok: true, delivered: 'dedup-skip' });
  }

  // ── Semantic near-duplicate dedup ──
  // Catches "Signal is open, sir." vs "I've opened Signal on your Mac, sir." as duplicates.
  // Only applies to task-result sources, not reminders/alerts (those are always intentional).
  const isSemDedup = ['task-progress', 'task-complete', 'background-agent'].includes(source);
  if (isSemDedup && _isSemanticDuplicate(message, taskId || null)) {
    if (postActivityCallback) {
      postActivityCallback(`⏭️ **Semantic dedup** (${source}): ${message.substring(0, 200)}`);
    }
    return res.json({ ok: true, delivered: 'semantic-dedup-skip' });
  }

  // ── Alert context injection — store so next voice turn knows what this was about ──
  setActiveAlert(message);
  
  // Track task completion via /speak callback
  if (source === 'task-complete' || source === 'background-agent') {
    // If taskId provided, mark that specific task. Otherwise mark most recent active task.
    if (taskId) {
      markCompleted(taskId, 'speak-endpoint', message.substring(0, 200));
      hudTaskUpdate(taskId, 'completed');
      logger.info(`📋 Task #${taskId} completed via /speak callback`);
    } else {
      // Find most recent active task and mark it
      const active = getActiveTasks();
      if (active.length > 0) {
        const mostRecent = active[active.length - 1];
        markCompleted(mostRecent.taskId, 'speak-endpoint', message.substring(0, 200));
        hudTaskUpdate(mostRecent.taskId, 'completed');
        logger.info(`📋 Task #${mostRecent.taskId} completed via /speak callback (auto-matched)`);
      }
    }
  }
  
  const userInVoice = isUserInVoice(ALLOWED_USERS[0]);
  
  // Post to activity feed
  if (postActivityCallback) {
    postActivityCallback(`🔔 **${source || 'Cron'}**: ${message.substring(0, 200)}`);
  }
  
  // ── ON_SCREEN mode: suppress voice for screen-open actions ──
  const onScreenMode = process.env.ON_SCREEN || 'no_ack';
  // Declared here (before first use) to avoid TDZ crash in on-screen suppression block below
  const isSubAgentResult = source === 'task-progress' || source === 'background-agent' || source === 'task-complete';
  const isScreenAction = _isScreenOpenMessage(message);
  if (isScreenAction && (onScreenMode === 'no_ack' || onScreenMode === 'ack_pre')) {
    // no_ack: total silence. ack_pre: already acked before, nothing after.
    logger.info(`🔇 /speak ON_SCREEN=${onScreenMode} — suppressing voice for screen action`);
    if (postToTextCallback) {
      postToTextCallback(`📝 *(voiced)* ${source}: ${message.substring(0, 300)}`);
    }
    if (isSubAgentResult && postToThreadCallback) {
      postToThreadCallback(taskId, source, message);
    }
    return res.json({ ok: true, delivered: 'on-screen-suppressed' });
  }

  // ── Suppress redundant task-progress voice ──
  // If the task already spoke its result inline (streaming TTS pipeline),
  // don't speak the /speak callback — post to text only. Prevents double-speaking
  // on quick commands like "open X on my Mac" where both paths fire.
  const isTaskProgress = source === 'task-progress';
  const taskAlreadySpoke = isTaskProgress && _didTaskSpeakInlineFn && _didTaskSpeakInlineFn(taskId);
  if (taskAlreadySpoke) {
    logger.info(`🔇 /speak task-progress suppressed — task #${taskId} already spoke inline`);
    if (postToTextCallback) {
      postToTextCallback(`📝 *(text-only, task spoke inline)* ${message.substring(0, 300)}`);
    }
    return res.json({ ok: true, delivered: 'text-only-task-spoke-inline' });
  }

  // ── Sub-agent result routing ─────────────────────────────────────────
  // task-progress and background-agent results get posted to #hud as threads.
  // This is the /speak callback from a spawned sub-agent finishing its work.
  // (isSubAgentResult declared above the on-screen block to avoid TDZ)
  if (isSubAgentResult && postToThreadCallback) {
    logger.info(`📤 Routing sub-agent result (${source}) to #hud thread (task #${taskId})`);
    postToThreadCallback(taskId, source, message);
    if (userInVoice && speakCallback) {
      // Speak a brief summary (truncated) — full result is in the thread
      speakCallback(message);
      _recordSpoken(message, source, taskId || null);
      if (markBotResponseCallback) markBotResponseCallback(ALLOWED_USERS[0], { followUpLikely: true });
    }
    return res.json({ ok: true, delivered: 'thread+voice', userInVoice });
  }

  if (userInVoice && speakCallback) {
    // Speak immediately via TTS — voice is primary delivery
    logger.info(`🗣️  Speaking (${source || 'cron'}): "${message.substring(0, 60)}..."`);
    speakCallback(message);
    // Record in semantic dedup window so near-duplicate /speak callbacks are suppressed
    _recordSpoken(message, source || 'cron', taskId || null);
    // Refresh conversation window so follow-ups don't need wake word
    if (markBotResponseCallback) {
      markBotResponseCallback(ALLOWED_USERS[0], { followUpLikely: true });
    }
    // When voice is active, text is just a quiet log (no @ping, no bold notification)
    if (ALERTS_ALSO_POST_TEXT && postToTextCallback) {
      postToTextCallback(`📝 *(voiced)* ${source || 'result'}: ${message.substring(0, 300)}`);
    }
    res.json({ ok: true, delivered: 'voice', userInVoice: true });
  } else {
    // Not in voice — loud text notification + queue for next join
    logger.info(`📝 User not in voice — posting text + queueing (${source || 'cron'})`);
    if (ALERTS_ALSO_POST_TEXT && postToTextCallback) {
      const sourceBadge = source ? `**${source}**` : '**Voice Result**';
      postToTextCallback(`🗣️ ${sourceBadge}: ${message}`);
    }
    queueAlert({
      message: message.substring(0, 200),
      fullDetails: message,
      priority: 'normal',
      source: source || 'cron',
    });
    if (!ALERTS_ALSO_POST_TEXT) {
      // Only send DM/text notification if we didn't already post to text channel above
      await sendTextNotification({
        message,
        priority: 'normal',
        source: source || 'cron',
      });
    }
    res.json({ ok: true, delivered: ALERTS_ALSO_POST_TEXT ? 'text+queued' : 'dm+queued', userInVoice: false });
  }
});

/**
 * POST /handoff — Queue context for voice pickup
 * 
 * When user says "hand off to voice" in a text channel, the agent
 * posts the channel context here. Next time user joins voice,
 * Jarvis briefs them on the handoff.
 * 
 * Body: { channel: string, topic: string, summary: string, source?: string }
 */
const pendingHandoffs = [];
const MAX_HANDOFFS = 10;

// ── Active Context Registry (Cross-System Handoffs) ─────────────────
// Tracks the current active context across voice/Discord/WhatsApp
// When user hands off from a channel to voice, this stores the context
// so voice can brief them immediately on join and route output back

const activeContext = {
  topic: null,
  surface: null,      // discord/whatsapp/voice
  channelId: null,
  threadId: null,
  summary: null,
  lastUpdated: null,
  ttl: 7200000        // 2 hours
};

function isContextExpired() {
  if (!activeContext.lastUpdated) return true;
  return (Date.now() - activeContext.lastUpdated) > activeContext.ttl;
}

function clearActiveContext() {
  activeContext.topic = null;
  activeContext.surface = null;
  activeContext.channelId = null;
  activeContext.threadId = null;
  activeContext.summary = null;
  activeContext.lastUpdated = null;
}

/**
 * POST /stop — Stop current TTS playback (CV2 button callback)
 */
app.post('/stop', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  try {
    // Import and stop speech output if available
    const { stopSpeaking } = await import('./speech-output.js').catch(() => ({}));
    if (typeof stopSpeaking === 'function') {
      await stopSpeaking();
      logger.info('🛑 /stop: TTS halted via button');
      return res.json({ ok: true, action: 'stopped' });
    }
    // Fallback: just acknowledge
    logger.info('🛑 /stop: received (no stopSpeaking export available)');
    res.json({ ok: true, action: 'acknowledged' });
  } catch (err) {
    logger.error('/stop error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /sleep_mode — Programmatically toggle bot sleep state
 *
 * Body: { "action": "sleep" | "wake" | "status" }
 *
 * Responses:
 *   200  { ok: true, state: "SLEEP",  previous: "ACTIVE" }   — on sleep
 *   200  { ok: true, state: "ACTIVE", previous: "SLEEP"  }   — on wake
 *   200  { ok: true, state: <string> }                        — on status
 *   400  { ok: false, error: "invalid action" }
 *   401  Unauthorized
 *
 * Used by OpenClaw sub-agents and cron jobs to put Jarvis to sleep/wake
 * without relying on voice commands.
 */
app.post('/sleep_mode', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });

  const { action } = req.body || {};
  if (!action || !['sleep', 'wake', 'status'].includes(action)) {
    return res.status(400).json({ ok: false, error: 'invalid action — expected sleep, wake, or status' });
  }

  const previous = getState();

  if (action === 'status') {
    return res.json({ ok: true, state: previous });
  }

  if (action === 'sleep') {
    transition('SLEEP', 'api-request');
    logger.info(`😴 /sleep_mode: transitioned ${previous} → SLEEP via API`);
    return res.json({ ok: true, state: 'SLEEP', previous });
  }

  // action === 'wake'
  transition('ACTIVE', 'api-request');
  // Restart idle/sleep timers so bot auto-sleeps again if voice goes quiet
  try {
    const { resetIdleSleepTimer } = await import('./fsm.js').catch(() => ({}));
    if (typeof resetIdleSleepTimer === 'function') resetIdleSleepTimer();
  } catch (_) { /* non-fatal */ }
  logger.info(`⏰ /sleep_mode: transitioned ${previous} → ACTIVE via API`);
  return res.json({ ok: true, state: 'ACTIVE', previous });
});

/**
 * POST /persona — Hot-swap active persona at runtime
 * Body: { "name": "snoop" }
 */
app.post('/persona', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });

  const { name } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing name — expected { "name": "snoop" }' });
  }

  if (typeof personaSwitchCallback !== 'function') {
    return res.status(503).json({ ok: false, error: 'persona switch not available yet' });
  }

  try {
    const result = await personaSwitchCallback(name.toLowerCase().trim());
    logger.info(`🎭 /persona: switched to ${result.name}`);
    return res.json({ ok: true, persona: result.name, voice: result.voice, wakeWords: result.wakeWords });
  } catch (err) {
    logger.warn(`[/persona] switch error: ${err.message}`);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /persona/create — Create a new persona file at runtime
 * Body: { name, content, voice?, tts_voice_edge?, wake_words?, overwrite? }
 * - name: alphanumeric + hyphens/underscores, required
 * - content: personality prompt text, required
 * - voice: TTS voice profile (default: "jarvis")
 * - tts_voice_edge: Edge TTS voice string (optional)
 * - wake_words: array of wake word phrases (default: [name])
 * - overwrite: boolean (default false) — set true to replace existing persona
 */
app.post('/persona/create', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });

  const { name, content, voice, tts_voice_edge, wake_words, overwrite = false } = req.body || {};

  // Validate name
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing name' });
  }
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeName) {
    return res.status(400).json({ ok: false, error: 'invalid name — use alphanumeric, hyphens, underscores only' });
  }

  // Validate content
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ ok: false, error: 'missing content — personality prompt required' });
  }

  if (typeof personaCreateCallback !== 'function') {
    return res.status(503).json({ ok: false, error: 'persona create not available yet' });
  }

  // Build wake_words array
  const wakeWords = Array.isArray(wake_words) && wake_words.length > 0
    ? wake_words.map(w => String(w).trim()).filter(Boolean)
    : [safeName.toLowerCase()];

  try {
    const result = await personaCreateCallback({
      name: safeName,
      content: content.trim(),
      voice: voice || 'jarvis',
      ttsVoiceEdge: tts_voice_edge || null,
      wakeWords,
      overwrite,
    });
    logger.info(`🎭 /persona/create: created ${result.name}`);
    return res.json({ ok: true, persona: result });
  } catch (err) {
    const status = err.code === 'EEXIST' ? 409 : 500;
    logger.warn(`[/persona/create] error: ${err.message}`);
    return res.status(status).json({ ok: false, error: err.message });
  }
});

/**
 * GET /personas — List all available personas with active indicator
 */
app.get('/personas', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });

  if (typeof personaSwitchCallback !== 'function') {
    return res.status(503).json({ ok: false, error: 'persona system not available yet' });
  }

  try {
    const { listPersonalities, getActivePersona } = await import('./brain.js');
    const all = listPersonalities();
    const active = getActivePersona();
    return res.json({
      ok: true,
      active: active.name,
      personas: all.map(p => ({
        name: p,
        active: p.toLowerCase() === active.name.toLowerCase(),
      })),
    });
  } catch (err) {
    logger.warn(`[/personas] list error: ${err.message}`);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /replay — Replay last spoken TTS phrase (CV2 button callback)
 */
app.post('/replay', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { replayLast } = await import('./speech-output.js').catch(() => ({}));
    if (typeof replayLast === 'function') {
      await replayLast();
      logger.info('▶ /replay: replaying last phrase via button');
      return res.json({ ok: true, action: 'replaying' });
    }
    logger.info('▶ /replay: received (no replayLast export available)');
    res.json({ ok: true, action: 'acknowledged' });
  } catch (err) {
    logger.error('/replay error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /context/active — Read current active context
 * Returns the active handoff context if not expired, otherwise null
 */
app.get('/context/active', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (isContextExpired()) {
    clearActiveContext();
    return res.json({ ok: true, context: null, expired: true });
  }
  
  res.json({
    ok: true,
    context: {
      topic: activeContext.topic,
      surface: activeContext.surface,
      channelId: activeContext.channelId,
      threadId: activeContext.threadId,
      summary: activeContext.summary,
      lastUpdated: activeContext.lastUpdated,
      age: Date.now() - activeContext.lastUpdated,
    },
  });
});

/**
 * POST /context/active — Set current active context
 * Updates the active context with new handoff details
 */
app.post('/context/active', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { topic, surface, channelId, threadId, summary } = req.body;
  
  if (!surface || !summary) {
    return res.status(400).json({ error: 'surface and summary required' });
  }
  
  activeContext.topic = topic || null;
  activeContext.surface = surface;
  activeContext.channelId = channelId || null;
  activeContext.threadId = threadId || null;
  activeContext.summary = summary;
  activeContext.lastUpdated = Date.now();
  
  logger.info(`📋 Active context set: ${surface} ${channelId ? `#${channelId}` : ''} → "${topic || 'untitled'}"`);
  
  res.json({
    ok: true,
    context: {
      topic: activeContext.topic,
      surface: activeContext.surface,
      channelId: activeContext.channelId,
      threadId: activeContext.threadId,
      age: 0,
    },
  });
});

/**
 * DELETE /context/active — Clear active context
 */
app.delete('/context/active', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const hadContext = activeContext.topic !== null;
  const previousTopic = activeContext.topic;
  
  clearActiveContext();
  
  logger.info(`🗑️  Active context cleared${hadContext ? ` (was: "${previousTopic}")` : ''}`);
  
  res.json({ ok: true, cleared: hadContext });
});

app.post('/handoff', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { channel, topic, summary, instructions, source, channelId, threadId } = req.body;
  
  if (!summary) {
    return res.status(400).json({ error: 'summary required' });
  }
  
  const handoff = {
    channel: channel || 'unknown',
    channelId: channelId || null,
    threadId: threadId || null,
    topic: topic || '',
    summary,
    instructions: instructions || '',
    source: source || 'text-channel',
    timestamp: Date.now(),
  };
  
  // If handoff includes a threadId, set it as the active thread for /post
  // so voice output goes back to the same thread
  if (channelId && threadId) {
    activeThreads.set(channelId, { threadId, title: topic || channel || 'Voice Handoff', lastUsed: Date.now() });
    logger.info(`📌 Active thread set: #${channel} → thread ${threadId}`);
    // Pin session status in the thread
    await pinSessionStatus(threadId, topic || channel);
  } else if (channelId) {
    // Channel but no thread — set channel as active so /post creates a thread there
    activeThreads.set(channelId, { threadId: null, title: topic || channel || 'Voice Output', lastUsed: Date.now(), channelOnly: true });
    // Pin session status in the channel
    await pinSessionStatus(channelId, topic || channel);
  }
  
  // Deduplicate: skip if same channel+summary arrived in last 60s
  const isDupe = pendingHandoffs.some(h => 
    h.channel === handoff.channel && 
    h.summary === handoff.summary && 
    (Date.now() - h.timestamp) < 60000
  );
  if (isDupe) {
    logger.info(`⏭️ Duplicate handoff from #${handoff.channel} — skipping`);
    return res.json({ ok: true, queued: false, duplicate: true });
  }

  pendingHandoffs.push(handoff);
  while (pendingHandoffs.length > MAX_HANDOFFS) pendingHandoffs.shift();
  
  logger.info(`📋 Handoff queued from #${channel}: "${summary.substring(0, 60)}..."`);

  // Auto-focus voice on the handoff channel — voice bot now knows
  // what project/channel the user was working in before switching to voice
  if (channelId) {
    setFocusById(channelId, channel || null);
    logger.info(`🎯 Voice auto-focused on #${channel || channelId} via handoff`);
  }

  // Update active context
  activeContext.topic = topic || channel;
  activeContext.surface = source || 'text-channel';
  activeContext.channelId = channelId || null;
  activeContext.threadId = threadId || null;
  activeContext.summary = summary;
  activeContext.lastUpdated = Date.now();
  logger.info(`📋 Active context set from handoff: ${activeContext.surface} → voice`);
  
  // Post to activity feed
  if (postActivityCallback) {
    postActivityCallback(`📋 **Handoff queued** from #${channel}: ${summary.substring(0, 150)}`);
  }
  
  // Post to text channel
  if (ALERTS_ALSO_POST_TEXT && postToTextCallback) {
    postToTextCallback(`📋 **Voice handoff queued** from #${channel}\n> ${summary.substring(0, 300)}`);
  }
  
  // Inject handoff context into the gateway session so AI has full context
  try {
    const GATEWAY_URL = process.env.CLAWDBOT_GATEWAY_URL || 'http://127.0.0.1:22100';
    const GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN;
    const SESSION_USER = process.env.SESSION_USER || 'jarvis-voice-user';
    const threadInfo = threadId ? `\nThread ID: ${threadId} (in channel ${channelId})` : (channelId ? `\nChannel ID: ${channelId}` : '');
    const postBackInfo = threadId 
      ? `\n\nWhen posting output for this topic, use the /post endpoint with channelId="${channelId}" — it will automatically go to the active thread (${threadId}).`
      : (channelId ? `\n\nWhen posting output for this topic, use the /post endpoint with channelId="${channelId}".` : '');
    const contextMsg = `[VOICE HANDOFF from #${channel}]${topic ? `\nTopic: ${topic}` : ''}${threadInfo}\n\nContext:\n${summary}${instructions ? `\n\nInstructions: ${instructions}` : ''}${postBackInfo}\n\nThe user has handed off to voice to discuss this. Use this context for follow-up questions.`;
    
    await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: process.env.VOICE_MODEL || 'anthropic-console/claude-sonnet-4-6',
        messages: [{ role: 'user', content: contextMsg }],
        user: SESSION_USER,
        max_tokens: 50,
      }),
    });
    logger.info(`📋 Handoff context injected into gateway session`);
  } catch (err) {
    logger.error(`⚠️ Failed to inject handoff context: ${err.message}`);
  }

  const userInVoice = isUserInVoice(ALLOWED_USERS[0]);
  if (userInVoice && speakCallback) {
    // User already in voice — brief immediately
    const briefMsg = `Handoff from ${channel}. ${topic ? topic + '. ' : ''}${summary.substring(0, 200)}`;
    speakCallback(briefMsg);
  }
  
  res.json({ ok: true, queued: true, userInVoice, handoffCount: pendingHandoffs.length });
});

export function getPendingHandoffs() {
  return [...pendingHandoffs];
}

export function clearHandoffs() {
  const count = pendingHandoffs.length;
  pendingHandoffs.length = 0;
  return count;
}

export function hasPendingHandoffs() {
  return pendingHandoffs.length > 0;
}

/**
 * POST /remind — Smart reminder with multi-tier escalation
 * 
 * Body: { message: string, fireTime?: number (epoch ms), delayMs?: number, source?: string }
 * 
 * If fireTime is provided, reminder fires at that time.
 * If delayMs is provided, reminder fires after that delay from now.
 * If neither, fires immediately.
 * 
 * Escalation path: voice → text (1m) → DM (15m) → Clawdbot gateway (30m)
 */
app.post('/remind', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { message, fireTime, delayMs, source } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'message required' });
  }
  
  const now = Date.now();
  let computedFireTime;
  
  if (fireTime) {
    computedFireTime = fireTime;
  } else if (delayMs) {
    computedFireTime = now + delayMs;
  } else {
    computedFireTime = now; // Immediate
  }
  
  const id = ++reminderIdCounter;
  const reminder = {
    message,
    fireTime: computedFireTime,
    source: source || 'external',
    createdAt: now,
    delivered: false,
    tier: -1, // Will start at 0 on first check
    attempts: [],
    acknowledgedAt: null,
  };
  
  pendingReminders.set(id, reminder);
  
  // Also queue as alert so briefing system picks it up
  queueAlert({
    message: `⏰ Reminder: ${message}`,
    priority: 'normal',
    source: source || 'reminder',
    type: 'reminder',
    reminderId: id,
  });
  
  const firesIn = computedFireTime - now;
  const firesInStr = firesIn <= 0 ? 'now' : `in ${Math.round(firesIn / 1000)}s`;
  logger.info(`⏰ Reminder #${id} created: "${message.substring(0, 60)}..." fires ${firesInStr}`);
  
  // If firing immediately and user is in voice, try voice delivery right away
  if (firesIn <= 0) {
    const userInVoice = isUserInVoice(ALLOWED_USERS[0]);
    if (userInVoice && speakCallback) {
      speakCallback(`Reminder: ${message}`);
      reminder.delivered = true;
      reminder.tier = 0;
      reminder.attempts.push({ tier: 0, tierName: 'voice', timestamp: now });
    }
  }
  
  // Post to activity feed
  if (postActivityCallback) {
    postActivityCallback(`⏰ **Reminder #${id}** scheduled: ${message.substring(0, 150)} (fires ${firesInStr})`);
  }
  
  res.json({
    ok: true,
    reminderId: id,
    firesAt: computedFireTime,
    firesIn: firesInStr,
    escalationTiers: REMINDER_ESCALATION_TIERS.map(t => t.name),
  });
});

/**
 * POST /remind/:id/ack — Acknowledge a reminder
 */
app.post('/remind/:id/ack', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid reminder ID' });
  }
  
  const acked = acknowledgeReminder(id);
  if (acked) {
    res.json({ ok: true, acknowledged: true });
  } else {
    res.status(404).json({ error: 'Reminder not found or already acknowledged' });
  }
});

/**
 * GET /reminders — List pending reminders
 */
app.get('/reminders', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.json({
    ok: true,
    reminders: getPendingReminders(),
  });
});

app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  const uptime = Math.round((Date.now() - healthState.startedAt) / 1000);
  
  res.json({
    ok: true,
    service: 'jarvis-voice',
    uptime: `${uptime}s`,
    uptimeHuman: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    memory: {
      rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
      warning: mem.rss > 500 * 1024 * 1024 ? 'HIGH' : 'ok',
    },
    gateway: {
      healthy: healthState.gatewayHealthy,
    },
    tts: {
      status: healthState.ttsHealth,
    },
    stt: {
      status: healthState.sttHealth,
    },
    tasks: {
      active: healthState.activeTaskCount,
      ledger: getLedgerStats(),
    },
    voice: {
      reconnectAttempts: healthState.reconnectAttempts,
    },
    lastInteraction: healthState.lastSuccessfulInteraction
      ? new Date(healthState.lastSuccessfulInteraction).toISOString()
      : null,
    reminders: {
      pending: pendingReminders.size,
    },
    fsm: {
      state: getState(),
    },
  });
});

/**
 * POST /post — Post content to a Discord channel as a titled thread
 * 
 * Body: { channelId: string, title: string, content: string, source?: string, threadId?: string }
 * 
 * If threadId is provided, posts into that existing thread.
 * Otherwise creates a new thread. Returns threadId for reuse.
 * 
 * Active threads are tracked per channel — if no threadId is given but a thread
 * was recently created for that channel, it reuses it automatically.
 */
const activeThreads = new Map(); // channelId → { threadId, title, lastUsed }
const activePins = new Map(); // channelId → { messageId, threadId }

/**
 * Pin a voice session status message in a channel/thread
 */
async function pinSessionStatus(channelOrThreadId, topic, status = 'active') {
  try {
    const target = client.channels.cache.get(channelOrThreadId) || await client.channels.fetch(channelOrThreadId);
    if (!target) return null;
    
    const emoji = status === 'active' ? '🎙️' : '🔇';
    const statusText = status === 'active' 
      ? `${emoji} **Voice Session Active**\nTopic: ${topic || 'General'}\n_Jarvis is listening in voice. Output will be posted here._`
      : `${emoji} **Voice Session Ended**\nTopic: ${topic || 'General'}\n_Session closed at ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET_`;
    
    // Check if we already have a pinned status for this channel
    const existing = activePins.get(channelOrThreadId);
    if (existing) {
      try {
        const oldMsg = await target.messages.fetch(existing.messageId);
        await oldMsg.unpin().catch(() => {});
        await oldMsg.edit(statusText).catch(() => {});
        if (status === 'active') {
          await oldMsg.pin().catch(() => {});
          return existing.messageId;
        }
        activePins.delete(channelOrThreadId);
        return null;
      } catch { /* old message gone, create new */ }
    }
    
    if (status !== 'active') return null; // Don't create new pins for 'ended'
    
    const msg = await target.send(statusText);
    await msg.pin().catch((e) => logger.error(`⚠️ Pin failed: ${e.message}`));
    activePins.set(channelOrThreadId, { messageId: msg.id, topic });
    logger.info(`📌 Pinned voice session status in ${target.name || channelOrThreadId}`);
    return msg.id;
  } catch (err) {
    logger.error(`⚠️ Failed to pin session status: ${err.message}`);
    return null;
  }
}

/**
 * Unpin/end all active session pins (called on voice disconnect)
 */
async function endAllSessionPins() {
  for (const [chId, pin] of activePins) {
    await pinSessionStatus(chId, pin.topic, 'ended');
  }
  activePins.clear();
}

export { endAllSessionPins };

app.post('/post', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { channelId, title, content, source, threadId: requestedThreadId, newThread } = req.body;
  
  if (!channelId || !content) {
    return res.status(400).json({ error: 'channelId and content required' });
  }
  
  try {
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
      return res.status(404).json({ error: `Channel ${channelId} not found` });
    }
    
    const threadTitle = title || 'Voice Output';
    const sourceBadge = source ? ` (via ${source})` : ' (via voice)';
    
    // Determine which thread to use
    let thread = null;
    let isNew = false;
    
    // 1. Explicit threadId from request
    if (requestedThreadId && !newThread) {
      try {
        thread = await client.channels.fetch(requestedThreadId);
      } catch { /* thread gone, will create new */ }
    }
    
    // 2. Reuse active thread for this channel (unless newThread requested)
    if (!thread && !newThread) {
      const active = activeThreads.get(channelId);
      if (active && (Date.now() - active.lastUsed) < 3600000) { // 1 hour TTL
        if (active.threadId && !active.channelOnly) {
          try {
            thread = await client.channels.fetch(active.threadId);
          } catch { 
            activeThreads.delete(channelId); 
          }
        }
        // If channelOnly, fall through to create a new thread in that channel
      }
    }
    
    // 3. Create new thread
    if (!thread) {
      const headerMsg = await channel.send(`🎙️ **${threadTitle}**${sourceBadge}`);
      thread = await headerMsg.startThread({
        name: threadTitle.substring(0, 100),
        autoArchiveDuration: 1440,
      });
      isNew = true;
    }
    
    // Track as active thread for this channel
    activeThreads.set(channelId, { threadId: thread.id, title: threadTitle, lastUsed: Date.now() });
    
    // Post content — split if over 2000 chars
    const chunks = [];
    for (let i = 0; i < content.length; i += 1990) {
      chunks.push(content.substring(i, i + 1990));
    }
    for (const chunk of chunks) {
      await thread.send(chunk);
    }
    
    logger.info(`📤 ${isNew ? 'Created' : 'Reused'} thread "${threadTitle}" in #${channel.name} (${chunks.length} chunks)`);
    
    res.json({ ok: true, channelId, threadId: thread.id, title: threadTitle, reused: !isNew });
  } catch (err) {
    logger.error(`❌ Failed to post thread: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Get active handoff context (so voice session knows where to post)
app.get('/handoff/active', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const threads = {};
  for (const [chId, info] of activeThreads) {
    threads[chId] = { ...info };
  }
  
  const recent = pendingHandoffs.length > 0 ? pendingHandoffs[pendingHandoffs.length - 1] : null;
  
  res.json({
    ok: true,
    activeThreads: threads,
    lastHandoff: recent ? {
      channel: recent.channel,
      channelId: recent.channelId,
      threadId: recent.threadId,
      topic: recent.topic,
      timestamp: recent.timestamp,
    } : null,
  });
});

// Clear active thread for a channel (e.g., when topic changes)
app.delete('/post/:channelId', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  activeThreads.delete(req.params.channelId);
  res.json({ ok: true, cleared: req.params.channelId });
});

function isUserInVoice(userId) {
  if (!client || !GUILD_ID || !currentVoiceChannelId) return false;
  
  // Check if user is in the current voice channel
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return false;
  
  const member = guild.members.cache.get(userId);
  if (!member) return false;
  
  return member.voice.channelId === currentVoiceChannelId;
}

async function sendTextNotification(alert) {
  if (!client || !ALLOWED_USERS[0]) return;
  
  // Send Discord DM
  try {
    const user = await client.users.fetch(ALLOWED_USERS[0]);
    const priorityBadge = alert.priority === 'urgent' ? '🚨 **Urgent Alert**' : '🔔 **Alert**';
    const sourceBadge = alert.source ? `\n*Source: ${alert.source}*` : '';
    await user.send(`${priorityBadge}\n${alert.message}${sourceBadge}\n\nJoin voice for briefing.`);
    logger.info(`📱 Text notification sent to user`);
  } catch (err) {
    logger.error(`❌ Failed to send DM: ${err.message}`);
  }
}

// ── /test-voice: inject a text message through the full voice pipeline (bypasses STT) ──
app.post('/test-voice', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  try {
    // Sanity-check the gateway directly before calling brain
    const gwUrl = process.env.CLAWDBOT_GATEWAY_URL || 'http://127.0.0.1:22100';
    const gwToken = process.env.CLAWDBOT_GATEWAY_TOKEN;
    const pingRes = await fetch(`${gwUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gwToken}`,
        'x-openclaw-scopes': 'operator.write',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Reply: pong' }], max_tokens: 5, model: 'openclaw' }),
      signal: AbortSignal.timeout(10_000),
    });
    const pingData = await pingRes.json();
    logger.info(`🧪 direct gateway ping: status=${pingRes.status} ok=${pingRes.ok} body=${JSON.stringify(pingData).substring(0, 120)}`);

    const { generateResponse } = await import('./brain.js');
    const { speakText } = await import('./speech-output.js');

    logger.info(`🧪 /test-voice inject: "${message.substring(0, 80)}"`);
    const startMs = Date.now();

    const result = await generateResponse(message, [], null, {});
    const elapsed = Date.now() - startMs;
    const text = result?.text || result || '';

    logger.info(`🧪 /test-voice response (${elapsed}ms): "${String(text).substring(0, 120)}" | full result: ${JSON.stringify(result)}`);

    if (text) {
      await speakText(text);
    }

    res.json({ ok: true, elapsed_ms: elapsed, response: String(text).substring(0, 500) });
  } catch (err) {
    logger.error(`❌ /test-voice error: ${err?.message || String(err)} | stack: ${err?.stack?.split('\n')[1]}`);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Export the express app for testing (tests start their own server on a random port)
export { app };

export function startAlertWebhook() {
  const TAILSCALE_IP = process.env.TAILSCALE_IP || 'localhost';
  app.listen(WEBHOOK_PORT, TAILSCALE_IP, () => {
    logger.info(`🔔 Alert webhook listening on ${TAILSCALE_IP}:${WEBHOOK_PORT} (Tailscale only)`);
    logger.info(`   Endpoints: /alert, /speak, /handoff, /post, /remind, /remind/:id/ack, /reminders, /context/active, /health, /test-voice`);
  });
}
