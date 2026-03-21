// SimulStreaming STT via WhisperLiveKit WebSocket
// One session per speaking user — streams 16kHz PCM chunks in real time.
// Protocol: connect → receive config → send raw PCM → receive partial/confirmed lines → send EOF → done.

import WebSocket from 'ws';
import logger from './logger.js';

const STT_STREAMING_URL = process.env.STT_STREAMING_URL || 'ws://127.0.0.1:8769/asr';

// Resample 48kHz 16-bit mono PCM → 16kHz (simple 3:1 decimation)
function resample48to16(buf) {
  const samples = buf.length / 2; // 16-bit samples
  const outSamples = Math.floor(samples / 3);
  const out = Buffer.allocUnsafe(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const v = buf.readInt16LE(i * 3 * 2);
    out.writeInt16LE(v, i * 2);
  }
  return out;
}

export class StreamingSTTSession {
  constructor(userId, { onPartial, onConfirmed } = {}) {
    this.userId = userId;
    this.onPartial = onPartial || (() => {});
    this.onConfirmed = onConfirmed || (() => {});
    this.ws = null;
    this.ready = false;
    this.finalText = null;
    this._resolveFinished = null;
    this._finished = new Promise(r => { this._resolveFinished = r; });
    this._confirmedLines = [];
    this._connect();
  }

  _connect() {
    const ws = new WebSocket(STT_STREAMING_URL);
    this.ws = ws;

    ws.on('open', () => {
      logger.debug(`[SimulStream] WS open for ${this.userId}`);
      this.ready = true;
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'config') return; // initial handshake

      if (msg.status === 'active_transcription' || msg.status === 'no_audio_detected') {
        // Confirmed lines
        if (Array.isArray(msg.lines)) {
          for (const line of msg.lines) {
            if (line.text && !this._confirmedLines.includes(line.text)) {
              this._confirmedLines.push(line.text);
              this.onConfirmed(line.text, this.userId);
            }
          }
        }
        // Partial hypothesis
        if (msg.buffer_transcription) {
          this.onPartial(msg.buffer_transcription, this.userId);
        }
      }
    });

    ws.on('error', (err) => {
      logger.warn(`[SimulStream] WS error for ${this.userId}: ${err.message}`);
      this._finish();
    });

    ws.on('close', () => {
      logger.debug(`[SimulStream] WS closed for ${this.userId}`);
      this._finish();
    });
  }

  sendChunk(pcm48kBuf) {
    if (!this.ready || this.ws.readyState !== WebSocket.OPEN) return;
    const pcm16k = resample48to16(pcm48kBuf);
    this.ws.send(pcm16k);
  }

  // Signal end of audio, returns the final confirmed transcript (or null)
  async finish() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ eof: 1 })); } catch {}
    }
    // Give server up to 3s to send final lines before we give up
    const timeout = new Promise(r => setTimeout(r, 3000));
    await Promise.race([this._finished, timeout]);
    return this._confirmedLines.join(' ').trim() || null;
  }

  _finish() {
    if (this._resolveFinished) {
      this._resolveFinished();
      this._resolveFinished = null;
    }
  }

  destroy() {
    this._finish();
    try { if (this.ws) this.ws.terminate(); } catch {}
  }
}
