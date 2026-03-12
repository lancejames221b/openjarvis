import logger from './logger.js';
/**
 * TTS Pipeline - Properly throttled parallel generation with ordered playback
 * 
 * Key fix: TTS generation only STARTS when a slot is free.
 * Previous version fired all requests immediately and only gated the return.
 */

const MAX_QUEUE_SIZE = parseInt(process.env.TTS_QUEUE_MAX ?? '30');

export class TtsPipeline {
  constructor(synthesizeFn, audioQueue, options = {}) {
    this.synthesize = synthesizeFn;
    this.audioQueue = audioQueue;
    this.maxConcurrent = options.maxConcurrent || 3;
    this.onError = options.onError || ((err) => logger.error('TTS pipeline error:', err));
    
    this.queue = [];          // Sentences waiting to start TTS
    this.inFlight = [];       // { index, promise, audio, ready, failed }
    this.completed = new Map(); // index -> audio (completed but not yet played)
    this.nextPlayIndex = 0;   // Next index to play
    this.nextIndex = 0;       // Next sentence counter
    this.activeCount = 0;     // Currently generating
    this._drainResolve = null;
    this._cleared = false;
  }
  
  /**
   * Add a sentence. Returns immediately — generation starts when a slot opens.
   * Drops the oldest queued item if queue exceeds MAX_QUEUE_SIZE.
   */
  add(sentence) {
    if (this._cleared) return;
    const index = this.nextIndex++;
    this.queue.push({ sentence, index });

    if (this.queue.length > MAX_QUEUE_SIZE) {
      const dropped = this.queue.shift();
      logger.warn(`[tts] Queue full (${this.queue.length + 1}/${MAX_QUEUE_SIZE}), dropping oldest sentence (index ${dropped.index})`);
    }

    this._processQueue();
  }
  
  /**
   * Process queued sentences up to maxConcurrent
   */
  _processQueue() {
    while (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      const { sentence, index } = this.queue.shift();
      this.activeCount++;
      
      logger.info({ sentenceIndex: index, active: this.activeCount, maxConcurrent: this.maxConcurrent }, '🎬 tts generating sentence');
      
      this.synthesize(sentence)
        .then(audio => {
          if (this._cleared) return;
          this.completed.set(index, audio);
          this.activeCount--;
          this._playReady();
          this._processQueue(); // Start next queued sentence
        })
        .catch(err => {
          if (this._cleared) return;
          this.onError(err);
          this.completed.set(index, null); // Mark as failed, skip
          this.activeCount--;
          this._playReady();
          this._processQueue();
        });
    }
  }
  
  /**
   * Play completed sentences in order.
   * Prunes the completed Map if it grows beyond MAX_QUEUE_SIZE * 2.
   */
  _playReady() {
    while (this.completed.has(this.nextPlayIndex)) {
      const audio = this.completed.get(this.nextPlayIndex);
      this.completed.delete(this.nextPlayIndex);
      if (audio) {
        logger.info({ sentenceIndex: this.nextPlayIndex }, '🎵 tts playing sentence');
        this.audioQueue.add(audio);
      }
      this.nextPlayIndex++;
    }

    // Prune completed Map if it has grown too large (e.g. playback fell behind)
    const completedCap = MAX_QUEUE_SIZE * 2;
    if (this.completed.size > completedCap) {
      const sortedKeys = [...this.completed.keys()].sort((a, b) => a - b);
      const toRemove = sortedKeys.slice(0, this.completed.size - completedCap);
      for (const k of toRemove) {
        this.completed.delete(k);
      }
      logger.warn(`[tts] completed Map pruned ${toRemove.length} old entries (was over ${completedCap} cap)`);
    }

    // If everything is done, resolve drain
    if (this._drainResolve && this.queue.length === 0 && this.activeCount === 0 && this.completed.size === 0) {
      this._drainResolve();
      this._drainResolve = null;
    }
  }
  
  /**
   * Wait for all pending TTS to complete and play
   */
  drain() {
    if (this.queue.length === 0 && this.activeCount === 0 && this.completed.size === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this._drainResolve = resolve;
    });
  }
  
  /**
   * Cancel everything
   */
  clear() {
    this._cleared = true;
    this.queue = [];
    this.completed.clear();
    this.activeCount = 0;
    if (this._drainResolve) {
      this._drainResolve();
      this._drainResolve = null;
    }
  }
}
