/**
 * Voice Connection Manager
 * 
 * Handles Discord voice channel join/leave/reconnect with exponential backoff.
 * Extracted from index.js to isolate connection lifecycle from audio processing.
 */

import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
} from '@discordjs/voice';
import logger from '../logger.js';

// ── Reconnect Backoff State ──────────────────────────────────────────
const reconnectState = {
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

let currentConnection = null;
let currentVoiceChannelId = null;

export function getConnection() { return currentConnection; }
export function getCurrentVoiceChannelId() { return currentVoiceChannelId; }
export function getReconnectAttempts() { return reconnectState.attempts; }

/**
 * Join a voice channel with auto-reconnect and audio receiver setup
 * 
 * @param {object} options
 * @param {import('discord.js').Client} options.client - Discord client
 * @param {string} options.guildId - Guild ID
 * @param {string} options.voiceChannelId - Voice channel ID to join
 * @param {import('@discordjs/voice').AudioPlayer} options.player - Audio player to subscribe
 * @param {Function} options.onUserSpeech - Callback (userId, audioBuffer) when user finishes speaking
 * @param {Function} options.onBargeIn - Callback (userId) when user barges in during playback
 * @param {Function} options.isSpeaking - Function returning whether bot is currently speaking
 * @param {string[]} options.allowedUsers - User IDs allowed to interact
 * @param {boolean} options.multiUser - Whether multi-user mode is enabled
 * @param {Function} options.postToTextChannel - Text channel posting function
 * @param {Function} options.onVoiceChannelSet - Callback when voice channel ID is set
 * @param {boolean} [options.greeting] - Whether to trigger greeting
 * @returns {Promise<import('@discordjs/voice').VoiceConnection>}
 */
export async function joinChannel(options) {
  const {
    client, guildId, voiceChannelId, player,
    onUserSpeech, onBargeIn, isSpeaking,
    allowedUsers, multiUser, postToTextChannel,
    onVoiceChannelSet,
  } = options;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error(`Guild ${guildId} not found`);
  const channel = guild.channels.cache.get(voiceChannelId);
  if (!channel) throw new Error(`Voice channel ${voiceChannelId} not found`);
  
  const connection = joinVoiceChannel({
    channelId: voiceChannelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  
  connection.on('error', (err) => {
    logger.error('🔴 Voice connection error:', err.message);
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  connection.subscribe(player);
  currentConnection = connection;
  currentVoiceChannelId = voiceChannelId;
  if (onVoiceChannelSet) onVoiceChannelSet(voiceChannelId);
  
  // ── Reconnect with exponential backoff ──
  const handleDisconnect = async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      reconnectState.reset();
      connection.once(VoiceConnectionStatus.Disconnected, handleDisconnect);
    } catch {
      connection.destroy();
      const delay = reconnectState.nextDelay();
      logger.info(`⚠️  Disconnected (attempt #${reconnectState.attempts}), rejoining in ${delay / 1000}s...`);
      
      if (reconnectState.attempts >= 5 && !reconnectState.textModeNotified) {
        reconnectState.textModeNotified = true;
        logger.error('🔴 Voice connection unstable after 5 reconnect attempts');
        if (postToTextChannel) postToTextChannel('⚠️ **Voice connection unstable.** Standing by in text mode. Will keep retrying.');
      }
      
      setTimeout(async () => {
        try {
          await joinChannel({ ...options, greeting: false });
          reconnectState.reset();
        } catch (err) {
          logger.error(`❌ Reconnect attempt #${reconnectState.attempts} failed: ${err.message}`);
        }
      }, delay);
    }
  };
  connection.once(VoiceConnectionStatus.Disconnected, handleDisconnect);
  
  // ── Audio Receiver ──
  setupAudioReceiver(connection, {
    onUserSpeech, onBargeIn, isSpeaking,
    allowedUsers, multiUser,
  });
  
  return connection;
}

/**
 * Set up audio receiver on a voice connection
 */
function setupAudioReceiver(connection, { onUserSpeech, onPartialAudio, onBargeIn, isSpeaking, allowedUsers, multiUser }) {
  const receiver = connection.receiver;
  const userSpeaking = new Map();
  const bargeInTimers = new Map();
  const SILENCE_THRESHOLD_MS = process.env.VAD_TIMEOUT ? parseInt(process.env.VAD_TIMEOUT) : 1500;
  const MIN_AUDIO_DURATION_MS = parseInt(process.env.MIN_AUDIO_DURATION_MS || '300', 10);
  const BARGE_IN_THRESHOLD_MS = 600;
  const MIN_AUDIO_RMS = parseFloat(process.env.MIN_AUDIO_RMS || '0.005');
  
  // Import OpusDecoder lazily to avoid circular deps
  let OpusDecoder;
  import('./opus-decoder.js').then(m => { OpusDecoder = m.OpusDecoder; });
  
  receiver.speaking.on('end', (userId) => {
    if (bargeInTimers.has(userId)) {
      clearTimeout(bargeInTimers.get(userId));
      bargeInTimers.delete(userId);
    }
  });
  
  receiver.speaking.on('start', (userId) => {
    if (!multiUser && !allowedUsers.includes(userId)) return;
    
    // Barge-in detection
    if (isSpeaking() && allowedUsers.includes(userId)) {
      if (!bargeInTimers.has(userId)) {
        const timer = setTimeout(() => {
          if (isSpeaking()) {
            logger.info(`⚡ Barge-in — stopping playback`);
            onBargeIn(userId);
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

      // Rolling partial STT — fire callback every 500ms while audio is collected
      const partialTimer = onPartialAudio ? setInterval(() => {
        if (chunks.length > 0) onPartialAudio(userId, Buffer.concat(chunks));
      }, 500) : null;

      audioStream.once('error', (err) => {
        if (partialTimer) clearInterval(partialTimer);
        logger.error(`Audio stream error for ${userId}:`, err.message);
        userSpeaking.delete(userId);
        decoder.destroy();
      });

      decoder.once('error', () => {});

      audioStream.once('end', async () => {
        if (partialTimer) clearInterval(partialTimer);
        userSpeaking.delete(userId);
        const totalBuffer = Buffer.concat(chunks);
        const durationMs = (totalBuffer.length / (48000 * 2)) * 1000;

        if (durationMs < MIN_AUDIO_DURATION_MS) return;

        // RMS energy gate — drop near-silence before it reaches Whisper
        // 16-bit signed PCM at 48kHz stereo
        const samples = new Int16Array(totalBuffer.buffer, totalBuffer.byteOffset, totalBuffer.length / 2);
        let sumSq = 0;
        for (let i = 0; i < samples.length; i++) {
          const norm = samples[i] / 32768;
          sumSq += norm * norm;
        }
        const rms = Math.sqrt(sumSq / samples.length);
        if (rms < MIN_AUDIO_RMS) {
          logger.info(`🔇 RMS energy gate: ${rms.toFixed(5)} < ${MIN_AUDIO_RMS} — dropping ${durationMs.toFixed(0)}ms audio`);
          return;
        }

        onUserSpeech(userId, totalBuffer);
      });
      
      userSpeaking.set(userId, { startTime: Date.now() });
    }
  });
}
