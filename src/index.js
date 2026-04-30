/**
 * Jarvis Voice Bot — Bootstrap
 *
 * Thin bootstrap: creates Discord client, wires event handlers, and delegates
 * to extracted subsystems. All business logic lives in src/{voice,discord,brain,agent,state}/.
 */

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { createAudioPlayer, NoSubscriberBehavior } from '@discordjs/voice';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Subsystem imports
import { checkSttHealth } from './voice/stt.js';
import { synthesizeSpeech } from './voice/tts.js';
import { getPlayer, setPlayer, speakPhrase, getIsSpeaking } from './voice/speech-output.js';
import { isDiscordMemoryReady, initDiscordMemory, maybeRecordDiscordMessage, updateDiscordMessageContent } from './discord/discord-memory.js';
import { canAccessChannel } from './discord/channel-access.js';
import { handleAutocomplete, handleSlashCommand } from './discord/slash-commands.js';
import { handleSessionMessage, isSessionChannel } from './discord/slash/session.js';
import { handleSessionSetup } from './session-setup.js';
import { handleCallbackMessage, checkIsReplyToUs, handleMentionReply, handleExplicitFocus, handleAutoFocusUpdate, handleVoiceTranscript } from './discord/message-handlers.js';
import { handleOthersPresentUpdate, handleOwnerVoiceStateUpdate } from './discord/voice-state-handler.js';
import { onReady } from './discord/startup.js';
import { startGatewayHealthCheck, isGatewayHealthy } from './gateway-health.js';
import { getTTSHealth } from './voice/tts.js';
import { getSTTHealth } from './voice/stt.js';
import { getAllowedUserIds } from './allowed-users.js';
import { updateHealthState } from './alert-webhook.js';
import { cancelAllTasks, reconnectState } from './voice/voice-receiver.js';
import { markFailed } from './agent/task-ledger.js';
import { getTask, TaskState, processOrphans } from './agent/task-ledger.js';
import { postToTextChannel } from './discord/posting.js';
import { speakPhrase as _speakPhrase } from './voice/speech-output.js';
import { isVisualModeEnabled } from './visual-mode.js';
import logger from './logger.js';
import {
  activeTasks, conversations, voiceConn, interactionState,
  discordRef, recordMode, staleInlineTasks, spokeLostTrackFor,
} from './state/runtime.js';
import { voiceTasks } from './voice-tasks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, '..', 'tmp');
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

// ── Config ────────────────────────────────────────────────────────────────

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID;
const TEXT_CHANNEL_ID = process.env.DISCORD_TEXT_CHANNEL_ID;
const CC_CHANNEL_ID = process.env.DISCORD_CC_CHANNEL_ID;
const VOICE_REPORT_CHANNEL_ID = process.env.VOICE_REPORT_CHANNEL_ID || TEXT_CHANNEL_ID;
const ACTIVITY_CHANNEL_ID = process.env.DISCORD_ACTIVITY_CHANNEL_ID || TEXT_CHANNEL_ID;
const WEBHOOK_CALLBACK_MODE = process.env.WEBHOOK_CALLBACK_MODE === 'true';
const VOICE_CALLBACK_CHANNEL_ID = process.env.VOICE_CALLBACK_CHANNEL_ID || TEXT_CHANNEL_ID;
const JARVIS_BOT_ID = process.env.JARVIS_BOT_ID || '';
const VOICE_MESSAGE_AUTO_REPLY = process.env.VOICE_MESSAGE_AUTO_REPLY !== 'false';
const VOICE_MESSAGE_CHANNELS = (process.env.VOICE_MESSAGE_CHANNELS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const MULTI_USER_ENABLED = process.env.MULTI_USER_ENABLED === 'true';
const HEALTH_CHECK_INTERVAL_MS = 30 * 1000;
const MEMORY_WARNING_MB = 500;
const MEMORY_CRITICAL_MB = 1024;
const EVENT_LOOP_LAG_WARNING_MS = 500;
const CONVERSATION_TTL_MS = 60 * 60 * 1000;

// Live proxy for allowed users — delegates on every access so admin changes take effect without restart
const ALLOWED_USERS = new Proxy([], {
  get(_, prop) {
    const live = getAllowedUserIds();
    if (typeof live[prop] === 'function') return live[prop].bind(live);
    return live[prop];
  },
  has(_, prop) { return prop in getAllowedUserIds(); },
});

// ── Startup ───────────────────────────────────────────────────────────────

startGatewayHealthCheck();

// ── Audio Player ──────────────────────────────────────────────────────────

const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
player.setMaxListeners(20);
setPlayer(player);

// ── Discord Client ────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Wire client into shared runtime state (needed by all posting modules)
discordRef.client = client;
initDiscordMemory();

// ── Message Handler ───────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  maybeRecordDiscordMessage(message);

  if (WEBHOOK_CALLBACK_MODE &&
      message.channelId === VOICE_CALLBACK_CHANNEL_ID &&
      message.author.id === JARVIS_BOT_ID &&
      message.author.id !== client.user.id) {
    return handleCallbackMessage(message);
  }

  if (!message.author.bot && isSessionChannel(message.channelId)) {
    if (handleSessionMessage(message)) return;
  }

  if (!message.author.bot) {
    const setupResult = await handleSessionSetup(message);
    if (setupResult === true) return;
    if (setupResult && typeof setupResult === 'object' && !setupResult.handled) {
      message._workspaceContext = setupResult.workspaceContext;
    }
  }

  if (message.author.bot) return;
  const _accessChannelId = message.channel?.isThread?.()
    ? (message.channel.parentId || message.channelId)
    : message.channelId;
  if (!canAccessChannel(message.author.id, _accessChannelId)) return;

  const content = (message.content || '').trim();

  if (/^\/(handoff|focus)(\s|$)/i.test(content)) return handleExplicitFocus(message, content);

  if (/^\/cred(\s|$)/i.test(content)) {
    const { parseCredCommand, handleCredCommand } = await import('./discord/slash/cred.js');
    const parsed = parseCredCommand(content);
    if (parsed.isCredCommand) return handleCredCommand(message, parsed);
  }

  await handleAutoFocusUpdate(message, content);

  if ((message.flags?.bitfield & 8192) !== 0) {
    if (!VOICE_MESSAGE_AUTO_REPLY) return;
    if (VOICE_MESSAGE_CHANNELS.length > 0 && !VOICE_MESSAGE_CHANNELS.includes(message.channelId)) return;
    return handleVoiceTranscript(message);
  }

  const isReplyToUs = await checkIsReplyToUs(message);
  return handleMentionReply(message, content, isReplyToUs);
});

client.on('messageUpdate', (_before, message) => {
  if (message.partial || !isDiscordMemoryReady()) return;
  try { updateDiscordMessageContent(message, message.client.user.id); } catch {}
});

// ── Voice State Handlers ──────────────────────────────────────────────────

client.on('voiceStateUpdate', (oldState, newState) => {
  handleOthersPresentUpdate(oldState, newState, voiceConn.channelId, ALLOWED_USERS).catch(() => {});
});

client.on('voiceStateUpdate', (oldState, newState) => {
  handleOwnerVoiceStateUpdate(oldState, newState, {
    allowedUsers: ALLOWED_USERS,
    VOICE_CHANNEL_ID,
  }).catch(() => {});
});

// ── Slash Command Handler ─────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) { await handleAutocomplete(interaction); return; }
    await handleSlashCommand(interaction, ALLOWED_USERS);
  } catch (err) {
    logger.error(`[slash] Interaction error: ${err.message}`);
    if (interaction.replied || interaction.deferred) return;
    await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => {});
  }
});

// ── Ready Handler ─────────────────────────────────────────────────────────

client.once('ready', () => {
  onReady(client, {
    GUILD_ID, VOICE_CHANNEL_ID, TEXT_CHANNEL_ID, ACTIVITY_CHANNEL_ID,
    VOICE_REPORT_CHANNEL_ID, CC_CHANNEL_ID, VOICE_CALLBACK_CHANNEL_ID,
    MULTI_USER_ENABLED, WEBHOOK_CALLBACK_MODE, ALLOWED_USERS,
    startHealthMonitor,
  }).catch(err => logger.error(`[ready] startup error: ${err.message}`));
});

// ── Health Monitor ────────────────────────────────────────────────────────

let lastEventLoopCheck = Date.now();
let eventLoopLagWarnings = 0;

function startHealthMonitor() {
  setInterval(async () => {
    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / 1024 / 1024);

    if (rssMb > MEMORY_CRITICAL_MB) {
      logger.error(`🔴 CRITICAL: Memory usage ${rssMb}MB > ${MEMORY_CRITICAL_MB}MB - attempting graceful restart`);
      postToTextChannel(`🔴 **Memory critical** (${rssMb}MB). Restarting gracefully.`);
      setTimeout(() => process.exit(1), 2000);
    } else if (rssMb > MEMORY_WARNING_MB) {
      logger.warn(`🟡 Memory usage high: ${rssMb}MB > ${MEMORY_WARNING_MB}MB`);
    }

    const now = Date.now();
    const lag = now - lastEventLoopCheck - HEALTH_CHECK_INTERVAL_MS;
    lastEventLoopCheck = now;

    if (lag > EVENT_LOOP_LAG_WARNING_MS) {
      eventLoopLagWarnings++;
      logger.warn(`🟡 Event loop lag: ${lag}ms (warning #${eventLoopLagWarnings})`);
      if (eventLoopLagWarnings >= 3) {
        logger.error(`🔴 Sustained event loop lag (${eventLoopLagWarnings} warnings)`);
        postToTextChannel(`⚠️ **Event loop lag** detected (${lag}ms, ${eventLoopLagWarnings} warnings). Performance may be degraded.`);
        eventLoopLagWarnings = 0;
      }
    } else {
      eventLoopLagWarnings = Math.max(0, eventLoopLagWarnings - 1);
    }

    updateHealthState({
      gatewayHealthy: isGatewayHealthy(),
      ttsHealth: getTTSHealth(),
      sttHealth: getSTTHealth(),
      activeTaskCount: activeTasks.size,
      reconnectAttempts: reconnectState.attempts,
      lastSuccessfulInteraction: interactionState.lastInteractionTime || null,
    });

    // Stuck server-mute watchdog
    try {
      const { audioQueue } = await import('./voice/tts-delivery.js');
      const guild = client.isReady() ? client.guilds.cache.get(GUILD_ID) : null;
      if (guild && ALLOWED_USERS[0]) {
        const member = guild.members.cache.get(ALLOWED_USERS[0]);
        if (member?.voice?.channelId && member.voice.serverMute && activeTasks.size === 0 && !audioQueue?.playing && !getIsSpeaking()) {
          logger.warn('🔧 Watchdog: detected stuck server mute with no active playback - clearing');
          await member.voice.setMute(false, 'Watchdog: clearing stuck server mute');
        }
      }
    } catch (err) {
      if (!err.message.includes('not connected to voice')) {
        logger.warn(`Stuck-mute watchdog error: ${err.message}`);
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  logger.info('🏥 Process health monitor started (30s interval)');
}

// ── Background Intervals ──────────────────────────────────────────────────

// Conversation TTL pruning
setInterval(() => {
  const cutoff = Date.now() - CONVERSATION_TTL_MS;
  for (const [userId, conv] of conversations.entries()) {
    if (conv.lastActive && conv.lastActive < cutoff) conversations.delete(userId);
  }
}, 10 * 60 * 1000);

// Orphan task detection
setInterval(() => {
  try {
    const orphans = processOrphans();
    if (orphans.length > 0) {
      const newOrphans = orphans.filter(t => {
        if (t.state === 'escalated') return false;
        const fresh = getTask(t.taskId);
        if (!fresh) return false;
        if (fresh.state === TaskState.COMPLETED || fresh.state === TaskState.FAILED ||
            fresh.state === TaskState.ESCALATED) return false;
        return true;
      });
      for (const task of newOrphans) {
        const age = ((Date.now() - task.createdAt) / 1000).toFixed(0);
        logger.warn(`📋 Orphaned task #${task.taskId}: "${task.transcript}" - no result after ${age}s`);
        postToTextChannel(`⚠️ **Lost task #${task.taskId}** (no result after ${age}s): "${task.transcript.substring(0, 60)}"`, { forceChannelId: process.env.VOICE_TRANSCRIPT_CHANNEL_ID });
        markFailed(task.taskId, 'orphan-detected');
      }
      if (newOrphans.length > 0) {
        const orphanList = newOrphans.map(t => `• #${t.taskId}: "${t.transcript.substring(0, 60)}"`).join('\n');
        logger.warn(`📋 ${newOrphans.length} new orphaned tasks:\n${orphanList}`);
      }
    }
  } catch (e) {
    logger.warn(`📋 Orphan check failed: ${e.message}`);
  }
}, 2 * 60 * 1000);

// Stall detection + backlog cap
setInterval(() => {
  try {
    const now = Date.now();
    for (const [taskId, taskMeta] of activeTasks) {
      const stalledMs = now - taskMeta.startTime;
      if (stalledMs > 30000 && !spokeLostTrackFor.has(taskId)) {
        spokeLostTrackFor.add(taskId);
        logger.warn(`⏱️ Task #${taskId} stalled ${Math.round(stalledMs/1000)}s (silent — stale gate will handle)`);
      }
    }
    if (activeTasks.size > 5) {
      const entries = [...activeTasks.entries()].sort((a, b) => a[1].startTime - b[1].startTime);
      const toClear = entries.slice(0, activeTasks.size - 5);
      for (const [id] of toClear) {
        markFailed(id, 'backlog-cleared');
        activeTasks.delete(id);
        voiceTasks.delete(id);
        spokeLostTrackFor.delete(id);
        staleInlineTasks.delete(id);
      }
      speakPhrase('Clearing backlog, sir.').catch(() => {});
      logger.warn(`📋 Cleared ${toClear.length} oldest task(s) from backlog (cap=5)`);
    }
    for (const id of spokeLostTrackFor) { if (!activeTasks.has(id)) spokeLostTrackFor.delete(id); }
    for (const id of staleInlineTasks) { if (!activeTasks.has(id)) staleInlineTasks.delete(id); }
  } catch (e) {
    logger.warn(`📋 Stall check failed: ${e.message}`);
  }
}, 5000);

// ── Global Error Handlers ─────────────────────────────────────────────────

process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ Unhandled Promise Rejection:');
  logger.error('Promise:', promise);
  logger.error('Reason:', reason instanceof Error ? reason.stack : reason);
  logger.error('⚠️  Attempting graceful degradation - bot remains running');
});

process.on('uncaughtException', (err) => {
  if (err?.message?.includes('already been destroyed') || err?.message?.includes('ERR_SOCKET_DGRAM_NOT_RUNNING')) {
    logger.warn(`[voice] suppressed double-destroy: ${err.message}`);
    return;
  }
  logger.error('❌ Uncaught Exception:');
  logger.error(err.stack || err);
  logger.error('⚠️  Attempting graceful shutdown...');
  try {
    cancelAllTasks();
    if (voiceConn.connection) { try { voiceConn.connection.destroy(); } catch {} }
    client.destroy();
  } catch (cleanupErr) {
    logger.error('❌ Cleanup error during uncaughtException handler:', cleanupErr);
  }
  setTimeout(() => process.exit(1), 1000);
});

process.on('SIGINT', () => {
  cancelAllTasks();
  if (voiceConn.connection) voiceConn.connection.destroy();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cancelAllTasks();
  if (voiceConn.connection) voiceConn.connection.destroy();
  client.destroy();
  process.exit(0);
});

// ── Env Validation ────────────────────────────────────────────────────────

const REQUIRED_ENV = ['DISCORD_TOKEN', 'DISCORD_GUILD_ID', 'JARVIS_GATEWAY_URL', 'SPEAKER_VERIFY_URL'];
const missing = REQUIRED_ENV.filter(v => !process.env[v]);
if (missing.length > 0) {
  logger.error(`[startup] Missing required env vars: ${missing.join(', ')}`);
  logger.error('[startup] See .env.example for reference. Exiting.');
  process.exit(1);
}

checkSttHealth().catch(() => {});

// ── Login ─────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
