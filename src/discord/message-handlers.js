/**
 * message-handlers.js — Discord messageCreate handlers.
 *
 * Extracted from src/index.js. Contains:
 * - handleMentionReply
 * - handleCallbackMessage
 * - buildDiscordContextFromApi
 * - handleExplicitFocus
 * - handleAutoFocusUpdate
 * - handleVoiceTranscript
 * - checkIsReplyToUs
 */

import { unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';
import { transcribeWhisperOnly } from '../voice/stt.js';
import { synthesizeSpeech } from '../voice/tts.js';
import { generateTextResponse, generateTextResponseStreaming, trimForVoice } from '../brain/brain.js';
import { storeTaskToHaivemind, getChannelContext, storeChannelMemory } from '../agent/session-manager.js';
import { createTask, markCompleted as ledgerMarkCompleted, markFailed } from '../agent/task-ledger.js';
import { isHandoffCommand, resolveHandoff, parseVerboseCommand, parseAskModeCommand, parseMcpModeCommand, parseCrossChannelHandoff } from './handoff-resolver.js';
import { setMcpMode as setChannelMcpMode, getMcpMode as getChannelMcpMode } from './channel-mcp-mode.js';
import { postResumeCard } from './handoff-thread.js';
import { enableVerboseForThread, disableVerboseForThread, hasThreadVerboseOverride } from '../verbose-mode.js';
import { parseOrchestrationCommand, orchestrateThread } from './thread-orchestrator.js';
import { setAskMode } from './channel-ask-mode.js';
import { parseSonosModeCommand, setSonosMode, clearSonosMode, resetSonosCtx, sonosScopeKey, VOICE_SCOPE, isSonosModeEnabled, setSonosCtx } from '../sonos-mode.js';
import { createSchedule, listSchedules, deleteSchedule } from '../task-scheduler.js';
import { isSessionChannel, handleSessionMessage } from './slash/session.js';
import { isOwner as isChannelOwner } from './channel-access.js';
import { verboseSessions } from './verbose-sessions.js';
import { mentionSessions } from './mention-sessions.js';
import { isVerboseModeEnabled } from '../verbose-mode.js';
import { isDiscordMemoryReady, shouldServeDiscordMemoryForMessage, ensureDiscordHistoryLoaded } from './discord-memory.js';
import { searchHaivemind } from '../agent/session-manager.js';
import { postToTextChannel, postToChannel, resolveVisualChannel, _buildAttachmentContext, truncate } from './posting.js';
import { _processedMsgIds, transcriptSimilarity, isDuplicateContent } from './dedup.js';
import { splitIntoSentences, isTTSAvailable } from '../voice/tts.js';
import { discordRef, conversations, taskCounter, verboseThreads, interactionState } from '../state/runtime.js';

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

// ── Shared Discord context builder ────────────────────────────────────

export async function buildDiscordContextFromApi(message, limit = 10) {
  const client = discordRef.client;
  try {
    const ch = message.channel;
    const isThread = ch?.isThread?.();
    const threadName  = isThread ? ch.name : null;
    const parentName  = isThread ? (ch.parent?.name || ch.parentId) : null;
    const channelName = isThread ? `#${parentName} > thread: ${threadName}` : `#${ch.name}`;

    const fetched = await ch.messages.fetch({ limit, before: message.id });
    if (!fetched.size) return '';

    const myUsername = message.client.user?.username ?? 'Jarvis Voice';
    const lines = Array.from(fetched.values())
      .reverse()
      .map(m => {
        const isMe = m.author.bot && m.author.username === myUsername;
        const who = isMe ? 'You (assistant)' : m.author.username;
        const body = (m.content || '').substring(0, 400).replace(/\n/g, ' ');
        return `${who}: ${body}`;
      })
      .join('\n');

    const header = isThread
      ? `[Conversation history in Discord thread "${threadName}" inside ${parentName}. "You (assistant)" entries are your own prior replies:]`
      : `[Conversation history in ${channelName}. "You (assistant)" entries are your own prior replies:]`;

    return `${header}\n${lines}\n\n`;
  } catch (e) {
    logger.warn(`buildDiscordContextFromApi failed: ${e.message}`);
    return '';
  }
}

// ── Reply-to-us check ─────────────────────────────────────────────────

export async function checkIsReplyToUs(message) {
  const client = discordRef.client;
  if (!message.reference || !message.reference.messageId) return false;
  try {
    const repliedMsg = message.channel.messages.cache.get(message.reference.messageId) ||
                       await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (repliedMsg && repliedMsg.author.id === client.user.id) {
      return true;
    }
  } catch (e) {}
  return false;
}

// ── Webhook Callback Handler ──────────────────────────────────────────

export async function handleCallbackMessage(message, audioQueue, ALLOWED_USERS) {
  const text = message.content?.trim();
  if (!text) return;
  if (/^\s*(NO_REPLY|HEARTBEAT_OK)\s*$/i.test(text)) return;

  if (_processedMsgIds.has(message.id)) {
    logger.info(`⏭️  Dedup: skipping duplicate message ID ${message.id}`);
    return;
  }
  _processedMsgIds.add(message.id);

  if (isDuplicateContent(text)) {
    logger.info(`⏭️  Dedup: skipping duplicate content (${text.substring(0, 40)}...)`);
    return;
  }

  logger.info(`📩 Callback received (${text.length} chars, id: ${message.id}): "${text.substring(0, 80)}..."`);

  const voiceText = trimForVoice(text);
  if (!voiceText || voiceText.length < 2) return;

  const conv = conversations.get(ALLOWED_USERS[0]) || { history: [], lastActive: 0 };
  conv.history.push({ role: 'assistant', content: voiceText });
  trimHistory(conv.history);
  conv.lastActive = Date.now();
  conversations.set(ALLOWED_USERS[0], conv);

  if (!interactionState.userDisconnected) {
    const sentences = splitIntoSentences(voiceText);
    audioQueue.setGenerating(true);
    try {
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
    } finally {
      audioQueue.setGenerating(false);
    }

    const duration = ((Date.now() - interactionState.lastInteractionTime) / 1000).toFixed(1);
    logger.info(`💬 Callback spoken (${duration}s since request)`);
  } else {
    logger.info(`📝 Callback received but user not in voice - pinging in text channel`);
    const userId = ALLOWED_USERS[0];
    await postToTextChannel(`<@${userId}> 🎙️ **Voice task complete:**\n${voiceText}`);
  }
}

// ── Explicit Focus ────────────────────────────────────────────────────

export async function handleExplicitFocus(message, content) {
  const client = discordRef.client;
  const { setFocusById, setFocusByName, resolveChannel } = await import('../state/focus-state.js');

  let targetChannelId = null;
  let targetChannelName = null;

  const mentionMatch = content.match(/<#(\d+)>/);
  const nameMatch = content.match(/^\/(handoff|focus)\s+([^<#\s].+)/i);

  if (mentionMatch) {
    targetChannelId = mentionMatch[1];
    const ch = client.channels.cache.get(targetChannelId);
    targetChannelName = ch?.name || targetChannelId;
  } else if (nameMatch) {
    const query = nameMatch[2].replace(/^#/, '').trim();
    const resolved = resolveChannel(query);
    if (resolved) {
      targetChannelId = resolved.channelId;
      targetChannelName = resolved.channelName;
    } else {
      if (/^\d+$/.test(query)) {
        targetChannelId = query;
        const ch = client.channels.cache.get(query);
        targetChannelName = ch?.name || query;
      }
    }
  } else {
    targetChannelId = message.channelId;
    const ch = message.channel;
    if (ch?.isThread?.()) {
      targetChannelId = ch.parentId || message.channelId;
      targetChannelName = ch.parent?.name || targetChannelId;
    } else {
      targetChannelName = ch?.name || targetChannelId;
    }
  }

  if (targetChannelId) {
    const result = setFocusById(targetChannelId, targetChannelName);
    const ch = message.channel;
    if (ch?.isThread?.()) {
      const { setFocusWithThread } = await import('../state/focus-state.js');
      await setFocusWithThread(targetChannelName, ch.name);
    }
    const focusName = result?.channelName || targetChannelName;
    const ack = result?.threadName ? `🎯 Focused on **#${focusName}** › ${result.threadName}` : `🎯 Focused on **#${focusName}**`;
    await message.react('🎯').catch(() => {});
    await message.reply({ content: ack, allowedMentions: { repliedUser: false } }).catch(() => {});
    logger.info(`[chat-focus] Explicit focus set: #${focusName} (from Discord message)`);
  } else {
    await message.reply({ content: "Couldn't find that channel, sir.", allowedMentions: { repliedUser: false } }).catch(() => {});
  }
}

// ── Auto-Focus Update ─────────────────────────────────────────────────

export async function handleAutoFocusUpdate(message, content) {
  if (!interactionState.userDisconnected) return;
  if (content.startsWith('/')) return;

  const { resolveChannel, setFocusById } = await import('../state/focus-state.js');

  let registry;
  try {
    const { readFileSync } = await import('fs');
    registry = JSON.parse(readFileSync(process.env.CHANNEL_REGISTRY_PATH || `${process.env.HOME}/dev/contexts/channel-registry.json`, 'utf8'));
  } catch { registry = { channels: {} }; }

  const ch = message.channel;
  const isThread = ch?.isThread?.();
  const effectiveChannelId = isThread ? (ch.parentId || message.channelId) : message.channelId;
  const channelEntry = registry.channels?.[effectiveChannelId];

  if (channelEntry) {
    const { getFocus } = await import('../state/focus-state.js');
    const current = getFocus();

    const threadId = isThread ? ch.id : null;
    const needsUpdate = !current || current.channelId !== effectiveChannelId || current.threadId !== threadId;

    if (needsUpdate) {
      if (isThread) {
        const { setFocusWithThread } = await import('../state/focus-state.js');
        await setFocusWithThread(channelEntry.name, ch.name);
        logger.info(`[chat-focus] Auto-focus updated: #${channelEntry.name} › ${ch.name} (${effectiveChannelId}) from text activity`);
      } else {
        setFocusById(effectiveChannelId, channelEntry.name);
        logger.info(`[chat-focus] Auto-focus updated: #${channelEntry.name} (${effectiveChannelId}) from text activity`);
      }
    }
  }
}

// ── Voice Transcript Handler ──────────────────────────────────────────

export async function handleVoiceTranscript(message, audioQueue, GATEWAY_URL, GATEWAY_TOKEN) {
  const vmDedupKey = `vm:${message.id}`;
  if (_processedMsgIds.has(vmDedupKey)) {
    logger.info(`⏭️  Voice-msg dedup: skipping already-transcribed message ${message.id}`);
    return;
  }
  _processedMsgIds.add(vmDedupKey);

  const oggAttachment = message.attachments.find(a =>
    a.contentType?.includes('audio/ogg') || a.url?.endsWith('.ogg')
  );
  if (!oggAttachment) return;

  const __dirname = join(fileURLToPath(import.meta.url), '..', '..');

  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(oggAttachment.url);
    if (!response.ok) return;

    const tmpPath = join(__dirname, 'data', `voice-msg-${message.id}.ogg`);
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(tmpPath, buffer);

    let transcript;
    try {
      transcript = await transcribeWhisperOnly(tmpPath);
    } finally {
      try { unlinkSync(tmpPath); } catch {}
    }

    if (transcript && transcript.trim().length > 0) {
      const echoReply = await message.reply({ content: `🎙️ *"${transcript.trim()}"*`, allowedMentions: { repliedUser: false } });
      logger.info(`[voice-transcript] Transcribed voice message from ${message.author.username}: "${transcript.trim().substring(0, 60)}"`);

      const _vmSonosCmd = parseSonosModeCommand(transcript.trim());
      if (_vmSonosCmd) {
        if (!isChannelOwner(message.author.id)) {
          logger.warn(`[sonos] voice-msg attempted by non-owner ${message.author.id} — denied`);
          await message.reply('🔒 Speaker mode is owner-only.');
          return;
        }
        const _vmChan = sonosScopeKey(message.channel);
        if (_vmSonosCmd.command === 'on') {
          audioQueue.clear();
          setSonosMode(_vmChan, _vmSonosCmd.target);
          setSonosMode(VOICE_SCOPE, _vmSonosCmd.target);
          const targetLabel = _vmSonosCmd.target === 'up' ? 'bedroom' : _vmSonosCmd.target === 'all' ? 'all speakers' : 'kitchen';
          await message.reply(`Speaker mode on for this channel — routing responses to ${targetLabel}.`);
          return;
        } else if (_vmSonosCmd.command === 'off') {
          clearSonosMode(_vmChan);
          clearSonosMode(VOICE_SCOPE);
          resetSonosCtx();
          await message.reply('Speaker mode off for this channel.');
          return;
        }
      }

      const _vmMcpCmd = parseMcpModeCommand(transcript.trim());
      if (_vmMcpCmd) {
        if (!isChannelOwner(message.author.id)) {
          logger.warn(`[mcp-mode] voice-msg attempted by non-owner ${message.author.id} (${message.author.tag}) — denied`);
          await message.reply('🔒 MCP mode is owner-only.');
          return;
        }
        const _vmMcpId = message.channel?.isThread?.() ? message.channelId : (message.channel?.parentId || message.channelId);
        if (_vmMcpCmd.mode === 'off') {
          setChannelMcpMode(_vmMcpId, 'off');
          await message.reply('🔧 Full MCP **OFF** for this channel.');
        } else if (_vmMcpCmd.mode === 'full' && _vmMcpCmd.servers) {
          setChannelMcpMode(_vmMcpId, _vmMcpCmd.servers);
          await message.reply(`🔧 MCP subset enabled: **${_vmMcpCmd.servers.join(', ')}**.`);
        } else if (_vmMcpCmd.mode === 'full') {
          setChannelMcpMode(_vmMcpId, 'full');
          await message.reply('🔧 Full MCP **ON** for this channel. ~2-3s init per voice turn.');
        }
        return;
      }

      const _vmOrchParsed = parseOrchestrationCommand(transcript.trim());
      if (_vmOrchParsed) {
        if (!isChannelOwner(message.author.id)) {
          logger.warn(`[thread-orch] voice-msg attempted by non-owner ${message.author.id} — denied`);
          await message.reply('🔒 Thread orchestration is owner-only.');
          return;
        }
        try {
          await orchestrateThread(message, _vmOrchParsed, { gatewayUrl: GATEWAY_URL, gatewayToken: GATEWAY_TOKEN });
        } catch (err) {
          logger.error(`[voice-transcript] orchestrateThread threw: ${err.message}`);
          try { await message.reply(`Thread orchestration failed: ${err.message}`); } catch {}
        }
        return;
      }

      if (isSessionChannel(message.channelId) && isChannelOwner(message.author.id)) {
        handleSessionMessage({ ...message, content: transcript.trim() });
        return;
      }

      try {
        const text = transcript.trim();
        const vmTaskId = ++taskCounter.value;
        createTask(vmTaskId, text, message.author.id);

        setSonosCtx({
          channelId: sonosScopeKey(message.channel),
          threadId:  message.channel?.isThread?.() ? message.channelId : 'main',
          taskId:    vmTaskId,
          role:      'response',
        });

        let discordChatHistory = [];
        if (isDiscordMemoryReady() && shouldServeDiscordMemoryForMessage(message)) {
          const { history } = await ensureDiscordHistoryLoaded(message, discordRef.client.user.id);
          discordChatHistory = history;
        }
        const channelContext =
          discordChatHistory.length === 0 ? await buildDiscordContextFromApi(message, 10) : '';

        try { await storeTaskToHaivemind(vmTaskId, text, null); } catch (_) {}

        const _vmIsThread = message.channel?.isThread?.();
        const _vmParentId = _vmIsThread ? (message.channel.parentId || message.channelId) : message.channelId;
        const _vmThreadId = _vmIsThread ? message.channelId : null;
        const _vmSessionUser = _vmThreadId
          ? `agent:main:discord:channel:${_vmParentId}:thread:${_vmThreadId}`
          : `agent:main:discord:channel:${_vmParentId}`;
        const vmAttachCtx = await _buildAttachmentContext(message.attachments);
        const prompt = channelContext + text + vmAttachCtx;

        if (isVerboseModeEnabled(message.channelId) && _vmIsThread) {
          try {
            const { createLiveStream } = await import('../live-stream.js');
            const { getTextModel } = await import('../brain/brain.js');
            const { getChannelModel } = await import('../channel-models.js');
            const discordToken = process.env.DISCORD_TOKEN || '';
            const model = getChannelModel(message.channelId)
                       || getChannelModel(message.channel?.parentId)
                       || (() => { try { return getTextModel(); } catch { return 'claude'; } })();

            const _vmVerboseKey = message.channelId;
            let verboseChannelId = verboseThreads.get(_vmVerboseKey);
            let _vmJustCreated = false;
            if (!verboseChannelId) {
              if (_vmIsThread) {
                verboseChannelId = message.channelId;
              } else {
                const vmThread = await echoReply.startThread({
                  name: text.substring(0, 80) || 'voice response',
                  autoArchiveDuration: 60,
                });
                verboseChannelId = vmThread.id;
              }
              _vmJustCreated = true;
            } else {
              logger.info(`[voice-verbose] reusing thread ${verboseChannelId}`);
            }

            const ls = await createLiveStream(verboseChannelId, discordToken, { model });
            if (_vmJustCreated) {
              verboseThreads.set(_vmVerboseKey, verboseChannelId);
              logger.info(`[voice-verbose] created verbose thread ${verboseChannelId}`);
            }
            let fullText = '';
            try {
              await generateTextResponseStreaming(prompt, (chunk) => {
                fullText += chunk;
                ls.update(chunk);
              }, { channelId: _vmParentId, sessionUser: _vmSessionUser, discordChatHistory });
              if (!fullText || fullText.length < 2) {
                await ls.finishEmpty('sub_agent_spawned').catch(() => {});
              } else {
                await ls.finish(fullText);
                try { await storeTaskToHaivemind(vmTaskId, text, fullText.substring(0, 300)); } catch (_) {}
              }
              ledgerMarkCompleted(vmTaskId);
            } catch (streamErr) {
              logger.error(`[voice-transcript] verbose stream error: ${streamErr.message}`);
              if (ls.finishError) await ls.finishError(streamErr).catch(() => {});
              else ls.stop();
              markFailed(vmTaskId);
            }
            return;
          } catch (threadErr) {
            logger.error(`[voice-transcript] verbose thread error: ${threadErr.message}`);
          }
        }

        try {
          const result = await generateTextResponse(prompt, {
            channelId: _vmParentId,
            sessionUser: _vmSessionUser,
            discordChatHistory,
          });
          if (result && result.text && result.text.length >= 2) {
            try { await storeTaskToHaivemind(vmTaskId, text, result.text.substring(0, 300)); } catch (_) {}
            ledgerMarkCompleted(vmTaskId);
            if (result.text.length <= 2000) {
              await message.reply(result.text);
            } else {
              const chunks = result.text.match(/[\s\S]{1,1999}/g) || [];
              for (const c of chunks) await message.reply(c);
            }
            const _vmSonosChan = sonosScopeKey(message.channel);
            if (isSonosModeEnabled(_vmSonosChan)) {
              try {
                const spoken = result.text.length > 500 ? result.text.slice(0, 500) + '...' : result.text;
                const audio = await synthesizeSpeech(spoken);
                if (audio) audioQueue.add(audio, { channelId: _vmSonosChan });
              } catch (e) {
                logger.warn(`[sonos-mode] voice-transcript synth failed: ${e.message}`);
              }
            }
          } else {
            ledgerMarkCompleted(vmTaskId);
          }
        } catch (innerErr) {
          markFailed(vmTaskId);
          logger.error("Voice text response error: " + innerErr.message);
        }
      } catch (e) {
        logger.error("Voice task setup error: " + e.message);
      }
    }
  } catch (err) {
    logger.warn(`[voice-transcript] Failed to transcribe voice message: ${err.message}`);
  }
}

// ── @Mention / Reply Handler ──────────────────────────────────────────

export async function handleMentionReply(message, rawContent, isReplyToUs, audioQueue, GATEWAY_URL, GATEWAY_TOKEN, ALLOWED_USERS) {
  const client = discordRef.client;
  const content = rawContent
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();

  if (!content) return;

  let discordChatHistory = [];
  if (isDiscordMemoryReady() && shouldServeDiscordMemoryForMessage(message)) {
    const { history } = await ensureDiscordHistoryLoaded(message, client.user.id);
    discordChatHistory = history;
  }
  const recentContext =
    discordChatHistory.length === 0 ? await buildDiscordContextFromApi(message, 10) : '';

  let repliedContentContext = '';
  if (isReplyToUs && message.reference) {
    try {
      const repliedMsg = message.channel.messages.cache.get(message.reference.messageId);
      if (repliedMsg) {
         repliedContentContext = `[Context: User is replying to this previous message from you: "${repliedMsg.content}"]\n\n`;
      }
    } catch (e) {}
  }

  const attachmentCtx = await _buildAttachmentContext(message.attachments);

  const _mentionParentId = message.channel?.isThread?.()
    ? (message.channel.parentId || message.channelId)
    : message.channelId;

  const [hmMemory, chMemory] = await Promise.all([
    isChannelOwner(message.author.id) ? searchHaivemind(content.substring(0, 100)) : Promise.resolve(null),
    getChannelContext(_mentionParentId),
  ]);
  const memoryBlock = [hmMemory, chMemory].filter(Boolean).join('\n---\n');
  const memoryPrefix = memoryBlock
    ? `[BACKGROUND CONTEXT — do NOT respond to this, use only as reference]\n${memoryBlock}\n[END BACKGROUND CONTEXT — respond only to the user message below]\n\n`
    : '';

  const { getFocus, getFocusContextTag } = await import('../state/focus-state.js');
  const _mentionFocus = getFocus();
  const _mentionInFocus = _mentionFocus &&
    (_mentionFocus.channelId === _mentionParentId || _mentionFocus.channelId === message.channelId);
  const _focusTag = _mentionInFocus ? (getFocusContextTag() || '') : '';

  const _workspacePrefix = [
    message._workspaceContext || '',
    _focusTag,
  ].filter(Boolean).join('\n\n') + (message._workspaceContext || _focusTag ? '\n\n' : '');
  const finalPrompt = `${_workspacePrefix}${memoryPrefix}${recentContext}${repliedContentContext}${content}${attachmentCtx}`;

  setSonosCtx({
    channelId: sonosScopeKey(message.channel),
    threadId:  message.channel?.isThread?.() ? message.channelId : 'main',
    taskId:    null,
    role:      'response',
  });

  logger.info(`@mention/reply from ${message.author.tag} in #${message.channel.name}: "${content.substring(0, 80)}"`);
  if (message._workspaceContext) logger.info(`[session-setup] workspace context injected: ${message._workspaceContext}`);

  const _askCmd = parseAskModeCommand(content);
  if (_askCmd) {
    if (!isChannelOwner(message.author.id)) {
      logger.warn(`[ask-mode] @mention attempted by non-owner ${message.author.id} (${message.author.tag}) — denied`);
      await message.reply('🔒 Ask-mode toggle is owner-only.');
      return;
    }
    const _askId = message.channel?.isThread?.() ? message.channelId : (message.channel?.parentId || message.channelId);
    setAskMode(_askId, _askCmd.ask);
    await message.reply(_askCmd.ask
      ? '🔒 Ask-only mode **ON** for this channel. I\'ll read, think, and answer — no edits, no shell.'
      : '🔓 Ask-only mode **OFF** for this channel. Full tool access restored.');
    return;
  }

  const _mcpCmd = parseMcpModeCommand(content);
  if (_mcpCmd) {
    if (!isChannelOwner(message.author.id)) {
      logger.warn(`[mcp-mode] @mention attempted by non-owner ${message.author.id} (${message.author.tag}) — denied`);
      await message.reply('🔒 MCP mode is owner-only.');
      return;
    }
    const _mcpId = message.channel?.isThread?.() ? message.channelId : (message.channel?.parentId || message.channelId);
    if (_mcpCmd.mode === 'off') {
      setChannelMcpMode(_mcpId, 'off');
      await message.reply('🔧 Full MCP **OFF** for this channel. Fast path restored (intent pre-fetch only).');
    } else if (_mcpCmd.mode === 'full' && _mcpCmd.servers) {
      setChannelMcpMode(_mcpId, _mcpCmd.servers);
      await message.reply(`🔧 MCP subset enabled: **${_mcpCmd.servers.join(', ')}** (~${_mcpCmd.servers.length}s init per turn).`);
    } else if (_mcpCmd.mode === 'full') {
      setChannelMcpMode(_mcpId, 'full');
      await message.reply('🔧 Full MCP **ON** for this channel. Notion, Google Workspace, Slack, Trello, Linear, hAIveMind available. ~2-3s init per voice turn.');
    }
    return;
  }

  const _verboseCmd = parseVerboseCommand(content);
  if (_verboseCmd && message.channel?.isThread?.()) {
    if (!isChannelOwner(message.author.id)) {
      logger.warn(`[verbose] @mention attempted by non-owner ${message.author.id} — denied`);
      await message.reply('🔒 Verbose toggle is owner-only.');
      return;
    }
    if (_verboseCmd.verbose) {
      enableVerboseForThread(message.channelId);
      await message.reply('Verbose mode on for this thread. Live-streaming from here out.');
    } else {
      disableVerboseForThread(message.channelId);
      await message.reply('Verbose mode off for this thread.');
    }
    return;
  }

  if (isHandoffCommand(content)) {
    if (!isChannelOwner(message.author.id)) {
      logger.warn(`[handoff] @mention attempted by non-owner ${message.author.id} — denied`);
      await message.reply('🔒 Handoff is owner-only.');
      return;
    }
    const parent = message.channel?.isThread?.() ? (message.channel.parent || message.channel) : message.channel;
    const info = resolveHandoff(message);
    if (!info) {
      await message.reply("No active session for this channel yet — ask me something first, then hand off.");
      return;
    }
    try {
      await postResumeCard(parent, info);
      await message.reply(`Handed off — see 🔗 Handoff thread.`);
    } catch (err) {
      logger.warn(`[handoff] failed: ${err.message}`);
      await message.reply(`Handoff failed: ${err.message}`);
    }
    return;
  }

  const _xHandoff = parseCrossChannelHandoff(content);
  if (_xHandoff) {
    if (!isChannelOwner(message.author.id)) {
      await message.reply('🔒 Cross-channel handoff is owner-only.');
      return;
    }
    const { targetChannelId } = _xHandoff;
    try {
      const targetChannel = await message.client.channels.fetch(targetChannelId).catch(() => null);
      if (!targetChannel?.isTextBased?.()) {
        await message.reply("Can't find that channel or it's not a text channel.");
        return;
      }
      const srcName = message.channel?.name || message.channelId;

      const [recentMsgs, hmCtx] = await Promise.all([
        buildDiscordContextFromApi(message, 20),
        getChannelContext(message.channelId),
      ]);

      let summary = null;
      try {
        const summaryPrompt = [
          `Summarize the conversation below into a compact handoff card (5-8 bullets, under 800 chars total).`,
          `Cover: what was researched/worked on, key findings, and what to do next.`,
          `Do not include preamble — output only the bullet list.\n`,
          recentMsgs || '',
          hmCtx ? `\nRecent memory: ${hmCtx}` : '',
        ].join('\n');
        const _parentChannelId = message.channel?.isThread?.() ? (message.channel.parentId || message.channelId) : message.channelId;
        const { generateTextResponse: gtr } = await import('../brain/brain.js');
        const sr = await gtr(summaryPrompt, { channelId: _parentChannelId, skipChannelContext: true });
        if (sr?.text && sr.text.length > 20) summary = sr.text.trim();
      } catch (_) {}

      const cardBody = summary || (recentMsgs || '*(no recent messages)*').substring(0, 1400);
      const card = `📎 **Continued from #${srcName}**\n\n${cardBody}`.substring(0, 1900);

      await targetChannel.send(card);
      await storeChannelMemory(targetChannelId, `Handoff from #${srcName}`, cardBody.substring(0, 400));

      logger.info(`[cross-handoff] posted context card from #${srcName} → #${targetChannel.name || targetChannelId}`);
      await message.reply(`📎 Context card posted to <#${targetChannelId}>. Continue there.`);
    } catch (err) {
      logger.warn(`[cross-handoff] failed: ${err.message}`);
      await message.reply(`Handoff failed: ${err.message}`);
    }
    return;
  }

  const _orchParsed = parseOrchestrationCommand(content);
  if (_orchParsed) {
    if (!isChannelOwner(message.author.id)) {
      logger.warn(`[thread-orch] @mention attempted by non-owner ${message.author.id} — denied`);
      await message.reply('🔒 Thread orchestration is owner-only.');
      return;
    }
    try {
      await orchestrateThread(message, _orchParsed, { gatewayUrl: GATEWAY_URL, gatewayToken: GATEWAY_TOKEN });
    } catch (err) {
      logger.error(`[@mention] orchestrateThread threw: ${err.message}`);
      try { await message.reply(`Thread orchestration failed: ${err.message}`); } catch {}
    }
    return;
  }

  if (message.channel?.isThread?.() && !hasThreadVerboseOverride(message.channelId)) {
    enableVerboseForThread(message.channelId);
  }

  const _sonosCmd = parseSonosModeCommand(content);
  if (_sonosCmd) {
    if (!isChannelOwner(message.author.id)) {
      logger.warn(`[sonos] @mention attempted by non-owner ${message.author.id} — denied`);
      await message.reply('🔒 Speaker mode is owner-only.');
      return;
    }
    const _sonosChan = sonosScopeKey(message.channel);
    if (_sonosCmd.command === 'on') {
      audioQueue.clear();
      setSonosMode(_sonosChan, _sonosCmd.target);
      setSonosMode(VOICE_SCOPE, _sonosCmd.target);
      const targetLabel = _sonosCmd.command === 'on' ? (_sonosCmd.target === 'up' ? 'bedroom' : _sonosCmd.target === 'all' ? 'all speakers' : 'kitchen') : '';
      await message.reply(`Speaker mode on for this channel — routing responses to ${targetLabel}.`);
      return;
    } else if (_sonosCmd.command === 'off') {
      clearSonosMode(_sonosChan);
      clearSonosMode(VOICE_SCOPE);
      resetSonosCtx();
      await message.reply('Speaker mode off for this channel.');
      return;
    }
  }

  // Scheduler intent dispatch
  function _inferScheduleMode(prompt) {
    const p = prompt.toLowerCase();
    const urlMatch = prompt.match(/https?:\/\/[^\s]+/) || prompt.match(/\b(\w[\w.-]+):(\d{2,5})\b/);
    if (urlMatch) {
      const url = urlMatch[0].includes('://') ? urlMatch[0] : `http://${urlMatch[0]}`;
      const cleanUrl = url.replace(/[.,;!?]$/, '');
      return { mode: 'shell', shellCmd: `curl -sf --max-time 10 ${cleanUrl} -o /dev/null && echo "up" || echo "down"` };
    }
    if (/\b(is\s+)?(serving|up|running|healthy|live|responding|available)\b/.test(p) && /\b(server|service|api|endpoint|port\s+\d+)\b/.test(p)) {
      const hpMatch = prompt.match(/\b([\w.-]+):(\d{2,5})\b/);
      if (hpMatch) return { mode: 'shell', shellCmd: `curl -sf --max-time 10 http://${hpMatch[0]}/health -o /dev/null && echo "up" || echo "down"` };
    }
    const portMatch = prompt.match(/port\s+(\d+)\s+(?:on\s+)?([\w.-]+)/i) || prompt.match(/([\w.-]+)\s+port\s+(\d+)/i);
    if (portMatch) {
      const [host, port] = portMatch[1] > portMatch[2] ? [portMatch[2], portMatch[1]] : [portMatch[1], portMatch[2]];
      return { mode: 'shell', shellCmd: `nc -z -w5 ${host} ${port} && echo "port ${port} open" || echo "port ${port} closed"` };
    }
    if (/\b(disk|storage|df)\b/.test(p)) return { mode: 'shell', shellCmd: 'df -h | grep -v tmpfs' };
    if (/\b(memory|ram|free)\b/.test(p)) return { mode: 'shell', shellCmd: 'free -h' };
    if (/\b(cpu|load|uptime)\b/.test(p)) return { mode: 'shell', shellCmd: 'uptime' };
    if (/\b(processes?|top\s+processes?|who)\b/.test(p)) return { mode: 'shell', shellCmd: 'ps aux --sort=-%cpu | head -10' };
    const procMatch = prompt.match(/\bis\s+([\w-]+)\s+(process\s+)?running\b/i) || prompt.match(/\b([\w-]+)\s+(process\s+)?running\b/i);
    if (procMatch) {
      const proc = procMatch[1];
      return { mode: 'shell', shellCmd: `pgrep -x ${proc} && echo "${proc} running" || echo "${proc} not found"` };
    }
    return { mode: 'llm', shellCmd: null };
  }

  const _isRecurringCheck =
    /every\s+\d+\s*(second|minute|hour|min|sec|s|m|h)s?/i.test(content) &&
    /(check|monitor|watch|run|poll|ping|test)\b/i.test(content);
  const _isListSchedules = /\b(list|show|what)\b.{0,30}\bschedules?\b/i.test(content) ||
    /\bschedules?\s+(are\s+)?(running|active|pending)\b/i.test(content);
  const _isDeleteSchedule = /\b(stop|cancel|remove|delete)\b.{0,30}\bschedule\b/i.test(content);

  if (_isRecurringCheck) {
    const intervalMatch = content.match(/every\s+(\d+)\s*(second|minute|hour|min|sec|s|m|h)s?/i);
    let intervalMs = 5 * 60 * 1000;
    if (intervalMatch) {
      const n = parseInt(intervalMatch[1]);
      const unit = intervalMatch[2].toLowerCase();
      if (unit.startsWith('s')) intervalMs = n * 1000;
      else if (unit.startsWith('m')) intervalMs = n * 60 * 1000;
      else if (unit.startsWith('h')) intervalMs = n * 60 * 60 * 1000;
    }
    const untilMatch = content.match(/until\s+(.+?)(?:\.|$)/i);
    let terminationPhrase = untilMatch ? untilMatch[1].trim() : null;
    let maxRuns = 0;
    const forMatch = content.match(/for\s+(?:the\s+next\s+)?(\d+)\s*(second|minute|hour|min|sec|s|m|h)s?/i);
    if (forMatch) {
      const n = parseInt(forMatch[1]);
      const u = forMatch[2].toLowerCase();
      let durationMs;
      if (u.startsWith('s')) durationMs = n * 1000;
      else if (u.startsWith('m')) durationMs = n * 60 * 1000;
      else if (u.startsWith('h')) durationMs = n * 60 * 60 * 1000;
      maxRuns = Math.max(1, Math.floor(durationMs / intervalMs));
      if (terminationPhrase && /^\d+\s*(hour|minute|min|second|sec|h|m|s)/i.test(terminationPhrase)) terminationPhrase = null;
    }
    const corePrompt = content
      .replace(/every\s+\d+\s*(second|minute|hour|min|sec|s|m|h)s?/gi, '')
      .replace(/for\s+(?:the\s+next\s+)?\d+\s*(second|minute|hour|min|sec|s|m|h)s?/gi, '')
      .replace(/until\s+.+?(?:\.|$)/gi, '')
      .replace(/^(check|monitor|watch|run|ping|poll)\s+/i, '')
      .trim();
    const { mode: _schedMode, shellCmd: _shellCmd } = _inferScheduleMode(corePrompt || content);
    const sched = createSchedule({
      prompt: corePrompt || content,
      intervalMs,
      channelId: message.channelId,
      userId: message.author.id,
      terminationPhrase,
      maxRuns,
      mode: _schedMode,
      model: 'haiku',
      shellCmd: _shellCmd,
    });
    const humanInterval = intervalMs < 60000 ? `${intervalMs/1000}s` : `${intervalMs/60000}m`;
    const suffix = terminationPhrase ? ` until "${terminationPhrase}"` : maxRuns > 0 ? ` (${maxRuns} runs)` : '';
    const modeTag = _schedMode === 'shell' ? ' ⚡ shell' : ' 🤖 haiku';
    await message.reply(`✅ Scheduled — will run every ${humanInterval}${suffix}${modeTag}. ID: \`${sched.id}\``);
    return;
  }

  if (_isListSchedules) {
    const all = listSchedules();
    if (all.length === 0) {
      await message.reply('No active schedules.');
    } else {
      const lines = all.map(s => `• \`${s.id}\` — every ${s.intervalMs/60000}m — "${s.prompt.substring(0,60)}..." (runs: ${s.runCount})`);
      await message.reply(lines.join('\n'));
    }
    return;
  }

  if (_isDeleteSchedule) {
    const idMatch = content.match(/\bsched_\S+/);
    if (idMatch) {
      deleteSchedule(idMatch[0]);
      await message.reply(`✅ Schedule \`${idMatch[0]}\` removed.`);
    } else if (/all\s+schedule/i.test(content)) {
      const all = listSchedules();
      all.forEach(s => deleteSchedule(s.id));
      await message.reply(`✅ Removed ${all.length} schedule(s).`);
    } else {
      await message.reply('Which schedule? Say the ID (e.g. `sched_xxx`) or "stop all schedules".');
    }
    return;
  }

  try { await message.channel.sendTyping(); } catch (_) {}

  const _isThread = message.channel?.isThread?.();
  const _parentChannelId = _isThread ? (message.channel.parentId || message.channelId) : message.channelId;
  const _threadId = _isThread ? message.channelId : null;
  const _sessionUser = _threadId
    ? `agent:main:discord:channel:${_parentChannelId}:thread:${_threadId}`
    : `agent:main:discord:channel:${_parentChannelId}`;

  if (isVerboseModeEnabled(message.channelId) && _isThread) {
    try {
      const { createLiveStream } = await import('../live-stream.js');
      const { getTextModel } = await import('../brain/brain.js');
      const { getChannelModel } = await import('../channel-models.js');
      const discordToken = process.env.DISCORD_TOKEN || '';
      const model = getChannelModel(message.channelId)
                 || getChannelModel(message.channel?.parentId)
                 || (() => { try { return getTextModel(); } catch { return 'claude'; } })();

      const _verboseKey = message.channelId;
      let threadId = verboseThreads.get(_verboseKey);
      let justCreated = false;
      if (!threadId) {
        if (_isThread) {
          threadId = message.channelId;
        } else {
          const thread = await message.startThread({
            name: content.substring(0, 80) || 'response',
            autoArchiveDuration: 60,
          });
          threadId = thread.id;
        }
        justCreated = true;
      } else {
        logger.info(`[@mention] reusing verbose thread ${threadId}`);
      }

      const ls = await createLiveStream(threadId, discordToken, { model });
      if (justCreated) {
        verboseThreads.set(_verboseKey, threadId);
        logger.info(`[@mention] created verbose thread ${threadId} for key ${_verboseKey}`);
      }
      const ac = new AbortController();
      verboseSessions.set(_parentChannelId, { ac, ls });
      let fullText = '';
      try {
        await generateTextResponseStreaming(finalPrompt, (chunk) => {
          if (ac.signal.aborted) return;
          fullText += chunk;
          ls.update(chunk);
        }, {
          channelId: _parentChannelId,
          sessionUser: _sessionUser,
          discordChatHistory,
          skipChannelContext: true,
        });
        if (ac.signal.aborted) {
          verboseSessions.delete(_parentChannelId);
          return;
        }
        if (!fullText || fullText.length < 2) {
          await ls.finishEmpty('sub_agent_spawned').catch(() => {});
          verboseSessions.delete(_parentChannelId);
          logger.info(`@mention: empty response — thread kept with no-response marker`);
          return;
        }
        await ls.finish(fullText);
        logger.info(`@mention: verbose stream complete (${fullText.length} chars)`);
      } catch (streamErr) {
        logger.error(`@mention verbose stream error: ${streamErr.message}`);
        if (ls.finishError) {
          await ls.finishError(streamErr).catch(() => {});
        } else {
          ls.stop();
        }
      } finally {
        verboseSessions.delete(_parentChannelId);
      }
      return;
    } catch (threadErr) {
      logger.error(`@mention verbose thread error: ${threadErr.message}`);
    }
  }

  const _mentionAc = new AbortController();
  mentionSessions.set(_parentChannelId, _mentionAc);
  try {
    const result = await generateTextResponse(finalPrompt, {
      channelId: _parentChannelId,
      sessionUser: _sessionUser,
      discordChatHistory,
      skipChannelContext: true,
    });

    mentionSessions.delete(_parentChannelId);

    if (_mentionAc.signal.aborted) {
      logger.info(`@mention: reply suppressed — /stop issued during fetch`);
      return;
    }

    if (!result.text || result.text.length < 2) {
      logger.info(`@mention: empty response (sub-agent likely spawned)`);
      return;
    }

    const response = result.text;
    if (response.length <= 2000) {
      await message.reply(response);
    } else {
      const chunks = [];
      let remaining = response;
      while (remaining.length > 0) {
        if (remaining.length <= 2000) { chunks.push(remaining); break; }
        let splitAt = remaining.lastIndexOf('\n\n', 2000);
        if (splitAt < 500) splitAt = remaining.lastIndexOf('\n', 2000);
        if (splitAt < 500) splitAt = 2000;
        chunks.push(remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt).trimStart();
      }
      await message.reply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await message.channel.send(chunks[i]);
      }
    }

    logger.info(`@mention: replied (${response.length} chars)`);

    const _mentionChan = sonosScopeKey(message.channel);
    if (isSonosModeEnabled(_mentionChan)) {
      try {
        const spoken = response.length > 500 ? response.slice(0, 500) + '...' : response;
        const audio = await synthesizeSpeech(spoken);
        if (audio) audioQueue.add(audio, { channelId: _mentionChan });
      } catch (e) {
        logger.warn(`[sonos-mode] @mention synth failed: ${e.message}`);
      }
    }
  } catch (err) {
    mentionSessions.delete(_parentChannelId);
    logger.error(`@mention handler error:`, err.message);
    try {
      await message.reply("Having trouble processing that right now, sir.");
    } catch (_) {}
  }
}
