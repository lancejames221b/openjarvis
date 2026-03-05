/**
 * TTS Pipeline - Properly throttled parallel generation with ordered playback
 * 
 * Key fix: TTS generation only STARTS when a slot is free.
 * Previous version fired all requests immediately and only gated the return.
 */

export class TtsPipeline {
  constructor(synthesizeFn, audioQueue, options = {}) {
    this.synthesize = synthesizeFn;
    this.audioQueue = audioQueue;
    this.maxConcurrent = options.maxConcurrent || 3;
    this.onError = options.onError || ((err) => console.error('TTS pipeline error:', err));
    
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
   */
  add(sentence) {
    if (this._cleared) return;
    const index = this.nextIndex++;
    this.queue.push({ sentence, index });
    this._processQueue();
  }
  
  /**
   * Process queued sentences up to maxConcurrent
   */
  _processQueue() {
    while (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      const { sentence, index } = this.queue.shift();
      this.activeCount++;
      
      console.log(`🎬 TTS: Generating sentence ${index} (${this.activeCount}/${this.maxConcurrent} active)`);
      
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
   * Play completed sentences in order
   */
  _playReady() {
    while (this.completed.has(this.nextPlayIndex)) {
      const audio = this.completed.get(this.nextPlayIndex);
      this.completed.delete(this.nextPlayIndex);
      if (audio) {
        console.log(`🎵 TTS: Playing sentence ${this.nextPlayIndex}`);
        this.audioQueue.add(audio);
      }
      this.nextPlayIndex++;
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
