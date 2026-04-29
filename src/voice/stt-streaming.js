// SimulStreaming STT via WhisperLiveKit WebSocket
// One session per speaking user — streams 16kHz PCM chunks in real time.
// Protocol: connect → receive config → send raw PCM → receive partial/confirmed lines → send EOF → done.

import WebSocket from 'ws';
import logger from '../logger.js';

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

/**
 * Clean up WhisperLiveKit streaming artifacts:
 * - Remove standalone dash tokens (silence hallucinations: "- - -")
 * - Deduplicate consecutive repeated words (model repetition loops)
 */
function cleanTranscript(text) {
  if (!text) return '';

  // Remove standalone dashes/hyphens (hallucinated silence markers)
  let t = text.replace(/(?<!\w)-+(?!\w)/g, ' ');

  // Deduplicate consecutive repeated words (case-insensitive exact match)
  // e.g. "Service Service Service" → "Service", "the the the" → "the"
  t = t.replace(/\b(\w[\w''-]*)\b([\s,.!?;:]*\b\1\b)+/gi, '$1');

  // Stem dedup: collapse consecutive words sharing the same 5-char prefix
  // e.g. "deploy deploys Deploy Deployees Deploy's" → "deploy"
  // Only triggers for words ≥ 6 chars to avoid over-collapsing short words
  {
    const tokens = t.split(/(\s+)/); // preserve whitespace tokens
    const out = [];
    let lastStem = null;
    let lastWord = null;
    for (const tok of tokens) {
      if (/^\s+$/.test(tok)) {
        out.push(tok);
        continue;
      }
      const clean = tok.replace(/[^a-zA-Z''-]/g, '');
      if (clean.length >= 6) {
        const stem = clean.toLowerCase().slice(0, 5);
        if (stem === lastStem) {
          // Same stem — drop this token (remove trailing whitespace too)
          if (out.length && /^\s+$/.test(out[out.length - 1])) out.pop();
          continue;
        }
        lastStem = stem;
      } else {
        lastStem = null; // reset stem tracking on short words
      }
      lastWord = clean;
      out.push(tok);
    }
    t = out.join('');
  }

  // Collapse multiple spaces
  t = t.replace(/\s{2,}/g, ' ').trim();

  // Strip leading punctuation/space artifacts
  t = t.replace(/^[\s,.\-!?;:]+/, '');

  // Strip trailing artifacts but preserve sentence-ending punctuation
  t = t.replace(/[\s,.\-!?;:]+$/, (m) =>
    m.includes('.') || m.includes('?') || m.includes('!') ? m.trim().slice(-1) : ''
  );

  return t.trim();
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
    // Use only the last confirmed line — WhisperLiveKit sends incremental
    // rolling confirmations. The last line is the most complete version,
    // then clean hallucination artifacts (dashes, repeated words).
    const last = this._confirmedLines[this._confirmedLines.length - 1];
    return cleanTranscript(last || '') || null;
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
