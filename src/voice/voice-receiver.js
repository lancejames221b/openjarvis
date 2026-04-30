/**
 * voice-receiver.js — Voice connection setup, speech processing, and audio playback.
 *
 * Extracted from src/index.js. Contains:
 * - joinChannel: voice channel connection, receiver, barge-in
 * - handleSpeech: full STT → wake word → FSM → dispatch pipeline
 * - handleVoiceDisconnect: task cleanup + handoff on user disconnect
 * - playGreeting: initial greeting on channel join
 * - startRecordMode / stopRecordMode / handleRecordModeSpeech
 * - prependSilence: BT silence padding
 * - savePcmAsWav: PCM → WAV conversion
 * - playAudioEnhanced: Sonos routing + Discord playback
 * - serverMuteOwner: server-mute the owner during TTS playback
 * - cancelAllTasks: abort all active voice tasks
 * - reconnectState: voice reconnect backoff
 */

import { createWriteStream, mkdirSync, unlinkSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  createAudioResource,
  AudioPlayerStatus,
  EndBehaviorType,
} from '@discordjs/voice';
import { transcribeAudio, transcribeWhisperOnly } from './stt.js';
import { synthesizeSpeech } from './tts.js';
import { OpusDecoder } from './opus-decoder.js';
import {
  checkWakeWord,
  markBotResponse,
  endConversationWindow,
  setOthersPresent,
  isOthersPresent,
  isContinuationPhrase,
  isFollowUpExpected,
  hasRecentContext,
  WAKE_WORD_ENABLED,
  WAKE_WORD_PHRASES,
  VOICE_WAKE_WORD,
  VOICE_NAME,
} from './wakeword.js';
import {
  isHallucination,
  shouldSleep,
  shouldDismiss,
  isSideTalk,
  isTruncatedFragment,
  classifyIntent,
  hasTaskContent,
} from '../brain/intent-classifier.js';
import { classifyAmbient, isAmbientClassifierEnabled } from '../brain/haiku-ambient.js';
import { StreamingSTTSession } from './stt-streaming.js';
import { getPlayer, setVoiceConnection, getIsSpeaking, setIsSpeaking } from './speech-output.js';
import { isSonosModeEnabled, getSonosTarget, getSonosCtx, resetSonosCtx, VOICE_SCOPE } from '../sonos-mode.js';
import {
  resetIdleSleepTimer,
  isWakeUpCommand,
  WAKE_UP_PATTERNS,
  handleSleepCheck as fsmHandleSleepCheck,
  applyImplicitWakeOnUnmute,
  detectFollowUpLikely,
  openAttentionWindow,
  closeAttentionWindow,
  isAttentionWindowActive,
  startTaskAutoSleep,
  cancelTaskAutoSleep,
  isTaskAutoSleepArmed,
} from '../state/fsm.js';
import { dispatchCommand, isInterruptCommand } from '../discord/command-dispatch.js';
import { touchFocus } from '../state/focus-state.js';
import { getState, transition } from '../state/bot-state.js';
import { isVerifiedOwner, passesAuthGate, enrollmentState } from '../auth.js';
import {
  markStreaming, markWorking, markCompleted as ledgerMarkCompleted,
  markFailed, markEscalated,
} from '../agent/task-ledger.js';
import { getActivePersona, switchPersonaFull } from '../brain/brain.js';
import { setCurrentVoiceChannelId } from '../alert-webhook.js';
import { isVisualModeEnabled } from '../visual-mode.js';
import { isTldrModeEnabled, isTranscriptModeEnabled } from '../tldr-mode.js';
import { postTaskToThread } from '../discord/thread-router.js';
import { getAllowedUserIds } from '../allowed-users.js';
import { markBriefingDelivered, generateBriefing, shouldBrief } from '../join-briefing.js';
import { activate as muteQueueActivate, deactivate as muteQueueDeactivate, isActive as isMuteQueueActive, addEntry as muteQueueAdd, hasEntries as muteQueueHasEntries, getSummary as muteQueueSummary, getContextBlock as muteQueueContext, clear as muteQueueClear, getCount as muteQueueCount } from '../state/mute-queue.js';
import { endAllSessionPins } from '../alert-webhook.js';
import { emit as busEmit } from '../event-bus.js';
import logger from '../logger.js';
import { voiceTasks } from '../voice-tasks.js';
import {
  activeTasks, conversations, userSpeaking, partialTranscripts,
  bargeInEvents, bargeInTimers, recordMode, voiceConn, interactionState,
  pendingUtterance, taskCounter,
} from '../state/runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const MULTI_USER_ENABLED = process.env.MULTI_USER_ENABLED === 'true';
const MUTE_QUEUE_ENABLED = process.env.MUTE_QUEUE_ENABLED === 'true';
const UNMUTE_IMPLICIT_WAKE = process.env.UNMUTE_IMPLICIT_WAKE !== 'false';
const MUTE_QUEUE_WAKE_BYPASS = process.env.MUTE_QUEUE_WAKE_BYPASS !== 'false';
const MIN_AUDIO_DURATION_MS = 300;
const SILENCE_THRESHOLD_MS = process.env.VAD_TIMEOUT ? parseInt(process.env.VAD_TIMEOUT) : 1500;
const TRANSCRIPT_DEDUP_MS = parseInt(process.env.TRANSCRIPT_DEDUP_MS ?? '15000');
const REBUFF_COOLDOWN_MS = parseInt(process.env.SPEAKER_REBUFF_COOLDOWN_MS ?? '60000');
const ACTIVE_CONVERSATION_WINDOW_MS = parseInt(process.env.CONVERSATION_WINDOW_MS || '60000');
const SESSION_PASSPHRASE = process.env.SPEAKER_PASSPHRASE || '';
const RECORD_DIR = join(process.env.HOME || '/tmp', 'meeting-transcripts');
const RECORD_CHANNEL_ID = process.env.RECORD_CHANNEL_ID || null;
const RECORD_TEXT_CHANNEL_ID = process.env.RECORD_TEXT_CHANNEL_ID || null;
const TMP_DIR = join(__dirname, '..', '..', 'tmp');

// ── Voice Reconnect Backoff ─────────────────────────────────────────────

export const reconnectState = {
  attempts: 0,
  currentDelayMs: 5000,
  maxDelayMs: 60000,
  baseDelayMs: 5000,
  textModeNotified: false,

  nextDelay() {
    this.attempts++;
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

// ── ON_SCREEN Sentence Detection ────────────────────────────────────────

export function _isScreenSentence(text) {
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

// ── Cancel All Tasks ─────────────────────────────────────────────────────

export function cancelAllTasks() {
  if (pendingUtterance.timer) {
    clearTimeout(pendingUtterance.timer);
    pendingUtterance.timer = null;
    pendingUtterance.parts = [];
    pendingUtterance.userId = null;
  }
  const count = activeTasks.size;
  for (const [taskId, task] of activeTasks) {
    task.controller.abort();
    logger.info(`🛑 Cancelled task #${taskId}`);
  }
  activeTasks.clear();
  // audioQueue.clear() needs lazy import to avoid circular dep
  _getAudioQueue().then(aq => {
    aq.clear();
  }).catch(() => {});
  setIsSpeaking(false);
  serverMuteOwner(false);
  logger.info(`🛑 Cancelled ${count} active tasks, cleared all queues`);
  if (count > 0) {
    import('../discord/posting.js').then(m =>
      m.postActivity(`🛑 **Cancelled ${count} task${count > 1 ? 's' : ''}** (user interrupt)`)
    ).catch(() => {});
  }
}

// Lazy audioQueue import to avoid circular dep
async function _getAudioQueue() {
  const m = await import('./tts-delivery.js');
  return m.audioQueue;
}

// ── Server Mute Owner ────────────────────────────────────────────────────

export async function serverMuteOwner(mute) {
  if (isVisualModeEnabled() && mute) return;
  try {
    const { discordRef } = await import('../state/runtime.js');
    const client = discordRef.client;
    if (!client) return;
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;
    const ALLOWED_USERS = getAllowedUserIds();
    const member = guild.members.cache.get(ALLOWED_USERS[0]);
    if (!member?.voice?.channelId) return;
    if (member.voice.serverMute === mute) return;
    await member.voice.setMute(mute, mute ? 'Jarvis speaking' : 'Jarvis done speaking');
    if (mute) logger.info('🔇 Server-muted owner (Jarvis speaking)');
    else logger.info('🔊 Server-unmuted owner (Jarvis done)');
  } catch (err) {
    logger.warn(`Server mute ${mute ? 'on' : 'off'} failed: ${err.message}`);
  }
}

// ── Bluetooth Silence Padding ────────────────────────────────────────────

export function prependSilence(audioPath, durationMs) {
  if (durationMs <= 0 || !audioPath.endsWith('.wav')) return audioPath;
  try {
    const buf = readFileSync(audioPath);
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return audioPath;
    const channels = buf.readUInt16LE(22);
    const sampleRate = buf.readUInt32LE(24);
    const bitsPerSample = buf.readUInt16LE(34);
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
    const silence = Buffer.alloc(silenceBytes);
    if (bitsPerSample === 16) {
      for (let i = 0; i < silenceBytes - 1; i += 2) {
        silence.writeInt16LE(Math.floor(Math.random() * 21) - 10, i);
      }
    } else {
      for (let i = 0; i < silenceBytes; i++) {
        silence[i] = Math.floor(Math.random() * 3);
      }
    }
    const newDataSize = origDataSize + silenceBytes;
    const header = Buffer.from(buf.subarray(0, pcmStart));
    header.writeUInt32LE(newDataSize + (pcmStart - 8), 4);
    header.writeUInt32LE(newDataSize, dataOffset + 4);
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

// ── WAV Helper ───────────────────────────────────────────────────────────

export function savePcmAsWav(pcmBuffer, outputPath) {
  return new Promise((resolve, reject) => {
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

// ── Audio Playback ────────────────────────────────────────────────────────

export async function playAudioEnhanced(audioPath, overrideCtx = null) {
  const { speechPlayAudio: speechPlayAudio, getPlayer: _getPlayer } = await import('./speech-output.js');
  const _playCtx = (overrideCtx && overrideCtx.channelId) ? overrideCtx : getSonosCtx();
  if (isSonosModeEnabled(_playCtx.channelId)) {
    setIsSpeaking(true);
    try {
      const { playWavOnSonos } = await import('../sonos-play.js');
      await playWavOnSonos(audioPath, getSonosTarget(_playCtx.channelId), _playCtx);
      setIsSpeaking(false);
      return;
    } catch (err) {
      setIsSpeaking(false);
      logger.warn(`[sonos-mode] playWavOnSonos failed: ${err.message} — skipping audio`);
      return;
    }
  }

  setIsSpeaking(true);
  const player = getPlayer();
  const audioQueue = await _getAudioQueue();
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
  const isWav = audioPath.endsWith('.wav');
  const bytesPerSec = isWav ? 48000 : 16000;
  const estimatedDurationMs = Math.max(1500, (fileStat.size / bytesPerSec) * 1000);

  const resource = createAudioResource(crs(audioPath));
  player.play(resource);

  return new Promise((resolve) => {
    let resolved = false;
    let onIdle, onError, timeoutId, checkInterval;

    const finish = (reason) => {
      if (resolved) return;
      resolved = true;
      player.removeListener(AudioPlayerStatus.Idle, onIdle);
      player.removeListener('error', onError);
      if (timeoutId) clearTimeout(timeoutId);
      if (checkInterval) clearInterval(checkInterval);
      if (standalonePlay) setIsSpeaking(false);
      if (standalonePlay) serverMuteOwner(false);
      resolve();
    };

    onIdle = () => {
      const elapsed = Date.now() - playStart;
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

    timeoutId = setTimeout(() => finish('timeout'), Math.min(estimatedDurationMs * 2, 15000));
    checkInterval = setInterval(() => {
      if (Date.now() - playStart >= estimatedDurationMs && player.state.status === AudioPlayerStatus.Idle) {
        finish('idle-polled');
      }
    }, 500);
  });
}

// ── Record Mode ──────────────────────────────────────────────────────────

export async function startRecordMode(userId) {
  if (recordMode.active) return;
  recordMode.active = true;
  recordMode.startTime = Date.now();
  recordMode.thread = null;
  recordMode.entryCount = 0;

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

  try {
    const { discordRef } = await import('../state/runtime.js');
    const client = discordRef.client;
    if (!client) throw new Error('no client');
    const chId = RECORD_TEXT_CHANNEL_ID || process.env.DISCORD_TEXT_CHANNEL_ID;
    let recChannel = client.channels.cache.get(chId);
    if (!recChannel) {
      const guild = client.guilds.cache.get(GUILD_ID);
      if (guild) recChannel = await guild.channels.fetch(chId);
    }
    if (recChannel) {
      await recChannel.send(`**Recording started** -- ${dateStr}, ${timeStr}`);
      logger.info(`REC: notification posted to #meeting-transcripts`);
    }
  } catch (err) {
    logger.error(`REC: notification failed: ${err.message}`);
  }

  logger.info(`REC: started -> ${recordMode.filePath}`);
}

export async function stopRecordMode() {
  if (!recordMode.active) return;
  const durationMs = Date.now() - recordMode.startTime;
  const mins = Math.floor(durationMs / 60000);
  const secs = Math.floor((durationMs % 60000) / 1000);
  const durationStr = `${mins}m ${String(secs).padStart(2, '0')}s`;
  const entryCount = recordMode.entryCount;
  const filePath = recordMode.filePath;

  if (filePath) {
    try { appendFileSync(filePath, `\n--- Recording ended ---\nDuration: ${durationStr} | Entries: ${entryCount}\n`); } catch {}
  }

  try {
    const { discordRef } = await import('../state/runtime.js');
    const client = discordRef.client;
    if (!client) throw new Error('no client');
    const chId = RECORD_TEXT_CHANNEL_ID || process.env.DISCORD_TEXT_CHANNEL_ID;
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

export function handleRecordModeSpeech(userId, sttResult) {
  const text = (sttResult?.text || '').trim();
  if (!text) return;
  if (isHallucination(text)) return;

  if (/\b(stop|end)\s*record/i.test(text)) {
    return stopRecordMode();
  }

  const offsetMs = Date.now() - recordMode.startTime;
  const mm = String(Math.floor(offsetMs / 60000)).padStart(2, '0');
  const ss = String(Math.floor((offsetMs % 60000) / 1000)).padStart(2, '0');

  const line = `[${mm}:${ss}] ${text}`;
  if (recordMode.filePath) {
    try { appendFileSync(recordMode.filePath, line + '\n'); } catch {}
  }
  recordMode.entryCount++;
  logger.info(`REC: [${mm}:${ss}] "${text.substring(0, 50)}"`);
}

// ── Greeting ─────────────────────────────────────────────────────────────

export async function playGreeting() {
  try {
    const persona = getActivePersona();
    const audio = await synthesizeSpeech(`${persona.name} online. Voice channel is live.`);
    if (audio) { await playAudioEnhanced(audio); try { unlinkSync(audio); } catch {} }
  } catch (err) {
    logger.error('Greeting failed:', err.message);
  }
}

// ── Voice Disconnect ──────────────────────────────────────────────────────

export async function handleVoiceDisconnect(userId) {
  const timeSinceLastInteraction = Date.now() - interactionState.lastInteractionTime;
  const wasRecentlyActive = timeSinceLastInteraction < ACTIVE_CONVERSATION_WINDOW_MS;

  if (activeTasks.size > 0) {
    logger.info(`🧹 Auto-clearing ${activeTasks.size} pending task(s) on voice disconnect`);
    for (const [taskId] of activeTasks) {
      markFailed(taskId, 'voice-disconnect');
    }
    activeTasks.clear();
  }

  if (wasRecentlyActive && interactionState.lastUserMessage) {
    logger.info(`📤 Active conversation detected - posting handoff note to text channel`);
    const handoffMsg = `🎙️ Voice session ended. Last topic: "${interactionState.lastUserMessage}". Continuing in text.`;
    const { postToTextChannel } = await import('../discord/posting.js');
    await postToTextChannel(handoffMsg);
    return;
  }

  serverMuteOwner(false);
  logger.info(`🔇 Idle disconnect (${Math.round(timeSinceLastInteraction / 1000)}s since last interaction) - no handoff`);
}

// ── Join Channel ──────────────────────────────────────────────────────────

export async function joinChannel(voiceChannelId, options = {}) {
  const { discordRef } = await import('../state/runtime.js');
  const client = discordRef.client;
  if (!client) throw new Error('Discord client not ready');

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) throw new Error(`Guild ${GUILD_ID} not found`);

  let channel = guild.channels.cache.get(voiceChannelId);
  if (!channel) {
    try { channel = await guild.channels.fetch(voiceChannelId); } catch {}
  }
  if (!channel) throw new Error(`Voice channel ${voiceChannelId} not found`);
  logger.info(`🔗 Joining voice channel: ${channel.name} (${voiceChannelId})`);

  if (voiceConn.connection) {
    try { voiceConn.connection.destroy(); } catch {}
    voiceConn.connection = null;
    setVoiceConnection(null);
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannelId,
    guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  connection.on('error', (err) => {
    logger.error('🔴 Voice connection error:', err.message);
  });

  let _lastLoggedVoiceState = '';
  let _connectingCount = 0;
  connection.on('stateChange', (oldState, newState) => {
    const tran = `${oldState.status} → ${newState.status}`;
    if (tran !== _lastLoggedVoiceState) {
      logger.info(`🔊 Voice state: ${tran}`);
      _lastLoggedVoiceState = tran;
    }
    if (newState.status === VoiceConnectionStatus.Connecting) {
      _connectingCount++;
      if (_connectingCount > 10 && connection.state.status !== VoiceConnectionStatus.Destroyed) {
        logger.warn(`⚠️ Voice connection oscillating (${_connectingCount} connecting cycles) — destroying for retry`);
        try { connection.destroy(); } catch {}
        _connectingCount = -999;
      }
    } else if (newState.status === VoiceConnectionStatus.Ready) {
      _connectingCount = 0;
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    logger.error(`⚠️ Connection timeout (stuck in ${connection.state.status}) - destroying and retrying`);
    try { connection.destroy(); } catch {}
    throw err;
  }

  const player = getPlayer();
  connection.subscribe(player);
  voiceConn.connection = connection;
  voiceConn.channelId = voiceChannelId;
  setVoiceConnection(connection);
  setCurrentVoiceChannelId(voiceChannelId);

  const handleDisconnect = async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      reconnectState.reset();
      connection.once(VoiceConnectionStatus.Disconnected, handleDisconnect);
    } catch {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        try { connection.destroy(); } catch {}
      }
      const delay = reconnectState.nextDelay();
      logger.info(`⚠️  Disconnected (attempt #${reconnectState.attempts}), rejoining in ${delay / 1000}s...`);

      if (reconnectState.attempts >= 5 && !reconnectState.textModeNotified) {
        reconnectState.textModeNotified = true;
        logger.error('🔴 Voice connection unstable after 5 reconnect attempts');
        const { postToTextChannel } = await import('../discord/posting.js');
        postToTextChannel('⚠️ **Voice connection unstable.** Standing by in text mode. Will keep retrying.');
      }

      setTimeout(async () => {
        try {
          await joinChannel(voiceChannelId);
          reconnectState.reset();
        } catch (err) {
          logger.error(`❌ Reconnect attempt #${reconnectState.attempts} failed: ${err.message}`);
        }
      }, delay);
    }
  };
  connection.once(VoiceConnectionStatus.Disconnected, handleDisconnect);

  const receiver = connection.receiver;
  for (const [uid, timer] of bargeInTimers) { clearTimeout(timer); }
  bargeInTimers.clear();
  const BARGE_IN_THRESHOLD_MS = 600;

  receiver.speaking.on('end', (userId) => {
    if (bargeInTimers.has(userId)) {
      clearTimeout(bargeInTimers.get(userId));
      bargeInTimers.delete(userId);
    }
  });

  receiver.speaking.on('start', async (userId) => {
    const ALLOWED_USERS = getAllowedUserIds();
    if (!MULTI_USER_ENABLED && !ALLOWED_USERS.includes(userId)) return;

    const audioQueue = await _getAudioQueue();
    if (getIsSpeaking() && ALLOWED_USERS.includes(userId)) {
      if (!bargeInTimers.has(userId)) {
        const timer = setTimeout(() => {
          if (getIsSpeaking()) {
            logger.info(`⚡ Barge-in - stopping playback`);
            bargeInEvents.add(userId);
            player.stop(true);
            audioQueue.clear();
            setIsSpeaking(false);
          }
          bargeInTimers.delete(userId);
        }, BARGE_IN_THRESHOLD_MS);
        bargeInTimers.set(userId, timer);
      }
    }

    if (!userSpeaking.has(userId)) {
      const audioStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_THRESHOLD_MS },
      });

      const chunks = [];
      const decoder = new OpusDecoder();
      audioStream.pipe(decoder);

      decoder.on('data', (chunk) => chunks.push(chunk));

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

      decoder.on('data', (chunk) => {
        streamSession?.sendChunk(chunk);
      });

      audioStream.once('error', (err) => {
        streamSession?.destroy();
        logger.error(`Audio stream error for ${userId}:`, err.message);
        userSpeaking.delete(userId);
        decoder.destroy();
      });

      decoder.once('error', () => {});

      audioStream.once('end', async () => {
        userSpeaking.delete(userId);
        const totalBuffer = Buffer.concat(chunks);
        const durationMs = (totalBuffer.length / (48000 * 2)) * 1000;

        if (durationMs < MIN_AUDIO_DURATION_MS) {
          streamSession?.destroy();
          return;
        }

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

  serverMuteOwner(false);

  if (options.greeting) await playGreeting();
  return connection;
}

// ── Speech Processing Pipeline ────────────────────────────────────────────

export async function handleSpeech(userId, audioBuffer, preTranscribed = null) {
  const startTime = Date.now();
  let wavPath = null;

  const audioQueue = await _getAudioQueue();
  const { postActivity, postToTextChannel, postToCC } = await import('../discord/posting.js');
  const { TtsPipeline } = await import('./tts-pipeline.js');
  const { recordInlineSpoken } = await import('../alert-webhook.js');

  // ── Enrollment Mode ──
  if (enrollmentState.active && enrollmentState.userId === userId) {
    resetIdleSleepTimer();
    const enrollWavPath = join(TMP_DIR, `enroll_${userId}_${Date.now()}.wav`);
    try {
      await savePcmAsWav(audioBuffer, enrollWavPath);
      const durationMs = (audioBuffer.length / (48000 * 2)) * 1000;
      if (durationMs < 600) {
        try { unlinkSync(enrollWavPath); } catch {}
        return;
      }

      let clipTranscript = '';
      try {
        clipTranscript = (await transcribeWhisperOnly(enrollWavPath) || '').trim();
      } catch {}

      const retryCheck = clipTranscript.toLowerCase().replace(/[.,!?]/g, '').trim();

      if (/\b(cancel|stop|quit|abort)\b/i.test(retryCheck) && !/passport/i.test(retryCheck)) {
        try { unlinkSync(enrollWavPath); } catch {}
        enrollmentState.cancel();
        logger.info('Enrollment cancelled by voice command');
        const audio = await synthesizeSpeech('Enrollment cancelled.');
        if (audio) { audioQueue.add(audio); }
        return;
      }

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

      if (/\b(learn\s*mode|keep\s*going|add\s*more|more\s*samples|continue)\b/i.test(retryCheck)) {
        try { unlinkSync(enrollWavPath); } catch {}
        enrollmentState.learnMode = true;
        const audio = await synthesizeSpeech('Learn mode on. Keep speaking naturally and I\'ll add samples to improve your voiceprint. Say done when finished.');
        if (audio) { audioQueue.add(audio); }
        postToCC('Enrollment', 'Learn mode enabled. Speak naturally. Say **"done"** to save.');
        return;
      }

      if (clipTranscript) {
        logger.info(`Enrollment clip transcript: "${clipTranscript}"`);
        postToCC('Enrollment', clipTranscript);
      }

      const result = await enrollmentState.addClip(enrollWavPath);
      try { unlinkSync(enrollWavPath); } catch {}
      if (result.accepted) {
        busEmit('LEARN', `clip ${enrollmentState.clipsCollected}/${enrollmentState.clipsNeeded} · user=${enrollmentState.userId}`, { userId: enrollmentState.userId });
        const consistencyStr = result.consistency_score != null ? ` consistency=${result.consistency_score}` : '';
        logger.info(`Enrollment clip ${enrollmentState.clipsCollected}/${enrollmentState.clipsNeeded} accepted${consistencyStr}`);

        if (enrollmentState.learnMode) {
          postToCC('Learn', `Clip ${enrollmentState.clipsCollected} added. Just keep talking naturally — say anything. Say **"done"** to save.`);
          const audio = await synthesizeSpeech(`Got it, ${enrollmentState.clipsCollected} samples. Just keep talking — say anything at all. Say done when finished.`);
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
    const authCtx = { isOwner: interactionState.authenticatedSession, userId };

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
      const _audioDurationMs = (audioBuffer.length / (48000 * 2)) * 1000;
      logger.info(`🎙️  STT recv: ${_audioDurationMs.toFixed(0)}ms from user ${userId} — queuing transcription`);
      sttResult = await transcribeAudio(wavPath);
      const _sttElapsedMs = Date.now() - startTime;
      logger.info(`🎯 STT complete: "${(sttResult.text || '').substring(0, 50)}" (${_sttElapsedMs}ms total)`);
      rawTranscript = sttResult.text;
      sentiment = sttResult.sentiment;
      needsEnrollment = !!sttResult.needsEnrollment;

      const CC_CHANNEL_ID = process.env.DISCORD_CC_CHANNEL_ID;
      if (sttResult.rejected) {
        if (CC_CHANNEL_ID && (sttResult.rejected !== 'no_speech')) {
          const reason = sttResult.hallucinationReason || sttResult.rejected;
          const { discordRef } = await import('../state/runtime.js');
          const ccChannel = discordRef.client?.channels.cache.get(CC_CHANNEL_ID);
          if (ccChannel) ccChannel.send(`\`[FILTERED]\` ${reason}`).catch(() => {});
        }
        try { unlinkSync(wavPath); } catch {}
        return;
      }

      if (recordMode.active) {
        try { unlinkSync(wavPath); } catch {}
        wavPath = null;
        if (!rawTranscript || rawTranscript.trim().length === 0) return;
        return handleRecordModeSpeech(userId, sttResult);
      }

      try { unlinkSync(wavPath); } catch {}
      wavPath = null;
    }

    if (!rawTranscript || rawTranscript.trim().length === 0) return;

    if (recordMode.active) {
      return handleRecordModeSpeech(userId, sttResult || { text: rawTranscript });
    }

    const spkr = sttResult?.speakerInfo;
    if (spkr) {
      const matched = isVerifiedOwner(spkr, 'medium');
      busEmit('VERIFY', `${matched ? 'matched' : 'rejected'} · conf=${spkr.confidence?.toFixed(3)} tier=${spkr.confidence_tier}`, { userId, matched });
    }
    if (rawTranscript && rawTranscript.length > 1) {
      busEmit('STT', `"${rawTranscript.slice(0, 80)}${rawTranscript.length > 80 ? '…' : ''}"`, { userId });
    }
    const ALLOWED_USERS = getAllowedUserIds();
    if (spkr && !isVerifiedOwner(spkr, 'medium')) {
      const trimmed = rawTranscript.trim();
      const _wwEscIdx = VOICE_WAKE_WORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const _wakeWordRe = new RegExp(`^(hey[,.]?\\s+)?(${_wwEscIdx}|jarvis)\\b`, 'i');
      const startsWithWakeWord = _wakeWordRe.test(trimmed)
        || WAKE_WORD_PHRASES.some(p => trimmed.toLowerCase().startsWith(p));
      if (startsWithWakeWord) {
        logger.info(`🎯 Wake word from non-owner embedding (confidence=${spkr.confidence} norm=${spkr.norm_score}) - passing to FSM gate`);
      } else {
        const isLong = rawTranscript.length > 80;
        if (spkr.confidence_tier === 'low' || spkr.norm_score < 0.5 || isLong) {
          logger.info(`🔇 Non-owner audio filtered (confidence=${spkr.confidence} norm=${spkr.norm_score} tier=${spkr.confidence_tier} len=${rawTranscript.length}): "${rawTranscript.substring(0, 50)}..."`);
          return;
        }
      }
    }

    if (rawTranscript.length > 60 && getState() === 'SLEEP') {
      const _wakeTerms = [...new Set(['jarvis', 'gargis', 'service', VOICE_WAKE_WORD, ...WAKE_WORD_PHRASES])];
      const _wakeTermsRe = new RegExp(`\\b(${_wakeTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
      const jarvisIdx = rawTranscript.search(_wakeTermsRe);
      if (jarvisIdx > 20) {
        const fromJarvis = rawTranscript.substring(jarvisIdx);
        const sentenceMatches = [...fromJarvis.matchAll(/[.!?]\s/g)];
        const extracted = sentenceMatches.length >= 2
          ? fromJarvis.substring(0, sentenceMatches[1].index + sentenceMatches[1][0].length).trim()
          : fromJarvis.substring(0, 200).trim();
        logger.info(`🔧 TV noise extraction: ${rawTranscript.length} chars → ${extracted.length} chars: "${extracted.substring(0, 80)}"`);
        rawTranscript = extracted;
      } else if (jarvisIdx === -1 && spkr && spkr.confidence_tier === 'low') {
        logger.info(`🔇 TV dialogue filtered (norm=${spkr.norm_score} tier=${spkr.confidence_tier} len=${rawTranscript.length}): "${rawTranscript.substring(0, 60)}..."`);
        return;
      }
    }

    if (!recordMode.active && /jarvis/i.test(rawTranscript) && /\b(record\s*(mode|meeting|this)?|start\s*recording)\b/i.test(rawTranscript)) {
      return startRecordMode(userId);
    }

    const currentState = getState();
    const spkrTag = spkr ? `${spkr.confidence_tier}(${spkr.confidence})` : 'null';
    logger.info(`[FSM-gate] state=${currentState} speaker=${spkrTag} transcript="${rawTranscript.substring(0, 40)}..."`);

    const spkrIsOwner = isVerifiedOwner(spkr, 'high');
    if (currentState === 'SLEEP') {
      const cleanTranscript = rawTranscript.trim().replace(/[.,!?;:]+$/g, '');
      const strictWakeMatch = WAKE_UP_PATTERNS.some(p => p.test(cleanTranscript));
      const sleepSpkrVerified = isVerifiedOwner(spkr, 'high');
      const sleepWakeMatch = strictWakeMatch || isWakeUpCommand(cleanTranscript, sleepSpkrVerified);
      if (sleepWakeMatch) {
        const wakeSpkr = sttResult?.speakerInfo;
        transition('ACTIVE', 'wake-word');
        busEmit('WAKE', `"${rawTranscript.slice(0, 60)}" → ACTIVE`, { userId });
        authCtx.isOwner = isVerifiedOwner(wakeSpkr, 'high');
        interactionState.authenticatedSession = authCtx.isOwner;
        resetIdleSleepTimer();
        const _wwStripEsc = VOICE_WAKE_WORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const _wakeStripRe = new RegExp(`^(hey\\s+)?(${_wwStripEsc}|jarvis)[,.]?\\s*`, 'i');
        let stripped = rawTranscript.replace(_wakeStripRe, '').trim();
        if (stripped === rawTranscript.trim()) {
          const _matchedPhrase = WAKE_WORD_PHRASES.find(p => rawTranscript.toLowerCase().startsWith(p));
          if (_matchedPhrase) {
            stripped = rawTranscript.substring(_matchedPhrase.length).replace(/^[,.\s]+/, '').trim();
          } else {
            stripped = rawTranscript.replace(/^[a-zA-Z]{1,12}[,.]?\s+/i, '').trim();
          }
        }
        if (stripped.length > 2) {
          logger.info(`SLEEP -> ACTIVE with command (authenticated=${authCtx.isOwner}): "${stripped}"`);
        } else {
          logger.info(`SLEEP -> ACTIVE (bare wake word, authenticated=${authCtx.isOwner})`);
          const audio = await synthesizeSpeech('Back online. What do you need?');
          if (audio) { audioQueue.add(audio); }
          markBotResponse(userId);
          return;
        }
      } else if (isAttentionWindowActive()) {
        const { authorized: attentionAuth } = passesAuthGate(spkr, { context: 'attention' });
        if (!attentionAuth) {
          logger.info(`👂 Post-speak attention window: auth gate rejected speaker (${spkrTag}) - keeping window open`);
          return;
        }
        logger.info(`👂 Post-speak attention window: auth gate passed (${spkrTag}) - "${rawTranscript.substring(0, 60)}"`);
        transition('ACTIVE', 'post-speak-attention');
        authCtx.isOwner = true;
        interactionState.authenticatedSession = true;
        closeAttentionWindow();
        resetIdleSleepTimer();
      } else {
        return;
      }
    }

    if (currentState === 'IDLE') {
      if (isWakeUpCommand(rawTranscript, spkrIsOwner)) {
        const wakeSpkr = sttResult?.speakerInfo;
        transition('ACTIVE', 'wake-word-from-idle');
        authCtx.isOwner = isVerifiedOwner(wakeSpkr, 'high');
        interactionState.authenticatedSession = authCtx.isOwner;
        resetIdleSleepTimer();
      } else if (isContinuationPhrase(rawTranscript) && hasRecentContext(userId)) {
        logger.info(`💬 Continuation phrase in IDLE: "${rawTranscript.substring(0, 50)}" -- resuming`);
        transition('ACTIVE', 'continuation-from-idle');
        authCtx.isOwner = true;
        interactionState.authenticatedSession = true;
        resetIdleSleepTimer();
      } else if (isVerifiedOwner(spkr, 'high') && hasRecentContext(userId) && isFollowUpExpected()) {
        logger.info(`Owner response to alert/prompt in IDLE (speaker=${spkr.confidence} tier=${spkr.confidence_tier}) -- no wake word needed`);
        transition('ACTIVE', 'owner-response-from-idle');
        authCtx.isOwner = true;
        interactionState.authenticatedSession = true;
        resetIdleSleepTimer();
      } else if (!isOthersPresent() && hasRecentContext(userId)) {
        logger.info(`💬 Conversation window open in IDLE: "${rawTranscript.substring(0, 50)}" -- resuming without wake word`);
        transition('ACTIVE', 'conversation-window-from-idle');
        authCtx.isOwner = true;
        interactionState.authenticatedSession = true;
        resetIdleSleepTimer();
      } else {
        return;
      }
    }

    if (isHallucination(rawTranscript)) {
      logger.info(`Whisper hallucination filtered: "${rawTranscript}"`);
      return;
    }

    logger.info(`📝 "${rawTranscript}" (${Date.now() - startTime}ms)`);
    postToCC('🎤', rawTranscript);

    const _wwPreSleepEsc = VOICE_WAKE_WORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const _preSleepWakeRe = new RegExp(`\\b(jarvis|${_wwPreSleepEsc})\\b`, 'gi');
    const preSleepCheck = rawTranscript.toLowerCase().replace(/[.,!?]/g, '').replace(_preSleepWakeRe, '').trim();
    if (await fsmHandleSleepCheck(preSleepCheck, 'voice-command-pre-wake', userId, pendingUtterance, synthesizeSpeech, audioQueue)) return;

    if (isVerifiedOwner(spkr, 'high')) {
      const { parseSonosModeCommand, setSonosMode, clearSonosMode, getLastSonosTarget } = await import('../sonos-mode.js');
      const _sonosQuick = parseSonosModeCommand(rawTranscript);
      if (_sonosQuick) {
        if (_sonosQuick.command === 'on') {
          audioQueue.clear();
          const _target = _sonosQuick.target || getLastSonosTarget();
          setSonosMode(VOICE_SCOPE, _target);
          const { setSonosCtx } = await import('../sonos-mode.js');
          const _ctx = { channelId: VOICE_SCOPE, threadId: 'main', taskId: 'mode-on', role: 'ack' };
          setSonosCtx(_ctx);
          const targetLabel = _target === 'up' ? 'bedroom' : _target === 'all' ? 'all speakers' : 'kitchen';
          const ack = `Speaker mode on, routing to ${targetLabel}.`;
          postActivity(`🔊 ${ack}`);
          try { const audio = await synthesizeSpeech(ack); if (audio) audioQueue.add(audio, _ctx); } catch {}
        } else if (_sonosQuick.command === 'off') {
          audioQueue.clear();
          clearSonosMode(VOICE_SCOPE);
          resetSonosCtx();
          const ack = 'Speaker mode off.';
          postActivity(`🔇 ${ack}`);
          try { const audio = await synthesizeSpeech(ack); if (audio) audioQueue.add(audio); } catch {}
        }
        markBotResponse(userId);
        return;
      }
    }

    if (sentiment && sentiment.sentiment) {
      const scoreStr = sentiment.sentiment_score != null ? ` (${sentiment.sentiment_score.toFixed(2)})` : '';
      logger.info(`🎭 Sentiment: ${sentiment.sentiment}${scoreStr}`);
      postActivity(`🎭 Sentiment: ${sentiment.sentiment}${scoreStr}`);
    }

    const speakerLikelyOwner = isVerifiedOwner(spkr, 'medium');
    const { detected, cleanedTranscript, wakeWordUsed } = checkWakeWord(rawTranscript, userId, speakerLikelyOwner);
    if (!detected) return;

    const speakerInfo = sttResult?.speakerInfo;
    if (speakerInfo && !authCtx.isOwner) {
      if (isVerifiedOwner(speakerInfo, 'high')) {
        authCtx.isOwner = true;
        interactionState.authenticatedSession = true;
        const tier = speakerInfo.confidence_tier || 'unknown';
        logger.info(`Session authenticated (wake word confidence=${speakerInfo.confidence} tier=${tier})`);
      } else {
        const cleanLowerAuth = cleanedTranscript.toLowerCase().replace(/[.,!?]/g, '').trim();
        if (SESSION_PASSPHRASE && cleanLowerAuth.includes(SESSION_PASSPHRASE.toLowerCase())) {
          authCtx.isOwner = true;
          interactionState.authenticatedSession = true;
          logger.info(`🔓 Session authenticated (passphrase override, confidence=${speakerInfo.confidence})`);
        } else {
          if (shouldSleep(cleanedTranscript)) {
            logger.info(`🌙 Sleep phrase at wake-word-reject: "${cleanedTranscript}" — silent drop, not rebuffing`);
            return;
          }
          const rebuffEnabled = (process.env.SPEAKER_REBUFF_ENABLED ?? 'true').toLowerCase() !== 'false';
          const now = Date.now();
          if (rebuffEnabled && (!handleSpeech._lastRebuff || now - handleSpeech._lastRebuff > REBUFF_COOLDOWN_MS)) {
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
          } else if (rebuffEnabled) {
            logger.info(`🔒 Wake word rejected (throttled): confidence=${speakerInfo.confidence}`);
          } else {
            logger.info(`🔒 Wake word rejected (rebuff disabled): confidence=${speakerInfo.confidence}`);
          }
          return;
        }
      }
    } else if (authCtx.isOwner) {
      if (speakerInfo && !isVerifiedOwner(speakerInfo, 'medium') && speakerInfo.confidence_tier === 'low') {
        logger.info(`🔇 Active session: non-owner audio rejected (confidence=${speakerInfo.confidence} tier=${speakerInfo.confidence_tier})`);
        return;
      }
      if (speakerInfo && speakerInfo.confidence_tier === 'medium' && speakerInfo.confidence < 0.35) {
        logger.info(`🔇 Active session: medium-tier below floor rejected (confidence=${speakerInfo.confidence})`);
        return;
      }
      if (speakerInfo) {
        logger.info(`Session active (confidence=${speakerInfo.confidence} tier=${speakerInfo.confidence_tier || ''})`);
      }
    }

    if (getState() !== 'ACTIVE') {
      transition('ACTIVE', 'speaker-authenticated');
    }

    resetIdleSleepTimer();

    const cleanLower = cleanedTranscript.toLowerCase().replace(/[.,!?]/g, '').trim();
    if (await fsmHandleSleepCheck(cleanLower, 'voice-command', userId, pendingUtterance, synthesizeSpeech, audioQueue)) return;

    if (/^kill(\s+all)?$/.test(cleanLower)) {
      if (activeTasks.size > 0) {
        for (const [id, task] of activeTasks) {
          task.controller.abort();
        }
        activeTasks.clear();
        const { TtsPipeline: _Pip } = await import('./tts-pipeline.js');
        // clear via audioQueue
        audioQueue.clear();
        postActivity('🛑 Kill — all voice tasks aborted');
        logger.info('🛑 Kill command: aborted all active voice tasks');
      } else {
        logger.info('🛑 Kill command: no active tasks');
      }
      return;
    }

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

    const dismissResult = shouldDismiss(cleanedTranscript);
    if (dismissResult.dismiss) {
      logger.info(`🤚 Stop word dismissed (${dismissResult.reason}): "${cleanedTranscript}"`);
      return;
    }

    const inConvWindow = hasRecentContext(userId);
    if (isSideTalk(cleanedTranscript, wakeWordUsed, inConvWindow)) {
      logger.info(`💭 Side-talk dismissed (no wake word, short, convWindow=${inConvWindow}): "${cleanedTranscript}"`);
      return;
    }

    if (!wakeWordUsed && isTruncatedFragment(rawTranscript)) {
      logger.info(`✂️ Truncated fragment silently dropped: "${rawTranscript.substring(0, 60)}"`);
      return;
    }

    if (isAmbientClassifierEnabled() && !wakeWordUsed && cleanedTranscript.trim()) {
      const ambientResult = await classifyAmbient(cleanedTranscript, {
        wakeWordDetected: wakeWordUsed,
        wordCount: cleanedTranscript.split(/\s+/).filter(Boolean).length,
        hasTaskVerb: hasTaskContent(cleanedTranscript),
        isQuestion: /\?\s*$/.test(cleanedTranscript.trim()),
      });

      if (ambientResult === 'AMBIENT' || ambientResult === 'SELF_TALK' || ambientResult === 'UNCERTAIN') {
        logger.info(`🌫️ Ambient classifier [${ambientResult}] — silent ignore: "${cleanedTranscript.substring(0, 60)}"`);
        return;
      }

      if (ambientResult === 'SLEEP') {
        logger.info(`🌙 Ambient classifier [SLEEP] — triggering sleep: "${cleanedTranscript.substring(0, 60)}"`);
        const cleanLowerAmbient = cleanedTranscript.toLowerCase().replace(/[.,!?']/g, '').trim();
        await fsmHandleSleepCheck(cleanLowerAmbient, 'ambient-classifier', userId, pendingUtterance, synthesizeSpeech, audioQueue);
        return;
      }

      logger.info(`🎯 Ambient classifier [DIRECTED] — processing: "${cleanedTranscript.substring(0, 60)}"`);
    }

    const BORDERLINE_CONFIDENCE = parseFloat(process.env.BORDERLINE_CONFIDENCE || '0.55');
    const sttConfidence = sttResult?.sttMeta?.confidence;
    if (sttConfidence != null && sttConfidence < BORDERLINE_CONFIDENCE) {
      logger.info(`🌙 Borderline STT confidence (${sttConfidence.toFixed(3)} < ${BORDERLINE_CONFIDENCE}) — sleeping: "${rawTranscript.substring(0, 50)}"`);
      await fsmHandleSleepCheck('going to sleep', 'low-confidence-stt', userId, pendingUtterance, synthesizeSpeech, audioQueue);
      return;
    }

    const bareCheck = cleanedTranscript.replace(/[.,!?;:\-'"]/g, '').trim();
    if (!bareCheck || bareCheck.length === 0) {
      logger.info(`🎯 Bare wake word - acknowledging`);
      const acks = ['Sir?', 'At your service.', 'Yes, sir?', 'How can I help?', 'Listening.'];
      const ack = acks[Math.floor(Math.random() * acks.length)];
      const audio = await synthesizeSpeech(ack);
      if (audio) { audioQueue.add(audio); audioQueue.playNext(); }
      markBotResponse(userId);
      return;
    }

    interactionState.lastInteractionTime = Date.now();
    interactionState.lastUserMessage = cleanedTranscript.substring(0, 100);

    const dispatchResult = await dispatchCommand(rawTranscript, cleanedTranscript, userId, ALLOWED_USERS, enrollmentState);

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
        const voiceName = p === 'edge' ? 'Sonia' : p === 'piper' ? 'JARVIS' : p === 'chatterbox' ? 'Owner clone' : p;
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
      } else if (dispatchResult.mode === 'visual' && dispatchResult.success) {
        const { resolveVisualChannel, postToChannel } = await import('../discord/posting.js');
        if (dispatchResult.enabled) {
          const channelLabel = dispatchResult.channelName ? ` Output → #${dispatchResult.channelName}` : '';
          logger.info(`🖥️ Visual mode enabled (at-desk)${channelLabel}`);
          cancelTaskAutoSleep();
          resetIdleSleepTimer();
          const targetId = await resolveVisualChannel();
          await postToChannel(targetId, `🖥️ **Visual mode activated** — at-desk mode. I'll stay listening, post responses as text, and auto-open files on your Mac.${channelLabel}`);
          const { discordRef } = await import('../state/runtime.js');
          const ch = discordRef.client?.channels.cache.get(targetId);
          if (ch?.sendTyping) ch.sendTyping().catch(() => {});
        } else {
          logger.info('🔊 Visual mode disabled, voice restored');
          resetIdleSleepTimer();
          const ack = await synthesizeSpeech('Voice mode restored. Speaking normally.');
          if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
        }
      }
      return;
    }

    if (dispatchResult.type === 'persona_switch') {
      const { persona, voice, wakeWords } = dispatchResult;
      logger.info(`🎭 Persona switch requested: ${persona} (voice: ${voice})`);
      const ack = await synthesizeSpeech(`Switching to ${persona}.`);
      if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      try {
        await switchPersonaFull(persona.toLowerCase());
        logger.info(`🎭 Persona switch complete: ${persona} ✅`);
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

    if (dispatchResult.type === 'focus_set') {
      const { channelName, purpose, threadName } = dispatchResult;
      const focusLabel = threadName ? `${channelName}, ${threadName} thread` : channelName;
      logger.info(`🎯 Focus set: #${channelName}${threadName ? ` › ${threadName}` : ''}`);
      const msg = purpose
        ? `Focused on ${focusLabel}. ${purpose.substring(0, 80)}.`
        : `Focused on ${focusLabel}.`;
      const ack = await synthesizeSpeech(msg);
      if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      return;
    }

    if (dispatchResult.type === 'focus_not_found') {
      logger.info(`🎯 Focus not found: "${dispatchResult.query}"`);
      const msg = `I can't find a channel called "${dispatchResult.query}", sir. Try the exact Discord channel name, or drop the channel link in text chat.`;
      const ack = await synthesizeSpeech(msg);
      if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      return;
    }

    if (dispatchResult.type === 'focus_clear') {
      logger.info('🎯 Focus cleared');
      const { resolveVisualChannel, postToChannel } = await import('../discord/posting.js');
      const { getPreviousFocus } = await import('../state/focus-state.js');
      const prev = getPreviousFocus();
      const hint = prev ? ` Say "refocus" to go back to ${prev.channelName}.` : '';
      if (isVisualModeEnabled()) {
        const targetId = await resolveVisualChannel();
        await postToChannel(targetId, `🎯 Focus cleared. Back to #hud.${hint}`);
      } else {
        const ack = await synthesizeSpeech(`Focus cleared.${hint}`);
        if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      }
      return;
    }

    if (dispatchResult.type === 'focus_restore') {
      const { focus } = dispatchResult;
      logger.info(`🎯 Refocused on ${focus.channelName}`);
      const { resolveVisualChannel, postToChannel } = await import('../discord/posting.js');
      if (isVisualModeEnabled()) {
        const targetId = await resolveVisualChannel();
        await postToChannel(targetId, `🎯 Refocused on **${focus.channelName}**.`);
      } else {
        const ack = await synthesizeSpeech(`Back to ${focus.channelName}.`);
        if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      }
      return;
    }

    if (dispatchResult.type === 'focus_restore_empty') {
      const { resolveVisualChannel, postToChannel } = await import('../discord/posting.js');
      if (isVisualModeEnabled()) {
        const targetId = await resolveVisualChannel();
        await postToChannel(targetId, `🎯 No previous focus to go back to.`);
      } else {
        const ack = await synthesizeSpeech('No previous focus to go back to.');
        if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      }
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

    if (dispatchResult.type === 'voice_move') {
      const { resolveChannel, setFocusById } = await import('../state/focus-state.js');
      const { target } = dispatchResult;
      const registryPath = process.env.CHANNEL_REGISTRY_PATH || `${process.env.HOME}/dev/contexts/channel-registry.json`;
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      let targetVoiceId = null;
      const query = target.toLowerCase();
      if (registry.voiceChannels) {
        for (const [vcId, vcData] of Object.entries(registry.voiceChannels)) {
          if ((vcData.name || '').toLowerCase().includes(query) || (vcData.aliases || []).some(a => a.toLowerCase().includes(query))) {
            targetVoiceId = vcId;
            if (vcData.defaultContext) {
              const resolved = resolveChannel(vcData.defaultContext);
              if (resolved) setFocusById(resolved.channelId, resolved.channelName);
            }
            break;
          }
        }
      }
      if (targetVoiceId && voiceConn.channelId !== targetVoiceId) {
        logger.info(`🔊 Moving to voice channel ${target} (${targetVoiceId})`);
        const ack = await synthesizeSpeech(`Moving to ${target}, sir.`);
        if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
        try { await joinChannel(targetVoiceId); } catch (e) { logger.error(`voice_move failed: ${e.message}`); }
      } else if (!targetVoiceId) {
        logger.info(`🔊 voice_move: channel "${target}" not found in registry.voiceChannels`);
        const ack = await synthesizeSpeech(`I couldn't find a voice channel called ${target}, sir.`);
        if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      }
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
          const { join: j } = await import('path');
          const home = process.env.HOME || '/tmp';
          const vp1 = j(home, '.jarvis', 'owner_voiceprint.npy');
          const vp2 = j(home, '.jarvis', 'owner_voiceprints.npy');
          try { unlinkSync(vp1); } catch {}
          try { unlinkSync(vp2); } catch {}
          await fetch(`${process.env.SPEAKER_VERIFY_URL?.replace('/verify', '') || 'http://localhost:8767'}/enroll/reset`, { method: 'POST' }).catch(() => {});
          logger.info('Voiceprints wiped - starting fresh enrollment');
        } catch (e) { logger.error('Voiceprint wipe error:', e.message); }
      }
      if (dispatchResult.action === 'learn') {
        enrollmentState.start(userId, true);
        logger.info('Learn mode started - adding samples to voiceprint');
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
          `**"retry"** - repeat the current phrase`,
          `**"retry 5"** - jump back to phrase #5`,
          `**"start over"** - restart from #1`,
          `**"done"** - save early (min 3 clips)`,
          `**"more"** - switch to learn mode after finishing`,
          `**"cancel enrollment"** - abort`,
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

    if (dispatchResult.type === 'shortcut') {
      markBotResponse(userId);
      if (!dispatchResult.silent && dispatchResult.speech) {
        const ack = await synthesizeSpeech(dispatchResult.speech);
        if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      }
      if (dispatchResult.discordText) {
        const _postCh = process.env.DISCORD_TEXT_CHANNEL_ID || process.env.VOICE_REPORT_CHANNEL_ID;
        if (_postCh) {
          fetch(`https://discord.com/api/v10/channels/${_postCh}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN || ''}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: dispatchResult.discordText }),
          }).catch(() => {});
        }
      }
      return;
    }

    if (dispatchResult.type === 'voice_spawn') {
      markBotResponse(userId);
      const ack = await synthesizeSpeech('Spawning agent in a thread.');
      if (ack) { await playAudioEnhanced(ack); try { unlinkSync(ack); } catch {} }
      const targetChannel = process.env.VOICE_REPORT_CHANNEL_ID || process.env.DISCORD_TEXT_CHANNEL_ID;
      const discordToken = process.env.DISCORD_TOKEN || '';
      try {
        const { runVoiceSpawn } = await import('../agent/spawn.js');
        await runVoiceSpawn(dispatchResult.task, targetChannel, discordToken, dispatchResult.model || null);
      } catch (err) {
        logger.error(`[voice_spawn] failed: ${err.message}`);
        const errAck = await synthesizeSpeech('Could not spawn the agent. Check the logs.');
        if (errAck) { await playAudioEnhanced(errAck); try { unlinkSync(errAck); } catch {} }
      }
      return;
    }

    // Brain dispatch
    const _vcWorkspace = dispatchResult.workspaceContext ? `${dispatchResult.workspaceContext}\n\n` : '';
    const transcript = `${_vcWorkspace}${dispatchResult.transcript || cleanedTranscript}`;

    if (!conversations.has(userId)) conversations.set(userId, { history: [], lastActive: Date.now() });
    const conv = conversations.get(userId);
    conv.lastActive = Date.now();

    if (conv.history.length === 0) {
      try {
        const { getFocus } = await import('../state/focus-state.js');
        const focus = getFocus();
        const seedChannelId = focus?.channelId || null;
        if (seedChannelId) {
          const { discordRef } = await import('../state/runtime.js');
          const client = discordRef.client;
          const seedCh = await client?.channels.fetch(seedChannelId).catch(() => null);
          if (seedCh?.messages) {
            const msgs = await seedCh.messages.fetch({ limit: 10 });
            if (msgs.size > 0) {
              const lines = Array.from(msgs.values())
                .reverse()
                .map(m => {
                  const who = m.author.bot ? `[bot] ${m.author.username}` : m.author.username;
                  return `${who}: ${(m.content || '').substring(0, 300).replace(/\n/g, ' ')}`;
                })
                .join('\n');
              const label = seedCh.isThread?.()
                ? `thread "${seedCh.name}" in #${seedCh.parent?.name || seedCh.parentId}`
                : `#${seedCh.name}`;
              conv.history.push({
                role: 'assistant',
                content: `[Voice session started. Recent messages from ${label}:]\n${lines}`,
              });
              logger.info(`[voice] Cold-start: seeded history from ${label} (${msgs.size} msgs)`);
            }
          }
        }
      } catch (e) {
        logger.warn(`[voice] Cold-start seed failed: ${e.message}`);
      }
    }

    conv.history.push({ role: 'user', content: transcript });

    // trimHistory
    const CONVERSATION_HISTORY_MAX = parseInt(process.env.CONVERSATION_HISTORY_MAX ?? '10000');
    const CONVERSATION_HISTORY_MAX_CHARS = parseInt(process.env.CONVERSATION_HISTORY_MAX_CHARS ?? String(900000 * 4));
    while (conv.history.length > CONVERSATION_HISTORY_MAX) conv.history.shift();
    let charCount = conv.history.reduce((acc, m) => acc + (m.content || '').length, 0);
    while (charCount > CONVERSATION_HISTORY_MAX_CHARS && conv.history.length > 1) {
      const removed = conv.history.shift();
      charCount -= (removed.content || '').length;
    }

    let speakerName = null;
    if (MULTI_USER_ENABLED) {
      try {
        const { discordRef } = await import('../state/runtime.js');
        const client = discordRef.client;
        const guild = client?.guilds.cache.get(GUILD_ID);
        const member = guild?.members?.cache?.get(userId);
        speakerName = member?.displayName || member?.user?.username || null;
      } catch {}
    }

    const transcriptKey = transcript.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80);
    const now = Date.now();
    if (!handleSpeech._recentTranscripts) handleSpeech._recentTranscripts = new Map();
    const lastSeen = handleSpeech._recentTranscripts.get(transcriptKey);
    if (lastSeen && now - lastSeen < TRANSCRIPT_DEDUP_MS) {
      logger.info(`⏭️  Transcript dedup: skipping duplicate "${transcript.substring(0, 40)}..." (${now - lastSeen}ms ago)`);
      return;
    }
    handleSpeech._recentTranscripts.set(transcriptKey, now);
    for (const [k, t] of handleSpeech._recentTranscripts) {
      if (now - t > TRANSCRIPT_DEDUP_MS) handleSpeech._recentTranscripts.delete(k);
    }

    const { queueUtterance } = await import('./utterance-queue.js');
    queueUtterance(userId, transcript, conv, speakerName, sentiment);

  } catch (err) {
    logger.error({ err }, `❌ Speech dispatch error: ${err.message}`);
    if (err.message && err.message.includes('STT failed') && !err.message.includes('Empty transcript')) {
      try {
        const failAudio = await synthesizeSpeech("I couldn't understand that. Could you try again?");
        if (failAudio) { await playAudioEnhanced(failAudio); try { unlinkSync(failAudio); } catch {} }
      } catch {}
    }
  } finally {
    if (wavPath) { try { unlinkSync(wavPath); } catch {} }
  }
}
