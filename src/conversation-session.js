const logger = require('./logger.js');
/**
 * Conversation Session Manager
 * 
 * When others are present in voice, manages the wake word → stop word flow:
 * 1. "Hey Jarvis" → enter listening mode
 * 2. Accumulate utterances across silence gaps
 * 3. "Thanks" / stop word → process accumulated command
 * 4. 5s total silence → auto-process
 * 
 * When alone, this is bypassed — utterances go straight to gateway.
 */

const STOP_PHRASES = [
  'thanks jarvis', 'thank you jarvis', 'thanks travis',
  'thanks', 'thank you', 'cheers',
  "that's all", "that's it", 'dismissed',
  'over', 'over and out',
];

const LISTEN_TIMEOUT_MS = 5000; // 5s silence = auto-process

export class ConversationSession {
  constructor() {
    this.listening = false;        // Currently in listening mode
    this.utterances = [];          // Accumulated utterance texts
    this.timeoutHandle = null;     // Auto-process timer
    this.onComplete = null;        // Callback when command is ready
    this.userId = null;
  }

  /**
   * Check if text contains a stop phrase.
   * Returns { isStop: boolean, cleanedText: string }
   */
  static checkStopWord(transcript) {
    const lower = transcript.toLowerCase().trim();
    
    for (const phrase of STOP_PHRASES) {
      // Stop phrase is the entire utterance
      if (lower === phrase || lower === phrase + '.') {
        return { isStop: true, cleanedText: '' };
      }
      // Stop phrase at the end: "check the weather thanks jarvis"
      if (lower.endsWith(phrase)) {
        const cleaned = transcript.substring(0, transcript.length - phrase.length).trim();
        return { isStop: true, cleanedText: cleaned };
      }
    }
    
    return { isStop: false, cleanedText: transcript };
  }

  /**
   * Start listening mode after wake word detected.
   * @param {string} userId - Discord user ID
   * @param {string} initialText - Text after wake word was stripped
   * @param {Function} onComplete - Called with accumulated command when done
   */
  startListening(userId, initialText, onComplete) {
    this.listening = true;
    this.utterances = [];
    this.userId = userId;
    this.onComplete = onComplete;
    
    if (initialText && initialText.trim()) {
      // Check if initial text already has a stop word
      const { isStop, cleanedText } = ConversationSession.checkStopWord(initialText);
      if (cleanedText) this.utterances.push(cleanedText);
      if (isStop) {
        this._complete();
        return;
      }
    }
    
    this._resetTimeout();
    logger.info(`🎧 Listening mode ON — waiting for command (stop word or ${LISTEN_TIMEOUT_MS/1000}s silence)`);
  }

  /**
   * Add a new utterance while in listening mode.
   * @param {string} transcript - New transcribed text
   * @returns {boolean} true if still listening, false if session completed
   */
  addUtterance(transcript) {
    if (!this.listening) return false;
    
    const { isStop, cleanedText } = ConversationSession.checkStopWord(transcript);
    
    if (cleanedText) {
      this.utterances.push(cleanedText);
    }
    
    if (isStop) {
      logger.info(`🛑 Stop word detected — processing command`);
      this._complete();
      return false;
    }
    
    // Reset the silence timeout
    this._resetTimeout();
    return true;
  }

  /**
   * Check if currently in listening mode for a given user
   */
  isListening(userId) {
    return this.listening && this.userId === userId;
  }

  /**
   * Cancel listening mode without processing
   */
  cancel() {
    this._cleanup();
    logger.info(`🎧 Listening mode cancelled`);
  }

  _resetTimeout() {
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    this.timeoutHandle = setTimeout(() => {
      if (this.listening) {
        logger.info(`⏰ Listen timeout (${LISTEN_TIMEOUT_MS/1000}s silence) — processing command`);
        this._complete();
      }
    }, LISTEN_TIMEOUT_MS);
  }

  _complete() {
    const fullCommand = this.utterances.join(' ').trim();
    const callback = this.onComplete;
    this._cleanup();
    
    if (fullCommand && callback) {
      logger.info(`🎧 Full command: "${fullCommand}"`);
      callback(fullCommand);
    } else {
      logger.info(`🎧 Empty command — ignoring`);
    }
  }

  _cleanup() {
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    this.timeoutHandle = null;
    this.listening = false;
    this.utterances = [];
    this.onComplete = null;
    this.userId = null;
  }
}

export { STOP_PHRASES };
