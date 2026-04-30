/**
 * task-processor.js — Background voice brain task processor.
 *
 * Extracted from src/index.js. Contains processBrainTask() which handles
 * the full lifecycle of a voice-dispatched brain task: ack generation,
 * intent routing (webhook/task-agent/inline streaming), TTS pipeline,
 * visual mode, thread routing, and conversation history update.
 */

import { unlinkSync } from 'fs';
import logger from '../logger.js';
import { synthesizeSpeech, splitIntoSentences, isTTSAvailable } from '../voice/tts.js';
import {
  generateResponseStreaming, generateContextualAck, trimForVoice,
  isGatewayCircuitOpen, dispatchViaWebhook, runTaskAgent, getActivePersona,
} from './brain.js';
import { TtsPipeline } from '../voice/tts-pipeline.js';
import { isTldrModeEnabled, isTranscriptModeEnabled } from '../tldr-mode.js';
import { isVisualModeEnabled } from '../visual-mode.js';
import { isMuteQueueActive, addEntry as muteQueueAdd } from '../state/mute-queue.js';
import {
  markStreaming, markWorking, markCompleted as ledgerMarkCompleted, markFailed, isJustAck,
} from '../agent/task-ledger.js';
import { hudTaskUpdate } from '../discord/hud.js';
import { postTaskToThread } from '../discord/thread-router.js';
import { touchFocus } from '../state/focus-state.js';
import { getRandomCachedAck, enforceOutputLength } from '../voice/speech-output.js';
import { markBotResponse, endConversationWindow } from '../voice/wakeword.js';
import { getState, transition } from '../state/bot-state.js';
import { detectFollowUpLikely, startTaskAutoSleep, cancelTaskAutoSleep, resetIdleSleepTimer } from '../state/fsm.js';
import { recordInlineSpoken } from '../alert-webhook.js';
import { emit as busEmit } from '../event-bus.js';
import { voiceTasks } from '../voice-tasks.js';
import {
  activeTasks, conversations, staleInlineTasks, visualAccumulator, briefingState,
  ttsDelivery,
} from '../state/runtime.js';
import { isGatewayHealthy } from '../gateway-health.js';
import { markTaskSpokeInline } from '../discord/dedup.js';
import { postToTextChannel, postToCC, postToChannel, postActivity, resolveVisualChannel, postTranscriptThread, truncate, formatForDiscord } from '../discord/posting.js';
import { scheduleFlushOnDrain, setTTSDeliveryActive } from '../voice/tts-delivery.js';
import { hasPendingAlerts } from '../alert-queue.js';
import { briefPendingAlerts } from './briefing.js';
import { _loadModelTriggers } from '../gateway-health.js';

const MUTE_QUEUE_ENABLED = process.env.MUTE_QUEUE_ENABLED === 'true';
const IMMEDIATE_ACKS_ENABLED = process.env.IMMEDIATE_ACKS_ENABLED === 'true';
const VOICE_ACK_ENABLED = process.env.VOICE_ACK_ENABLED === 'true';
const AGENT_DISPATCH_ACK_ENABLED = process.env.AGENT_DISPATCH_ACK_ENABLED !== 'false';
const VOICE_THREAD_REPORTS_ENABLED = process.env.VOICE_THREAD_REPORTS !== 'false';

const _isChatterbox = (process.env.TTS_PROVIDER || 'piper').toLowerCase() === 'chatterbox';
const _isKokoro = (process.env.TTS_PROVIDER || 'piper').toLowerCase() === 'kokoro';
const _isFastTTS = _isChatterbox || _isKokoro;
const TTS_PIPELINE_CONCURRENCY = parseInt(process.env.TTS_PIPELINE_CONCURRENCY ?? (_isChatterbox ? '2' : '3'));
const BATCH_FLUSH_MIN_CHARS = parseInt(process.env.TTS_BATCH_MIN_CHARS ?? '40');
const BATCH_FLUSH_MAX_CHARS = parseInt(process.env.TTS_BATCH_MAX_CHARS ?? (_isChatterbox ? '200' : _isFastTTS ? '400' : '150'));

const CONVERSATION_HISTORY_MAX = parseInt(process.env.CONVERSATION_HISTORY_MAX ?? '10000');
const CONVERSATION_HISTORY_MAX_CHARS = parseInt(process.env.CONVERSATION_HISTORY_MAX_CHARS ?? String(900000 * 4));

function trimHistory(history) {
  while (history.length > CONVERSATION_HISTORY_MAX) history.shift();
  let charCount = history.reduce((acc, m) => acc + (m.content || '').length, 0);
  while (charCount > CONVERSATION_HISTORY_MAX_CHARS && history.length > 1) {
    const removed = history.shift();
    charCount -= (removed.content || '').length;
  }
}

// ON_SCREEN sentence detection
function _isScreenSentence(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length > 120) return false;
  const lower = trimmed.toLowerCase();
  const patterns = [
    'on your screen', 'on your mac', 'on your desktop',
    'opening ', 'pulling up', 'pulled up', 'brought up', 'bringing up',
    "it's open", 'is open now',
  ];
  return patterns.some(p => lower.includes(p));
}

/**
 * Background brain task - runs concurrently, queues result for TTS
 */
export async function processBrainTask(taskId, userId, transcript, history, signal, brainOptions = {}, audioQueue, discordRef, GUILD_ID, VOICE_REPORT_CHANNEL_ID, interactionState) {
  const startTime = Date.now();
  let firstAudioLogged = false;
  let fullResponse = '';
  const tldrModeEnabled = isTldrModeEnabled();

  // Per-Task Model Override
  const lowerTranscript = transcript.toLowerCase();
  const _triggerMatch = _loadModelTriggers().find(t => t.phrases.some(p => lowerTranscript.includes(p)));
  if (_triggerMatch) {
    if (_triggerMatch.voiceAlias) brainOptions.model = _triggerMatch.voiceAlias;
    brainOptions.agentModel = _triggerMatch.agentEnvKey
      ? (process.env[_triggerMatch.agentEnvKey] || _triggerMatch.voiceAlias)
      : _triggerMatch.voiceAlias;
    logger.info(`🔄 Per-task model override → voice=${_triggerMatch.voiceAlias ?? '(none)'} agent=${brainOptions.agentModel}`);
  }

  try {
    if (isGatewayCircuitOpen()) {
      logger.warn(`🔴 Task #${taskId} - gateway circuit breaker is open, informing user`);
      const degradedMsg = "I'm having trouble reaching my brain at the moment. Give me a moment to recover.";
      try {
        const audio = await synthesizeSpeech(degradedMsg);
        if (audio) audioQueue.add(audio);
      } catch (_) {}
      await postToTextChannel(`⚠️ ${degradedMsg}`);
      postActivity(`🔴 **Task #${taskId}** skipped - gateway circuit breaker open`);
      return;
    }

    if (!isGatewayHealthy()) {
      logger.warn(`🟡 Task #${taskId} - gateway unhealthy, proceeding with caution`);
    }

    logger.info({ taskId, transcript: transcript.substring(0, 60), gatewayHealthy: isGatewayHealthy() }, '🧠 brain task processing');

    // Phase 1: Fast Ack
    if (IMMEDIATE_ACKS_ENABLED && VOICE_ACK_ENABLED) {
      const cachedAck = getRandomCachedAck();
      if (cachedAck) {
        audioQueue.add(cachedAck);
        logger.info('⚡ Playing cached ack');
      }
    }

    // Contextual dispatch ack (parallel with gateway request)
    let contextualAckPromise = null;
    if (AGENT_DISPATCH_ACK_ENABLED && !IMMEDIATE_ACKS_ENABLED) {
      contextualAckPromise = generateContextualAck(transcript).catch(err => {
        logger.warn(`⚠️ Contextual ack failed: ${err.message}`);
        return null;
      });
    }

    const intentType = brainOptions.intentType || 'QUERY';

    // TASK_AGENT routing
    if (process.env.TASK_AGENT_ENABLED === 'true' && brainOptions.budget?.taskAgent) {
      logger.info(`🤖 Task #${taskId} intent=${intentType} → task agent (isolated session)`);

      if (contextualAckPromise) {
        try {
          const ackText = await contextualAckPromise;
          if (ackText) {
            if (isVisualModeEnabled()) {
              const targetId = await resolveVisualChannel();
              const ch = discordRef.client?.channels?.cache?.get(targetId);
              if (ch?.sendTyping) ch.sendTyping().catch(() => {});
            } else {
              logger.info(`🎯 Task agent ack: "${ackText}"`);
              const ackAudio = await synthesizeSpeech(ackText);
              if (ackAudio) audioQueue.add(ackAudio);
            }
          }
        } catch (e) {
          logger.warn(`⚠️ Task agent ack failed: ${e.message}`);
        }
      }

      busEmit('BRAIN', `route=task-agent intent=${intentType} task=#${taskId}`, { userId, taskId });
      const taskResult = await runTaskAgent(transcript, { ...brainOptions, taskId, userId });

      if (taskResult.dispatched) {
        markWorking(taskId);
        hudTaskUpdate(taskId, 'working');
        postActivity(`🤖 **Task #${taskId}** routed to task agent (${intentType}) — awaiting /speak callback`);
        logger.info(`🤖 Task #${taskId} dispatched to isolated task agent`);
      } else {
        markFailed(taskId, taskResult.error);
        hudTaskUpdate(taskId, 'failed');
        logger.error(`❌ Task #${taskId} task agent dispatch failed: ${taskResult.error}`);
        const failMsg = "I'm having trouble dispatching that task right now, sir.";
        try {
          const audio = await synthesizeSpeech(failMsg);
          if (audio) audioQueue.add(audio);
        } catch (_) {}
        postActivity(`❌ **Task #${taskId}** task agent dispatch failed: ${taskResult.error}`);
      }
      return;
    }

    // ACTION Intent → Webhook Dispatch
    const actionIntents = new Set(['ACTION', 'EMAIL_ACTION', 'CALENDAR_ACTION']);
    if (actionIntents.has(intentType)) {
      logger.info(`🚀 Task #${taskId} intent=${intentType} → webhook dispatch (full tools)`);

      if (contextualAckPromise) {
        try {
          const ackText = await contextualAckPromise;
          if (ackText) {
            if (isVisualModeEnabled()) {
              const targetId = await resolveVisualChannel();
              const ch = discordRef.client?.channels?.cache?.get(targetId);
              if (ch?.sendTyping) ch.sendTyping().catch(() => {});
              logger.info(`🖥️ Visual ack: typing indicator (suppressed: "${ackText}")`);
            } else {
              logger.info(`🎯 Contextual dispatch ack: "${ackText}"`);
              const ackAudio = await synthesizeSpeech(ackText);
              if (ackAudio) audioQueue.add(ackAudio);
            }
          }
        } catch (e) {
          logger.warn(`⚠️ Contextual ack failed: ${e.message}`);
        }
      }

      const _activeVoiceModel = process.env.VOICE_MODEL || '';
      const _defaultDispatchModel = process.env.DISPATCH_MODEL || _activeVoiceModel;
      const _targetAgentModel = brainOptions.agentModel || _defaultDispatchModel;
      const dispatchOptions = { ...brainOptions, taskId, model: _targetAgentModel };
      busEmit('BRAIN', `route=webhook intent=${intentType} model=${_targetAgentModel} task=#${taskId}`, { userId, taskId });
      const webhookResult = await dispatchViaWebhook(transcript, history, dispatchOptions);

      if (webhookResult.dispatched) {
        markWorking(taskId);
        hudTaskUpdate(taskId, 'working');
        const dispatchSource = `gateway webhook (${_targetAgentModel})`;
        postActivity(`🚀 **Task #${taskId}** dispatched via ${dispatchSource} (${intentType}) - awaiting /speak callback`);
        logger.info(`📨 Task #${taskId} dispatched successfully - result will arrive via /speak`);
      } else {
        markFailed(taskId, webhookResult.error);
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

    // KNOWLEDGE Intent → Streaming TTS
    const ttsPipeline = new TtsPipeline(synthesizeSpeech, audioQueue, {
      maxConcurrent: TTS_PIPELINE_CONCURRENCY,
      onError: (err) => logger.error(`TTS pipeline error for task #${taskId}:`, err.message),
    });
    setTTSDeliveryActive(true);
    audioQueue.setGenerating(true);

    const BATCH_FLUSH_MIN = BATCH_FLUSH_MIN_CHARS;
    const BATCH_FLUSH_MAX = BATCH_FLUSH_MAX_CHARS;
    let batchText = '';
    let batchNum = 0;

    let lastFlushedText = '';
    const flushToPipeline = (text) => {
      text = trimForVoice(text.replace(/<p>/g, '').trim());
      if (!text || text.length < 2) return;
      if (/^\s*(NO_REPLY|HEARTBEAT_OK|NO)\s*[.!?]*\s*$/i.test(text)) return;
      const deduped = text.replace(/(.{8,}?[.!?])\s*\1/g, '$1');
      if (deduped !== text) {
        logger.info(`🔁 Deduped chunk: "${text.substring(0, 40)}" → "${deduped.substring(0, 40)}"`);
        text = deduped;
      }
      if (!text || text.length < 2) return;
      if (text === lastFlushedText) {
        logger.info(`⏭️  Skipping duplicate chunk: "${text.substring(0, 40)}"`);
        return;
      }
      lastFlushedText = text;

      if (MUTE_QUEUE_ENABLED && isMuteQueueActive()) {
        muteQueueAdd(text, 'task', 3);
        logger.info(`🔇 Chunk intercepted → mute queue (${text.length} chars)`);
        return;
      }

      batchNum++;
      logger.info(`🔊 Chunk #${batchNum}: ${text.length} chars → pipeline`);
      if (batchNum === 1) {
        markTaskSpokeInline(taskId);
        busEmit('TTS', `chunk #1 · ${text.length} chars · task=#${taskId}`, { taskId });
      }
      recordInlineSpoken(text);
      ttsPipeline.add(text);
    };

    const onScreenMode = process.env.ON_SCREEN || 'no_ack';
    busEmit('BRAIN', `route=inline intent=${intentType} task=#${taskId}`, { userId, taskId });
    const result = await generateResponseStreaming(transcript, history, signal, (sentence) => {
      sentence = trimForVoice(sentence);
      if (!sentence || sentence.length < 2) return;
      if (/^\s*_?(NO_?R?E?P?L?Y?|HEARTBEAT_?O?K?|NO)\s*[.!?]*\s*$/i.test(sentence)) return;
      if ((onScreenMode === 'no_ack' || onScreenMode === 'ack_post') && _isScreenSentence(sentence)) {
        logger.info(`🔇 ON_SCREEN=${onScreenMode} - suppressing inline: "${sentence.substring(0, 60)}"`);
        fullResponse += sentence + ' ';
        return;
      }

      fullResponse += sentence + ' ';

      if (!firstAudioLogged) {
        firstAudioLogged = true;
        const taskAgeMs = Date.now() - startTime;
        cancelTaskAutoSleep();
        markStreaming(taskId);
        hudTaskUpdate(taskId, 'streaming');
        logger.info(`⏱️  Task #${taskId} first sentence: ${taskAgeMs}ms`);

        const STALE_INLINE_MS = parseInt(process.env.STALE_INLINE_MS ?? '45000');
        if (taskAgeMs > STALE_INLINE_MS) {
          logger.warn(`⏭️  Task #${taskId} inline response STALE (${Math.round(taskAgeMs/1000)}s > ${STALE_INLINE_MS/1000}s threshold) — dropping TTS, /speak callback will deliver`);
          staleInlineTasks.add(taskId);
          return;
        }
      }

      if (staleInlineTasks.has(taskId)) return;

      logger.info(`📨 Task #${taskId} onSentence: "${sentence.substring(0, 60)}..." (${sentence.length} chars, tldr=${tldrModeEnabled}, disconnected=${interactionState.userDisconnected}, ttsAvail=${isTTSAvailable()}, visual=${isVisualModeEnabled()})`);

      if (isVisualModeEnabled()) {
        if (!visualAccumulator.has(taskId)) visualAccumulator.set(taskId, { chunks: [], startTime: Date.now(), editMsg: null, editLock: false });
        const acc = visualAccumulator.get(taskId);
        acc.chunks.push(sentence);

        const liveText = acc.chunks.join(' ').trim();
        const liveContent = `${liveText}\n\n⏳ *responding...*`;

        if (!acc.editLock) {
          acc.editLock = true;
          resolveVisualChannel().then(async targetChannelId => {
            try {
              if (!acc.editMsg) {
                acc.editMsg = await postToChannel(targetChannelId, liveContent.substring(0, 2000));
              } else {
                await acc.editMsg.edit({ content: liveContent.substring(0, 2000) }).catch(err => {
                  logger.warn(`[visual-mode] Edit failed: ${err.message}`);
                });
              }
            } finally {
              acc.editLock = false;
            }
          });
        }
        return;
      }

      if (!tldrModeEnabled) {
        if (interactionState.userDisconnected) {
          postToTextChannel(`🎙️ ${sentence}`);
        } else if (!isTTSAvailable()) {
          postToTextChannel(`🔇 ${sentence}`);
        } else {
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
            if (batchText.length > 0 && (batchText.length + sentence.length) > BATCH_FLUSH_MAX) {
              if (/[.!?]["''")\]]*\s*$/.test(batchText.trim())) {
                flushToPipeline(batchText);
                batchText = '';
              } else if (batchText.length > BATCH_FLUSH_MAX * 1.5) {
                flushToPipeline(batchText);
                batchText = '';
              }
            }
            batchText += sentence + ' ';
            const trimmedBatch = batchText.trim();
            const endsSentence = /[.!?]["''")\]]*\s*$/.test(trimmedBatch);
            if (batchText.length >= BATCH_FLUSH_MIN && endsSentence) {
              flushToPipeline(batchText);
              batchText = '';
            } else if (batchNum === 0 && endsSentence && batchText.length >= 10) {
              flushToPipeline(batchText);
              batchText = '';
            }
          }
        }
      }
    }, brainOptions);

    if (result.aborted) {
      markFailed(taskId, 'aborted');
      hudTaskUpdate(taskId, 'failed');
      visualAccumulator.delete(taskId);
      logger.info(`Task #${taskId} aborted`);
      ttsPipeline.clear();
      audioQueue.setGenerating(false);
      audioQueue.clear();
      setTTSDeliveryActive(false);
      scheduleFlushOnDrain();
      postActivity(`**Task #${taskId}** cancelled after ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
      return;
    }

    if (result.silent) {
      logger.info(`🤫 Task #${taskId} silent/NO_REPLY (${((Date.now() - startTime) / 1000).toFixed(1)}s) - sub-agent likely spawned`);
      visualAccumulator.delete(taskId);
      if (contextualAckPromise) {
        try {
          const ackText = await contextualAckPromise;
          if (ackText) {
            if (isVisualModeEnabled()) {
              const targetId = await resolveVisualChannel();
              const ch = discordRef.client?.channels?.cache?.get(targetId);
              if (ch?.sendTyping) ch.sendTyping().catch(() => {});
              logger.info(`🖥️ Visual ack: typing indicator (suppressed: "${ackText}")`);
            } else {
              logger.info(`🎯 Contextual dispatch ack: "${ackText}"`);
              const ackAudio = await synthesizeSpeech(ackText);
              if (ackAudio) audioQueue.add(ackAudio);
            }
            postActivity(`🎯 **Task #${taskId}** dispatch ack: "${ackText}"`);
          }
        } catch (e) {
          logger.warn(`⚠️ Contextual ack speak failed: ${e.message}`);
        }
      }
      postActivity(`**Task #${taskId}** silent (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
      return;
    }

    if (result.empty) {
      logger.info(`📭 Task #${taskId} empty response (${((Date.now() - startTime) / 1000).toFixed(1)}s) - sub-agent spawned, awaiting /speak callback`);
      visualAccumulator.delete(taskId);
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
      if (batchText.trim().length > 0) {
        flushToPipeline(batchText);
        batchText = '';
      }
      await ttsPipeline.drain();
      audioQueue.setGenerating(false);
      setTTSDeliveryActive(false);
      scheduleFlushOnDrain();
      return;
    }

    const intentCategory = brainOptions.intentType || 'QUERY';
    const isActionIntent = ['ACTION', 'EMAIL_ACTION', 'CALENDAR_ACTION'].includes(intentCategory);
    const gatewayActuallySpoke = batchNum > 0;
    if (isActionIntent && gatewayActuallySpoke && !result.silent && !result.empty) {
      logger.warn(`⚠️  HALLUCINATION DETECTED: Task #${taskId} intent=${intentCategory} but gateway returned text instead of spawning. User heard: "${fullResponse.substring(0, 100)}..."`);
      postActivity(`⚠️ **Task #${taskId}** possible hallucination - intent was ${intentCategory} but gateway spoke text instead of spawning a sub-agent.`);
    }

    logger.info(`📊 Task #${taskId} final flush check: batchText="${batchText.substring(0, 40)}..." (${batchText.trim().length} chars, tldr=${tldrModeEnabled}, disconnected=${interactionState.userDisconnected})`);
    if (batchText.trim().length > 0 && !tldrModeEnabled && !interactionState.userDisconnected) {
      flushToPipeline(batchText);
      batchText = '';
    }
    await ttsPipeline.drain();
    audioQueue.setGenerating(false);
    setTTSDeliveryActive(false);
    scheduleFlushOnDrain();

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const fullText = (result.text || fullResponse || '')
      .replace(/(?:^|\s)_?NO_?REPLY(?:\s|[.!?]|$)/gi, ' ')
      .replace(/(?:^|\s)HEARTBEAT_?OK(?:\s|[.!?]|$)/gi, ' ')
      .trim();
    logger.info(`💬 Task #${taskId} done (${Date.now() - startTime}ms): "${fullText.substring(0, 80)}..."`);

    // Visual mode: final edit with formatted text
    if (isVisualModeEnabled() && visualAccumulator.has(taskId)) {
      const acc = visualAccumulator.get(taskId);
      const rawSource = result.rawText || fullText;
      const formatted = formatForDiscord(rawSource);
      if (acc.editMsg && formatted) {
        const finalContent = formatted.substring(0, 2000);
        try {
          await acc.editMsg.edit({ content: finalContent });
          logger.info(`[visual-mode] Final edit for task #${taskId}: ${formatted.length} chars`);
        } catch (err) {
          logger.warn(`[visual-mode] Final edit failed, posting new: ${err.message}`);
          const targetId = await resolveVisualChannel();
          await postToChannel(targetId, finalContent);
        }
      } else if (formatted) {
        const targetId = await resolveVisualChannel();
        await postToChannel(targetId, formatted.substring(0, 2000));
      }
      visualAccumulator.delete(taskId);
    }

    // Post Jarvis response to CC
    if (fullText) {
      const cleanCC = fullText
        .replace(/<p>/g, '\n\n')
        .replace(/\.{2,}/g, '.')
        .replace(/\.\s*\n\n\s*\./g, '.\n\n')
        .replace(/\n\n\s*\.\s*/g, '\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      for (let i = 0; i < cleanCC.length; i += 1990) {
        postToCC('🤖', cleanCC.substring(i, i + 1990));
      }
    }

    if (tldrModeEnabled) enforceOutputLength(fullText, true);

    const TEXT_CHANNEL_ID = process.env.DISCORD_TEXT_CHANNEL_ID;
    const transcriptModeEnabled = isTranscriptModeEnabled();
    if (transcriptModeEnabled && !interactionState.userDisconnected && VOICE_THREAD_REPORTS_ENABLED) {
      logger.info(`📝 Full transcript mode enabled - posting conversation as thread (task #${taskId})`);
      await postTranscriptThread(taskId, transcript, fullText, duration);
    } else if (VOICE_REPORT_CHANNEL_ID && fullText && VOICE_THREAD_REPORTS_ENABLED) {
      const taskMeta = activeTasks.get(taskId);
      const iCat = taskMeta?.intentType || brainOptions.intentType || 'ACTION';
      logger.info(`📤 Posting task #${taskId} (${iCat}) to thread in channel ${VOICE_REPORT_CHANNEL_ID}`);
      const client = discordRef.client;
      if (client) {
        postTaskToThread(client, VOICE_REPORT_CHANNEL_ID, iCat, taskId, transcript, fullText, duration)
          .catch(err => logger.error(`[ThreadRouter] postTaskToThread failed for task #${taskId}: ${err.message}`));
      }
    }

    // Task Ledger: mark completion
    if (isJustAck(fullText)) {
      markWorking(taskId);
      hudTaskUpdate(taskId, 'working');
      logger.info(`📋 Task #${taskId} response was just an ack - marked WORKING, awaiting /speak callback`);
    } else {
      ledgerMarkCompleted(taskId, 'voice-streaming', fullText?.substring(0, 300));
      hudTaskUpdate(taskId, 'completed');
    }

    postActivity(`✅ **Task #${taskId}** complete (${duration}s)\n> ${truncate(fullText, 120)}`);
    touchFocus();

    if (fullText && fullText.length > 10) recordInlineSpoken(fullText);

    const conv = conversations.get(userId);
    if (conv) {
      conv.history.push({ role: 'assistant', content: fullText });
      trimHistory(conv.history);
    }

    audioQueue.waitForPlaybackDrained().then(() => {
      const followUp = detectFollowUpLikely(fullText);
      if (followUp) logger.info(`📋 Response invites follow-up - extending conversation window`);
      markBotResponse(userId, { followUpLikely: followUp });
      if (getState() === 'ACTIVE') resetIdleSleepTimer();
      startTaskAutoSleep();
    });

    const taskMeta = activeTasks.get(taskId);
    if (brainOptions.autoSleepAfterTask || taskMeta?.autoSleepAfterTask) {
      logger.info(`Auto-sleep: task #${taskId} complete with sign-off - transitioning to SLEEP`);
      transition('SLEEP', 'auto-sleep-after-task');
      interactionState.authenticatedSession = false;
      endConversationWindow(userId);
      postActivity(`😴 Auto-sleep after task #${taskId} (sign-off detected in request)`);
    }

    if (briefingState.pendingAlertBriefingForUser && hasPendingAlerts() && activeTasks.size === 0) {
      const uid = briefingState.pendingAlertBriefingForUser;
      briefingState.pendingAlertBriefingForUser = null;
      const { playAudioEnhanced } = await import('../voice/voice-receiver.js');
      setImmediate(() => briefPendingAlerts(uid, playAudioEnhanced));
    }

  } catch (err) {
    if (err.name !== 'AbortError') {
      markFailed(taskId, err.message);
      hudTaskUpdate(taskId, 'failed');
      logger.error(`❌ Task #${taskId} failed:`, err.message);
      postActivity(`❌ **Task #${taskId}** failed (${((Date.now() - startTime) / 1000).toFixed(1)}s): ${err.message}`);
      try {
        const audio = await synthesizeSpeech("I had trouble with that one. Try again?");
        if (audio) audioQueue.add(audio);
      } catch {}
    }
  } finally {
    activeTasks.delete(taskId);
    voiceTasks.delete(taskId);
    staleInlineTasks.delete(taskId);
  }
}
