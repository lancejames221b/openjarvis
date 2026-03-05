/**
 * Opus Decoder Transform Stream
 * 
 * Decodes Discord's Opus audio frames to raw PCM (48kHz, 16-bit, mono)
 * Uses prism-media for the actual decoding
 */

import { Transform } from 'stream';
import prism from 'prism-media';

export class OpusDecoder extends Transform {
  constructor() {
    super();
    this.decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 1,
      rate: 48000,
    });
    
    this.decoder.on('data', (chunk) => {
      this.push(chunk);
    });
    
    this.decoder.on('error', (err) => {
      // Ignore decode errors (corrupted frames happen)
      console.debug('Opus decode error:', err.message);
    });
  }
  
  _transform(chunk, encoding, callback) {
    try {
      this.decoder.write(chunk);
    } catch (err) {
      // Swallow decode errors
    }
    callback();
  }
  
  _flush(callback) {
    try { this.decoder.end(); } catch {}
    callback();
  }
  
  _destroy(err, callback) {
    // Clean up native libopus resources even if stream is destroyed without flush
    try { this.decoder.destroy(); } catch {}
    callback(err);
  }
}
