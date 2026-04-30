/**
 * startup.js — Discord 'ready' event handler body.
 *
 * Extracted from src/index.js. Called once when the Discord client emits 'ready'.
 * Handles: slash command registration, MCP bootstrap, focus-state injection,
 * channel validation, HUD init, task ledger reconcile, scheduler init,
 * alert-webhook init, callback wiring, FSM wiring, and initial voice join.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import logger from '../logger.js';
import { synthesizeSpeech, switchChatterboxVoice } from '../voice/tts.js';
import { preloadAckPhrases } from '../voice/speech-output.js';
import { setPersonaWakeWords } from '../voice/wakeword.js';
import { getActivePersona, switchPersona, switchPersonaFull, setSwitchPersonaFullImpl } from '../brain/brain.js';
import {
  startAlertWebhook, initAlertWebhook,
  setPersonaSwitchCallback, setPersonaCreateCallback,
  setSpeakCallback, setMarkBotResponseCallback, setPostActivityCallback,
  setPostToTextCallback, setDedupCallback, setDidTaskSpeakInlineCallback,
  setCancelAllTasksCallback, setHandleFakeSttCallback,
} from '../alert-webhook.js';
import { setCircuitBreakerNotifyCallback } from '../brain/brain.js';
import { setMcpAuthNotify } from '../mcp-access.js';
import { setMcpMode as setChannelMcpMode, getMcpMode as getChannelMcpMode } from './channel-mcp-mode.js';
import { registerSlashCommands } from './slash-commands.js';
import { initHud, hudRefresh } from './hud.js';
import { postToTextChannel, postActivity } from './posting.js';
import { isDuplicateContent, didTaskSpeakInline } from './dedup.js';
import { scheduleBriefingOnPause } from '../brain/briefing.js';
import { reconcileOnStartup, markEscalated } from '../agent/task-ledger.js';
import { initScheduler } from '../task-scheduler.js';
import { OWNER_USER_ID } from './channel-access.js';
import { wireFSMCallbacks, resetIdleSleepTimer, startTaskAutoSleep } from '../state/fsm.js';
import { getState } from '../state/bot-state.js';
import { isFollowUpExpected } from '../voice/wakeword.js';
import { setFollowUpExpectedCallback } from '../brain/intent-classifier.js';
import { cancelAllTasks, joinChannel, startRecordMode } from '../voice/voice-receiver.js';
import { unlinkSync } from 'fs';
import {
  activeTasks, conversations, interactionState, pendingUtterance,
} from '../state/runtime.js';
import { markBotResponse } from '../voice/wakeword.js';
import { enrollmentState } from '../auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Boot sequence ─────────────────────────────────────────────────────────

export async function onReady(client, {
  GUILD_ID,
  VOICE_CHANNEL_ID,
  TEXT_CHANNEL_ID,
  ACTIVITY_CHANNEL_ID,
  VOICE_REPORT_CHANNEL_ID,
  CC_CHANNEL_ID,
  VOICE_CALLBACK_CHANNEL_ID,
  MULTI_USER_ENABLED,
  WEBHOOK_CALLBACK_MODE,
  ALLOWED_USERS,
  startHealthMonitor,
}) {
  logger.info(`🤖 Jarvis Voice Bot online as ${client.user.tag}`);
  logger.info(`📡 Guild: ${GUILD_ID} | Voice: ${VOICE_CHANNEL_ID} | Multi-user: ${MULTI_USER_ENABLED} | Callback: ${WEBHOOK_CALLBACK_MODE}`);

  registerSlashCommands(client).catch(e => logger.warn(`[slash] Registration error: ${e.message}`));

  import('../admin-api.js').then(m => m.startAdminApi({ discordClient: client })).catch(e => logger.warn(`[admin-api] start error: ${e.message}`));
  import('../live-stream.js').then(m => m.sweepOrphanedStreams()).catch(e => logger.warn(`[live-stream] sweep error: ${e.message}`));
  import('../channel-topic.js')
    .then(m => m.hydrateRegistryFromTopics(client, GUILD_ID))
    .catch(e => logger.warn(`[channel-topic] hydrate error: ${e.message}`));

  // Auto-on full MCP for HUD + handoff threads
  try {
    const hudId = process.env.HUD_CHANNEL_ID;
    if (hudId && !getChannelMcpMode(hudId)) {
      setChannelMcpMode(hudId, 'full');
      logger.info(`[mcp-mode] bootstrap: set ${hudId} (#hud) → full`);
    }
    const handoffFile = `${process.env.HOME}/.local/state/jarvis-voice/handoff-pins.json`;
    try {
      const pins = JSON.parse(readFileSync(handoffFile, 'utf8'));
      for (const entry of Object.values(pins || {})) {
        const tid = entry?.threadId;
        if (tid && !getChannelMcpMode(tid)) {
          setChannelMcpMode(tid, 'full');
          logger.info(`[mcp-mode] bootstrap: set ${tid} (handoff thread) → full`);
        }
      }
    } catch { /* file may not exist */ }
  } catch (e) {
    logger.warn(`[mcp-mode] bootstrap error: ${e.message}`);
  }

  // Wire MCP auth notify
  setMcpAuthNotify(async (server, tool, url) => {
    const msg = `**MCP authorization required**\n\`${server}.${tool}\` needs re-auth:\n${url}`;
    try {
      if (OWNER_USER_ID) {
        const owner = await client.users.fetch(OWNER_USER_ID).catch(() => null);
        if (owner) { await owner.send(msg); return; }
      }
      const ch = await client.channels.fetch(TEXT_CHANNEL_ID).catch(() => null);
      if (ch?.isTextBased?.()) await ch.send(msg);
    } catch (e) {
      logger.warn(`[mcp] auth notify failed: ${e.message}`);
    }
  });

  // Seed wake words + Chatterbox voice from startup persona
  const startupPersona = getActivePersona();
  setPersonaWakeWords(startupPersona.wakeWords || []);
  switchChatterboxVoice(startupPersona.voice).catch(e => logger.warn(`[startup] chatterbox voice seed error: ${e.message}`));

  initAlertWebhook(client, GUILD_ID, ALLOWED_USERS, scheduleBriefingOnPause);

  // Inject Discord client into focus-state
  try {
    const { setDiscordClient, setDiscordGuildChannels } = await import('../state/focus-state.js');
    setDiscordClient(client);
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) setDiscordGuildChannels(guild.channels.cache);
  } catch (err) {
    logger.warn(`[startup] Failed to inject Discord client into focus-state: ${err.message}`);
  }

  // Channel validation
  {
    const channelChecks = [
      { id: TEXT_CHANNEL_ID,           label: 'DISCORD_TEXT_CHANNEL_ID',    required: true },
      { id: VOICE_CHANNEL_ID,          label: 'DISCORD_VOICE_CHANNEL_ID',   required: true },
      { id: ACTIVITY_CHANNEL_ID,       label: 'DISCORD_ACTIVITY_CHANNEL_ID', required: false },
      { id: VOICE_REPORT_CHANNEL_ID,   label: 'VOICE_REPORT_CHANNEL_ID',    required: false },
      { id: CC_CHANNEL_ID,             label: 'DISCORD_CC_CHANNEL_ID',      required: false },
      { id: process.env.RECORD_CHANNEL_ID, label: 'RECORD_CHANNEL_ID',      required: false },
      { id: VOICE_CALLBACK_CHANNEL_ID, label: 'VOICE_CALLBACK_CHANNEL_ID',  required: WEBHOOK_CALLBACK_MODE },
    ];
    const bad = [];
    for (const { id, label, required } of channelChecks) {
      if (!id) { if (required) bad.push(`${label}: not set`); continue; }
      try {
        const ch = client.channels.cache.get(id) || await client.channels.fetch(id).catch(() => null);
        if (!ch) bad.push(`${label} (${id}): not found`);
      } catch (e) {
        bad.push(`${label} (${id}): ${e.message}`);
      }
    }
    if (bad.length > 0) {
      const warn = `[startup] Channel validation warnings:\n${bad.map(s => `  • ${s}`).join('\n')}`;
      logger.warn(warn);
      try {
        const hudCh = client.channels.cache.get(process.env.HUD_CHANNEL_ID);
        if (hudCh) await hudCh.send(`⚠️ **Startup channel warnings:**\n${bad.map(s => `• ${s}`).join('\n')}`).catch(() => {});
      } catch (_) {}
    }
  }

  initHud(client);
  hudRefresh();

  // Task ledger reconcile
  try {
    const { orphans, pending } = reconcileOnStartup();
    if (orphans.length > 0) {
      const shown = orphans.slice(0, 3);
      const lines = shown.map(t => {
        const ago = Math.round((Date.now() - t.createdAt) / 60000);
        return `• "${t.transcript.substring(0, 60)}" (${ago}m ago)`;
      });
      if (orphans.length > 3) lines.push(`...and ${orphans.length - 3} more`);
      const msg = `⚠️ I restarted and lost track of **${orphans.length}** voice command(s) from before:\n${lines.join('\n')}\nThe gateway likely completed the work, but I wasn't alive to deliver results.`;
      postToTextChannel(msg, { forceChannelId: process.env.VOICE_TRANSCRIPT_CHANNEL_ID });
      logger.info(`📋 Orphan escalation: ${orphans.length} tasks notified to user`);
      for (const t of orphans) markEscalated(t.taskId);
    }
    if (pending.length > 0) {
      logger.info(`📋 ${pending.length} tasks still awaiting follow-up`);
    }
  } catch (e) {
    logger.warn(`📋 Ledger reconciliation failed: ${e.message}`);
  }

  // Persistent scheduler
  initScheduler(async (sched) => {
    const GATEWAY_URL = process.env.JARVIS_GATEWAY_URL || 'http://127.0.0.1:22100';
    const GATEWAY_TOKEN = process.env.JARVIS_GATEWAY_TOKEN || '';
    let text = '';
    try {
      if (sched.mode === 'shell' && sched.shellCmd) {
        const { execSync } = await import('child_process');
        try {
          text = execSync(sched.shellCmd, { timeout: 15000, encoding: 'utf8' }).trim();
          if (!text) text = '(no output)';
        } catch (e) {
          text = `⚠️ Command failed: ${e.message.split('\n')[0]}`;
        }
      } else {
        const model = sched.model || 'haiku';
        const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GATEWAY_TOKEN}` },
          body: JSON.stringify({ model, max_tokens: 512, messages: [{ role: 'user', content: sched.prompt }] }),
        });
        const data = await res.json();
        text = data?.choices?.[0]?.message?.content || '';
      }
      if (sched.channelId && text) {
        await postToTextChannel(`**[Schedule \`${sched.id}\`]** ${text}`, { forceChannelId: sched.channelId });
      }
      if (sched.terminationPhrase && text.toLowerCase().includes(sched.terminationPhrase.toLowerCase())) {
        await postToTextChannel(`✅ Schedule \`${sched.id}\` condition met — stopped.`, { forceChannelId: sched.channelId });
      }
      return { text };
    } catch (err) {
      logger.warn(`[scheduler] dispatch error: ${err.message}`);
      return { text: '' };
    }
  });

  // Wire callbacks
  setDedupCallback(isDuplicateContent);
  setDidTaskSpeakInlineCallback(didTaskSpeakInline);
  setCancelAllTasksCallback(() => {
    const count = activeTasks.size;
    cancelAllTasks();
    return count;
  });

  setHandleFakeSttCallback(async (text, userId) => {
    const effectiveUserId = userId || ALLOWED_USERS[0];
    const { checkWakeWord } = await import('../voice/wakeword.js');
    const { dispatchCommand } = await import('./command-dispatch.js');
    const { enrollmentState } = await import('../auth.js');
    const wakeResult = checkWakeWord(text);
    const cleaned = wakeResult.stripped || text;
    const dispatch = await dispatchCommand(text, cleaned, effectiveUserId, ALLOWED_USERS, enrollmentState);
    return { type: dispatch.type, wakeWord: wakeResult.detected, transcript: text, dispatch };
  });

  setFollowUpExpectedCallback(() => isFollowUpExpected());

  setSpeakCallback(async (message, speakOpts = {}) => {
    try {
      if (!message || message.trim().length < 2) return;
      const { isTTSDeliveryActive, _shouldBufferSpeak, _deliverSpeak, scheduleFlushOnDrain } = await import('../voice/tts-delivery.js');
      const { pendingSpeaks } = await import('../state/runtime.js');
      if (_shouldBufferSpeak()) {
        const reason = isTTSDeliveryActive() ? 'task delivery active' : 'audio playing';
        logger.info(`🔔 /speak buffered (${reason}): "${message.substring(0, 60)}"`);
        pendingSpeaks.push({ message, speakOpts });
        scheduleFlushOnDrain();
        return;
      }
      await _deliverSpeak(message, speakOpts);
    } catch (err) {
      logger.error('Speak callback TTS failed:', err.message);
    }
  });

  setMarkBotResponseCallback((userId, opts) => {
    import('../voice/tts-delivery.js').then(m => {
      m.audioQueue.waitForPlaybackDrained().then(() => {
        markBotResponse(userId, opts);
        if (getState() === 'ACTIVE') startTaskAutoSleep();
      });
    }).catch(() => {});
  });

  setPostActivityCallback((message) => postActivity(message));

  setCircuitBreakerNotifyCallback((type) => {
    const cbChannelId = process.env.DISCORD_CIRCUIT_BREAKER_CHANNEL;
    if (!cbChannelId || !client.isReady()) return;
    const msg = type === 'open'
      ? '⚠️ Gateway circuit breaker OPEN - gateway unreachable'
      : '✅ Gateway circuit breaker CLOSED - gateway recovered';
    client.channels.fetch(cbChannelId).then(ch => ch.send(msg)).catch(() => {});
  });

  setPostToTextCallback((message, opts) => postToTextChannel(message, opts));

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
      logger.warn(`[persona] voice switch failed (${e.message}) - reverting to ${previous.name}`);
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

  setPersonaCreateCallback(({ name, content, voice, ttsVoiceEdge, wakeWords, overwrite }) => {
    const filePath = join(dirname(__dirname), 'personalities', `${name}.md`);
    if (!overwrite && existsSync(filePath)) {
      const err = new Error(`Persona '${name}' already exists - set overwrite: true to replace`);
      err.code = 'EEXIST';
      throw err;
    }
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
    const displayName = name.charAt(0).toUpperCase() + name.slice(1);
    return { name: displayName, voice, ttsVoiceEdge: ttsVoiceEdge || null, wakeWords, content };
  });

  startAlertWebhook();
  startHealthMonitor();

  preloadAckPhrases(synthesizeSpeech).catch(err => logger.warn('Ack preload failed:', err.message));

  if ((process.env.TTS_PROVIDER || '').toLowerCase() === 'chatterbox') {
    logger.info('🔥 Chatterbox GPU warmup starting...');
    synthesizeSpeech('Warming up.').then(audio => {
      if (audio) try { unlinkSync(audio); } catch {}
      logger.info('🔥 Chatterbox GPU warmup complete');
    }).catch(() => {});
  }

  // Wire FSM callbacks
  wireFSMCallbacks({
    getEnrollmentActive: () => enrollmentState.active,
    getAuthenticatedSession: () => interactionState.authenticatedSession,
    setAuthenticatedSession: (val) => { interactionState.authenticatedSession = val; },
    getPendingUtterance: () => pendingUtterance,
    clearPendingUtterance: () => {
      if (pendingUtterance.timer) {
        clearTimeout(pendingUtterance.timer);
        pendingUtterance.timer = null;
        pendingUtterance.parts = [];
        pendingUtterance.userId = null;
      }
    },
    getActiveTaskCount: () => activeTasks.size,
  });

  // Join voice channel on startup
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    let ownerChannel = null;
    try {
      const ownerMember = await guild.members.fetch(ALLOWED_USERS[0]);
      ownerChannel = ownerMember?.voice?.channelId;
      interactionState.ownerMuted = !!ownerMember?.voice?.selfMute;
      if (ownerChannel) {
        logger.info(`👀 Owner is in voice channel ${ownerChannel} (${interactionState.ownerMuted ? 'muted' : 'unmuted'})`);
        interactionState.userDisconnected = false;
      }
    } catch (e) {
      logger.info(`Could not fetch owner voice state: ${e.message}`);
    }

    const targetChannel = ownerChannel || VOICE_CHANNEL_ID;
    if (targetChannel) {
      let attempt = 0;
      const maxAttempts = 3;
      let joined = false;
      while (!joined && attempt < maxAttempts) {
        attempt++;
        try {
          await joinChannel(targetChannel, { greeting: false });
          logger.info(`✅ Joined voice channel ${targetChannel}${ownerChannel ? ' (owner is here)' : ' (default)'}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
          joined = true;
          if (process.env.RECORD_CHANNEL_ID && targetChannel === process.env.RECORD_CHANNEL_ID) {
            startRecordMode(ALLOWED_USERS[0]);
          }
        } catch (err) {
          if (attempt < maxAttempts) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            logger.error(`⚠️ Join attempt ${attempt} failed: ${err.message} - retrying in ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            logger.error('⚠️ Failed to join voice channel after 3 attempts:', err.message);
            logger.info('🔄 Will auto-join when owner enters a voice channel');
          }
        }
      }
    } else {
      logger.info('🔄 No default channel and owner not in voice - waiting for owner to join');
    }
  } catch (err) {
    logger.error('⚠️ Failed to join voice channel:', err.message);
    logger.info('🔄 Will auto-join when owner enters a voice channel');
  }
}
