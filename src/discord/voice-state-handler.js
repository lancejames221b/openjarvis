/**
 * voice-state-handler.js — Discord voiceStateUpdate event handlers.
 *
 * Extracted from src/index.js. Handles:
 * - Others-present tracking (mute-gating)
 * - Owner mute tracking + mute-queue debrief
 * - Owner channel follow
 * - Owner join: greeting, context brief, alert/handoff briefings, mute-queue reconnect
 * - Owner disconnect: record mode, session pins, handleVoiceDisconnect
 */

import logger from '../logger.js';
import { synthesizeSpeech } from '../voice/tts.js';
import {
  joinChannel, handleVoiceDisconnect, serverMuteOwner,
  startRecordMode, stopRecordMode, playAudioEnhanced,
} from '../voice/voice-receiver.js';
import { markBotResponse } from '../voice/wakeword.js';
import {
  resetIdleSleepTimer, applyImplicitWakeOnUnmute, startTaskAutoSleep, transition,
} from '../state/fsm.js';
import { getState } from '../state/bot-state.js';
import {
  activate as muteQueueActivate, deactivate as muteQueueDeactivate,
  isActive as isMuteQueueActive, hasEntries as muteQueueHasEntries,
  getSummary as muteQueueSummary, getContextBlock as muteQueueContext,
  clear as muteQueueClear, getCount as muteQueueCount,
} from '../state/mute-queue.js';
import { postToTextChannel, postToChannel, resolveVisualChannel } from './posting.js';
import { briefPendingAlerts, briefPendingHandoffs } from '../brain/briefing.js';
import { shouldBrief, markBriefingDelivered, generateBriefing } from '../join-briefing.js';
import { hasPendingAlerts } from '../alert-queue.js';
import { hasPendingHandoffs, endAllSessionPins } from '../alert-webhook.js';
import { getActivePersona } from '../brain/brain.js';
import { isVisualModeEnabled } from '../visual-mode.js';
import { unlinkSync } from 'fs';
import {
  conversations, voiceConn, interactionState, recordMode,
} from '../state/runtime.js';

const MUTE_QUEUE_ENABLED = process.env.MUTE_QUEUE_ENABLED === 'true';
const MUTE_QUEUE_WAKE_BYPASS = process.env.MUTE_QUEUE_WAKE_BYPASS !== 'false';
const UNMUTE_IMPLICIT_WAKE = process.env.UNMUTE_IMPLICIT_WAKE !== 'false';

// ── Others-present tracking ───────────────────────────────────────────────

export async function handleOthersPresentUpdate(oldState, newState, voiceChannelId, allowedUsers) {
  if (!voiceChannelId) return;
  const { isOthersPresent, setOthersPresent } = await import('../voice/wakeword.js');
  const { discordRef } = await import('../state/runtime.js');
  const channel = discordRef.client?.channels.cache.get(voiceChannelId);
  if (channel) {
    const wasOthers = isOthersPresent();
    const { audioQueue } = await import('../voice/tts-delivery.js');
    const others = channel.members.filter(m => !m.user.bot && !allowedUsers.includes(m.id)).size;
    setOthersPresent(others > 0);
    if (wasOthers && others === 0 && audioQueue && audioQueue.queue.length > 0 && !audioQueue.playing) {
      logger.info(`▶️  Others left channel - playing ${audioQueue.queue.length} held response(s)`);
      audioQueue.playNext();
    }
  }
}

// ── Owner mute + join/leave ───────────────────────────────────────────────

export async function handleOwnerVoiceStateUpdate(oldState, newState, { allowedUsers, VOICE_CHANNEL_ID }) {
  if (newState.id !== allowedUsers[0]) return;

  const wasMuted = interactionState.ownerMuted;
  interactionState.ownerMuted = !!newState.selfMute;

  if (wasMuted !== interactionState.ownerMuted) {
    logger.info(`🎙️ Owner ${interactionState.ownerMuted ? 'MUTED' : 'UNMUTED'}`);
    const { audioQueue } = await import('../voice/tts-delivery.js');

    if (interactionState.ownerMuted) {
      if (MUTE_QUEUE_ENABLED) {
        muteQueueActivate();
        audioQueue.clear();
        logger.info(`🔇 Mute queue active - TTS will be queued until unmute`);
      } else {
        if (audioQueue && audioQueue.queue.length > 0 && !audioQueue.playing) {
          logger.info(`▶️  Owner muted - playing ${audioQueue.queue.length} held response(s)`);
          audioQueue.playNext();
        }
      }
    } else {
      if (MUTE_QUEUE_ENABLED && isMuteQueueActive()) {
        muteQueueDeactivate();
        const count = muteQueueCount();
        if (count > 0) {
          const summary = muteQueueSummary();
          if (summary) {
            logger.info(`🔊 Mute queue debrief: ${count} entries - offering summary`);
            const ctxBlock = muteQueueContext();
            if (ctxBlock) {
              const userId = allowedUsers[0];
              if (!conversations.has(userId)) conversations.set(userId, { history: [], lastActive: Date.now() });
              const conv = conversations.get(userId);
              conv.history.push({ role: 'assistant', content: ctxBlock });
              conv.lastActive = Date.now();
            }
            if (getState() !== 'ACTIVE') {
              transition('ACTIVE', 'mute-queue-debrief');
              interactionState.authenticatedSession = true;
            }
            resetIdleSleepTimer();
            if (MUTE_QUEUE_WAKE_BYPASS) {
              markBotResponse(allowedUsers[0], { followUpLikely: true });
              logger.info(`🎙️  Wake bypass active - unmute response does not require wake word`);
            }
            try {
              const audio = await synthesizeSpeech(summary);
              if (audio) audioQueue.add(audio);
            } catch (err) {
              logger.error('Mute queue debrief TTS failed:', err.message);
            }
            muteQueueClear();
          }
        } else {
          muteQueueDeactivate();
          if (UNMUTE_IMPLICIT_WAKE) {
            applyImplicitWakeOnUnmute(newState.id, (val) => { interactionState.authenticatedSession = val; });
          }
        }
      } else if (UNMUTE_IMPLICIT_WAKE) {
        applyImplicitWakeOnUnmute(newState.id, (val) => { interactionState.authenticatedSession = val; });
      }
    }
  }

  const joinedChannel = newState.channelId;
  const leftChannel = oldState.channelId;

  // Follow owner to new channel
  if (joinedChannel && joinedChannel !== voiceConn.channelId) {
    logger.info(`🔀 Owner moved to channel ${joinedChannel} - following`);
    let attempt = 0;
    const maxAttempts = 3;
    let joined = false;
    while (!joined && attempt < maxAttempts) {
      attempt++;
      try {
        await joinChannel(joinedChannel, { greeting: false });
        logger.info(`✅ Followed owner to ${joinedChannel}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        joined = true;
        if (process.env.RECORD_CHANNEL_ID && joinedChannel === process.env.RECORD_CHANNEL_ID) {
          startRecordMode(newState.id);
        }
      } catch (err) {
        if (attempt < maxAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          logger.error(`⚠️ Follow attempt ${attempt} failed: ${err.message} - retrying in ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          logger.error(`❌ Failed to follow owner after ${maxAttempts} attempts: ${err.message}`);
        }
      }
    }
  }

  // Owner joined a channel
  if (joinedChannel && (!leftChannel || leftChannel !== joinedChannel)) {
    interactionState.userDisconnected = false;
    logger.info(`👋 User joined voice channel ${joinedChannel}`);
    if (newState.serverMute) {
      logger.info('🔊 Clearing stale server mute on owner join...');
      serverMuteOwner(false);
    }
    if (UNMUTE_IMPLICIT_WAKE && !newState.selfMute) {
      applyImplicitWakeOnUnmute(newState.id, (val) => { interactionState.authenticatedSession = val; });
      logger.info(`🎙️ Implicit wake applied on join (owner joined unmuted)`);
    }
    if (process.env.RECORD_CHANNEL_ID && joinedChannel === process.env.RECORD_CHANNEL_ID) {
      if (recordMode._stopTimer) { clearTimeout(recordMode._stopTimer); recordMode._stopTimer = null; }
      if (!recordMode.active) startRecordMode(newState.id);
      return;
    }

    setTimeout(() => _onOwnerJoinedDebrief(newState, { allowedUsers }).catch(() => {}), 500);
  }

  // Owner left voice entirely
  if (leftChannel && !joinedChannel) {
    logger.info(`👋 User left voice entirely`);
    interactionState.userDisconnected = true;
    if (MUTE_QUEUE_ENABLED && isMuteQueueActive()) {
      muteQueueDeactivate();
      logger.info(`🔇 Mute queue deactivated on disconnect (${muteQueueCount()} entries held for reconnect)`);
    }
    if (recordMode.active) {
      recordMode._stopTimer = setTimeout(() => stopRecordMode(), 30000);
    }
    await endAllSessionPins();
    await handleVoiceDisconnect(newState.id);
  }
}

// ── Debrief on owner join ─────────────────────────────────────────────────

async function _onOwnerJoinedDebrief(newState, { allowedUsers }) {
  // Greeting
  try {
    const rawModel = process.env.VOICE_MODEL || 'anthropic-console/claude-sonnet-4-6';
    const modelLabel = rawModel
      .replace('google-gemini-cli/', '').replace('google/', '')
      .replace('anthropic/', '').replace('openai-codex/', '').replace('openai/', '')
      .replace('gemini-3-flash-preview', 'Gemini 3 Flash').replace('gemini-3-pro-preview', 'Gemini 3 Pro')
      .replace('gemini-2.5-pro', 'Gemini 2.5 Pro').replace('gemini-2.5-flash', 'Gemini 2.5 Flash')
      .replace('claude-sonnet-4-6', 'Claude Sonnet').replace('claude-opus-4-6', 'Claude Opus')
      .replace('claude-haiku-4-5', 'Claude Haiku').replace('gpt-5.3-codex', 'Codex');
    const persona = getActivePersona();
    const visualOn = isVisualModeEnabled();
    const modeLabel = visualOn ? 'Visual mode, at desk.' : 'Voice mode.';
    const greeting = `${persona.name} online. Using ${modelLabel}. ${modeLabel}`;
    if (visualOn) {
      const targetId = await resolveVisualChannel();
      await postToChannel(targetId, `🖥️ **${persona.name} online** — ${modelLabel}. Visual mode (at-desk).`);
    } else {
      const audio = await synthesizeSpeech(greeting);
      if (audio) { await playAudioEnhanced(audio); try { unlinkSync(audio); } catch {} }
    }
    resetIdleSleepTimer();
  } catch {}

  // Auto-brief active context
  try {
    const WEBHOOK_HOST = process.env.TAILSCALE_IP || process.env.ALERT_WEBHOOK_HOST || 'localhost';
    const WEBHOOK_PORT = process.env.ALERT_WEBHOOK_PORT || 3335;
    const WEBHOOK_BASE_URL = `http://${WEBHOOK_HOST}:${WEBHOOK_PORT}`;
    const WEBHOOK_TOKEN = process.env.ALERT_WEBHOOK_TOKEN || 'change-me';
    const res = await fetch(WEBHOOK_BASE_URL + '/context/active', {
      headers: { 'Authorization': `Bearer ${WEBHOOK_TOKEN}` },
    });
    if (res.ok) {
      const { context } = await res.json();
      if (context && context.summary) {
        logger.info(`📋 Active context detected from ${context.surface} - briefing user`);
        const briefMsg = `${context.topic ? context.topic + '. ' : ''}${context.summary.substring(0, 300)}`;
        const briefAudio = await synthesizeSpeech(briefMsg);
        if (briefAudio) {
          await playAudioEnhanced(briefAudio);
          try { unlinkSync(briefAudio); } catch {}
        }
        await fetch(WEBHOOK_BASE_URL + '/context/active', {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${WEBHOOK_TOKEN}` },
        });
      }
    }
  } catch (err) {
    logger.error(`⚠️ Failed to check active context: ${err.message}`);
  }

  if (hasPendingAlerts()) await briefPendingAlerts(newState.id, playAudioEnhanced);
  if (hasPendingHandoffs()) await briefPendingHandoffs(newState.id, playAudioEnhanced);

  if (shouldBrief()) {
    try {
      const briefingText = await generateBriefing();
      if (briefingText) {
        logger.info(`[briefing] Delivering join briefing: ${briefingText.substring(0, 80)}...`);
        markBriefingDelivered();
        const { audioQueue } = await import('../voice/tts-delivery.js');
        const briefAudio = await synthesizeSpeech(briefingText);
        if (briefAudio) {
          audioQueue.add(briefAudio);
          resetIdleSleepTimer();
        }
      } else {
        logger.info(`[briefing] Nothing to report - skipping`);
        markBriefingDelivered();
      }
    } catch (err) {
      logger.error(`[briefing] Failed: ${err.message}`);
    }
  }

  // Mute queue debrief on reconnect
  if (MUTE_QUEUE_ENABLED && muteQueueHasEntries()) {
    if (isMuteQueueActive()) muteQueueDeactivate();
    const count = muteQueueCount();
    const summary = muteQueueSummary();
    if (summary) {
      const { audioQueue } = await import('../voice/tts-delivery.js');
      logger.info(`🔊 Mute queue debrief on reconnect: ${count} entries`);
      const ctxBlock = muteQueueContext();
      if (ctxBlock) {
        const uid = newState.id;
        if (!conversations.has(uid)) conversations.set(uid, { history: [], lastActive: Date.now() });
        const conv = conversations.get(uid);
        conv.history.push({ role: 'assistant', content: ctxBlock });
        conv.lastActive = Date.now();
      }
      if (MUTE_QUEUE_WAKE_BYPASS) markBotResponse(newState.id, { followUpLikely: true });
      transition('ACTIVE', 'mute-queue-debrief-reconnect');
      interactionState.authenticatedSession = true;
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
}
