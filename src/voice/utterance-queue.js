/**
 * utterance-queue.js — Utterance grouping / debounce before brain dispatch.
 *
 * Extracted from src/index.js. Merges rapid speech fragments from the same
 * user into a single dispatch. Handles Sonos/MCP mode commands at the voice
 * path, in-flight similarity dedup, and calls into processBrainTask.
 */

import logger from '../logger.js';
import { synthesizeSpeech } from './tts.js';
import { postActivity } from '../discord/posting.js';
import { transcriptSimilarity } from '../discord/dedup.js';
import { parseSonosModeCommand, setSonosMode, clearSonosMode, setSonosCtx, getSonosCtx, VOICE_SCOPE, isSonosModeEnabled, getLastSonosTarget } from '../sonos-mode.js';
import { parseMcpModeCommand, setMcpMode as setChannelMcpMode } from '../discord/channel-mcp-mode.js';
import { createTask } from '../agent/task-ledger.js';
import { hudTaskUpdate } from '../discord/hud.js';
import { classifyIntent } from '../brain/intent-classifier.js';
import { cancelTaskAutoSleep, isTaskAutoSleepArmed, startTaskAutoSleep } from '../state/fsm.js';
import { voiceTasks } from '../voice-tasks.js';
import { pendingUtterance, activeTasks, conversations, taskCounter, interactionState } from '../state/runtime.js';
import { truncate } from '../discord/posting.js';
import { isChannelOwner } from '../discord/channel-access.js';

// Re-export for external callers that import from here
export { flushPendingUtterance, queueUtterance };

const UTTERANCE_DEBOUNCE_MS = parseInt(process.env.UTTERANCE_DEBOUNCE_MS || '2000');
const INFLIGHT_SIMILARITY_THRESHOLD = parseFloat(process.env.INFLIGHT_SIMILARITY_THRESHOLD ?? '0.75');

// processBrainTask is imported lazily inside flushPendingUtterance to break
// the circular dependency chain (task-processor → utterance-queue → task-processor)
let _processBrainTask = null;
async function getProcessBrainTask() {
  if (!_processBrainTask) {
    const m = await import('../brain/task-processor.js');
    _processBrainTask = m.processBrainTask;
  }
  return _processBrainTask;
}

// audioQueue imported lazily to avoid circular dep
async function getAudioQueue() {
  const m = await import('./tts-delivery.js');
  return m.audioQueue;
}

async function flushPendingUtterance() {
  const { userId, parts, conv, speakerName, sentiment, autoSleepAfterTask } = pendingUtterance;
  pendingUtterance.timer = null;
  pendingUtterance.parts = [];
  pendingUtterance.userId = null;
  pendingUtterance.autoSleepAfterTask = false;

  if (!parts.length || !userId) return;

  const merged = parts.join(' ').trim();
  if (!merged) return;

  const audioQueue = await getAudioQueue();

  // Speaker mode command (voice path)
  const _voiceSonosCmd = parseSonosModeCommand(merged);
  if (_voiceSonosCmd) {
    const _voiceChan = process.env.DISCORD_VOICE_CHANNEL_ID || 'voice';
    if (_voiceSonosCmd.command === 'on') {
      audioQueue.clear();
      setSonosMode(_voiceChan, _voiceSonosCmd.target);
      const _ctx = { channelId: _voiceChan, threadId: 'main', taskId: 'mode-on', role: 'ack' };
      setSonosCtx(_ctx);
      const targetLabel = _voiceSonosCmd.target === 'up' ? 'bedroom' : _voiceSonosCmd.target === 'all' ? 'all speakers' : 'kitchen';
      const ack = `Speaker mode on, routing to ${targetLabel}.`;
      postActivity(`🔊 ${ack}`);
      try { const audio = await synthesizeSpeech(ack); if (audio) audioQueue.add(audio, _ctx); } catch {}
      return;
    } else if (_voiceSonosCmd.command === 'off') {
      audioQueue.clear();
      clearSonosMode(_voiceChan);
      const ack = 'Speaker mode off.';
      postActivity(`🔊 ${ack}`);
      try { const audio = await synthesizeSpeech(ack); if (audio) audioQueue.add(audio); } catch {}
      return;
    }
  }

  // MCP mode toggle (live voice path) — OWNER ONLY
  const _voiceMcpCmd = parseMcpModeCommand(merged);
  if (_voiceMcpCmd) {
    const { getAllowedUserIds } = await import('../allowed-users.js');
    const ALLOWED_USERS = getAllowedUserIds();
    if (!ALLOWED_USERS.includes(userId)) {
      logger.warn(`[mcp-mode] voice attempted by non-allowed userId=${userId} — denied`);
      return;
    }
    const _mcpVoiceChan = process.env.DISCORD_VOICE_CHANNEL_ID || 'voice';
    let ack = '';
    if (_voiceMcpCmd.mode === 'off') {
      setChannelMcpMode(_mcpVoiceChan, 'off');
      ack = 'MCP off. Fast path.';
    } else if (_voiceMcpCmd.mode === 'full' && _voiceMcpCmd.servers) {
      setChannelMcpMode(_mcpVoiceChan, _voiceMcpCmd.servers);
      ack = `MCP subset: ${_voiceMcpCmd.servers.join(', ')}.`;
    } else if (_voiceMcpCmd.mode === 'full') {
      setChannelMcpMode(_mcpVoiceChan, 'full');
      ack = 'Full MCP on. Notion, calendar, Slack, Trello, Linear, hivemind, maps available.';
    }
    postActivity(`🔧 ${ack}`);
    try { const audio = await synthesizeSpeech(ack); if (audio) audioQueue.add(audio); } catch {}
    return;
  }

  if (parts.length > 1) {
    logger.info(`🔗 Merged ${parts.length} utterances: "${merged.substring(0, 80)}..."`);
  }

  // In-flight similarity check
  if (activeTasks.size > 0) {
    for (const [inflightId, inflightTask] of activeTasks) {
      if (inflightTask.userId !== userId) continue;
      const sim = transcriptSimilarity(merged, inflightTask.transcript);
      if (sim >= INFLIGHT_SIMILARITY_THRESHOLD) {
        logger.info(`⏭️  In-flight task #${inflightId} covers this (similarity=${sim.toFixed(2)}) - absorbing duplicate: "${merged.substring(0, 60)}"`);
        postActivity(`⏭️ Absorbed duplicate (${(sim * 100).toFixed(0)}% similar to Task #${inflightId})\n> ${truncate(merged, 80)}`);
        return;
      }
    }
  }

  const taskId = ++taskCounter.value;
  const controller = new AbortController();
  activeTasks.set(taskId, { controller, transcript: merged, startTime: Date.now(), userId, autoSleepAfterTask });
  voiceTasks.set(taskId, { controller, transcript: merged, startTime: Date.now(), userId });

  setSonosCtx({
    channelId: process.env.DISCORD_VOICE_CHANNEL_ID || 'voice',
    threadId:  'main',
    taskId,
    role:      'response',
  });

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

  let _intentType = null;
  try {
    const classification = classifyIntent({ transcript: merged, speechDurationMs: 0, conversationDepth: conv ? conv.history.length : 0, isFollowUp: false, previousResponseType: null });
    if (classification?.type) {
      brainOptions.intentType = classification.type;
      brainOptions.budget = classification;
      _intentType = classification.type;
    }
  } catch (_) {}

  if (_intentType) {
    const taskEntry = activeTasks.get(taskId);
    if (taskEntry) taskEntry.intentType = _intentType;
  }

  // Get runtime deps (passed down from index.js via module-level state)
  const { discordRef } = await import('../state/runtime.js');
  const GUILD_ID = process.env.DISCORD_GUILD_ID;
  const VOICE_REPORT_CHANNEL_ID = process.env.VOICE_REPORT_CHANNEL_ID || process.env.DISCORD_TEXT_CHANNEL_ID;

  const processBrainTask = await getProcessBrainTask();
  processBrainTask(taskId, userId, merged, conv ? [...conv.history] : [], controller.signal, brainOptions, audioQueue, discordRef, GUILD_ID, VOICE_REPORT_CHANNEL_ID, interactionState)
    .catch(err => logger.error(`Task #${taskId} error:`, err.message));

  startTaskAutoSleep();
}

function queueUtterance(userId, transcript, conv, speakerName, sentiment) {
  if (isTaskAutoSleepArmed()) {
    cancelTaskAutoSleep();
    logger.info('⏱️  Task auto-sleep cancelled - user is steering');
  }

  if (pendingUtterance.timer && pendingUtterance.userId !== userId) {
    clearTimeout(pendingUtterance.timer);
    flushPendingUtterance();
  }

  pendingUtterance.userId = userId;
  pendingUtterance.parts.push(transcript);
  pendingUtterance.conv = conv;
  pendingUtterance.speakerName = speakerName;
  pendingUtterance.sentiment = sentiment;
  if (!pendingUtterance.startTime) pendingUtterance.startTime = Date.now();

  if (pendingUtterance.timer) clearTimeout(pendingUtterance.timer);
  pendingUtterance.timer = setTimeout(flushPendingUtterance, UTTERANCE_DEBOUNCE_MS);
}
