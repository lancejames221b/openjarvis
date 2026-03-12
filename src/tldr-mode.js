/**
 * Voice TL;DR Mode
 * 
 * Feature: When enabled, long responses post to #jarvis-voice-text
 * and audio plays a condensed version. Toggle with "brief mode on/off" or "tldr on/off"
 * 
 * Persist setting to .env for restart persistence
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = `${__dirname}/../.env`;

// Toggle command patterns — detect "brief mode on", "tldr on", etc.
const TLDR_TOGGLE_PATTERNS = [
  /\b(brief|tldr)\s+mode\s+(on|off)\b/i,
  /\b(brief|tldr)\s+(on|off)\b/i,
  /\b(turn|switch)\s+(brief|tldr)\s+(on|off)\b/i,
];

// Full transcript mode toggle patterns
const TRANSCRIPT_TOGGLE_PATTERNS = [
  /\bfull\s+transcript\s+mode\s+(on|off)\b/i,
  /\btranscript\s+mode\s+(on|off)\b/i,
  /\b(turn|switch)\s+full\s+transcript\s+(on|off)\b/i,
];

// TL;DR threshold — only condense if response is longer than this
const TLDR_THRESHOLD_CHARS = 500;
const TLDR_MAX_LENGTH = 250;

/**
 * Check if transcript is a TL;DR mode toggle command
 * @param {string} transcript - User's speech transcript
 * @returns {boolean|null} true if "on", false if "off", null if not a toggle
 */
export function isTldrToggleCommand(transcript) {
  const clean = transcript.trim().toLowerCase();
  
  for (const pattern of TLDR_TOGGLE_PATTERNS) {
    const match = clean.match(pattern);
    if (match) {
      const action = match[match.length - 1].toLowerCase();
      return action === 'on' ? true : false;
    }
  }
  
  return null;
}

/**
 * Get current TL;DR mode state from .env
 * @returns {boolean}
 */
export function isTldrModeEnabled() {
  try {
    const envContent = readFileSync(ENV_FILE, 'utf-8');
    const match = envContent.match(/^VOICE_TLDR_MODE=(true|false)$/m);
    return match ? match[1] === 'true' : false;
  } catch {
    return false;
  }
}

/**
 * Update TL;DR mode in .env file
 * @param {boolean} enabled - Enable or disable
 * @returns {boolean} Success
 */
export function setTldrMode(enabled) {
  try {
    let envContent = readFileSync(ENV_FILE, 'utf-8');
    const pattern = /^VOICE_TLDR_MODE=.*/m;
    const newLine = `VOICE_TLDR_MODE=${enabled}`;
    
    if (envContent.match(pattern)) {
      envContent = envContent.replace(pattern, newLine);
    } else {
      envContent += `\n${newLine}`;
    }
    
    writeFileSync(ENV_FILE, envContent, 'utf-8');
    return true;
  } catch (err) {
    logger.error('Failed to update VOICE_TLDR_MODE in .env:', err.message);
    return false;
  }
}

/**
 * Generate a TL;DR summary of a long response
 * Uses simple extractive summarization: take first N sentences up to TLDR_MAX_LENGTH
 * 
 * @param {string} fullText - Full response text
 * @returns {string} Condensed version (or original if under threshold)
 */
export function generateTldr(fullText) {
  // Under threshold, return as-is
  if (!fullText || fullText.length < TLDR_THRESHOLD_CHARS) {
    return fullText;
  }
  
  // Split into sentences and accumulate until max length
  const sentences = fullText.match(/[^.!?]+[.!?]+/g) || [fullText];
  let summary = '';
  
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    
    // Add sentence if it fits
    if ((summary + trimmed).length <= TLDR_MAX_LENGTH) {
      summary += trimmed + ' ';
    } else {
      // Truncate last sentence and break
      const remaining = TLDR_MAX_LENGTH - summary.length;
      if (remaining > 20) {
        summary += trimmed.substring(0, remaining - 3) + '...';
      }
      break;
    }
  }
  
  return summary.trim() || fullText.substring(0, TLDR_MAX_LENGTH) + '...';
}

/**
 * Check if transcript is a full transcript mode toggle command
 * @param {string} transcript - User's speech transcript
 * @returns {boolean|null} true if "on", false if "off", null if not a toggle
 */
export function isTranscriptToggleCommand(transcript) {
  const clean = transcript.trim().toLowerCase();
  
  for (const pattern of TRANSCRIPT_TOGGLE_PATTERNS) {
    const match = clean.match(pattern);
    if (match) {
      const action = match[match.length - 1].toLowerCase();
      return action === 'on' ? true : false;
    }
  }
  
  return null;
}

/**
 * Get current full transcript mode state from .env
 * @returns {boolean}
 */
export function isTranscriptModeEnabled() {
  try {
    const envContent = readFileSync(ENV_FILE, 'utf-8');
    const match = envContent.match(/^VOICE_FULL_TRANSCRIPT_MODE=(true|false)$/m);
    return match ? match[1] === 'true' : false;
  } catch {
    return false;
  }
}

/**
 * Update full transcript mode in .env file
 * @param {boolean} enabled - Enable or disable
 * @returns {boolean} Success
 */
export function setTranscriptMode(enabled) {
  try {
    let envContent = readFileSync(ENV_FILE, 'utf-8');
    const pattern = /^VOICE_FULL_TRANSCRIPT_MODE=.*/m;
    const newLine = `VOICE_FULL_TRANSCRIPT_MODE=${enabled}`;
    
    if (envContent.match(pattern)) {
      envContent = envContent.replace(pattern, newLine);
    } else {
      envContent += `\n${newLine}`;
    }
    
    writeFileSync(ENV_FILE, envContent, 'utf-8');
    return true;
  } catch (err) {
    logger.error('Failed to update VOICE_FULL_TRANSCRIPT_MODE in .env:', err.message);
    return false;
  }
}

// ── Ask Mode (confirmation before action) ────────────────────────────

const ASK_MODE_TOGGLE_PATTERNS = [
  /\b(ask|confirm)\s+mode\s+(on|off)\b/i,
  /\b(ask|confirm)\s+(on|off)\b/i,
  /\b(turn|switch)\s+(ask|confirm)\s+(on|off)\b/i,
  /\b(ask|confirm)\s+before\s+(acting|doing|executing)\b/i,  // "ask before acting" → on
];

export function isAskModeToggleCommand(transcript) {
  const clean = transcript.trim().toLowerCase();
  for (const pattern of ASK_MODE_TOGGLE_PATTERNS) {
    const match = clean.match(pattern);
    if (match) {
      // "ask before acting" style → always on
      if (/before/i.test(clean)) return true;
      const action = match[match.length - 1].toLowerCase();
      return action === 'on' ? true : false;
    }
  }
  return null;
}

export function isAskModeEnabled() {
  try {
    const envContent = readFileSync(ENV_FILE, 'utf-8');
    const match = envContent.match(/^VOICE_ASK_MODE=(true|false)$/m);
    return match ? match[1] === 'true' : false;
  } catch {
    return false;
  }
}

export function setAskMode(enabled) {
  try {
    let envContent = readFileSync(ENV_FILE, 'utf-8');
    const pattern = /^VOICE_ASK_MODE=.*/m;
    const newLine = `VOICE_ASK_MODE=${enabled}`;
    if (envContent.match(pattern)) {
      envContent = envContent.replace(pattern, newLine);
    } else {
      envContent += `\n${newLine}`;
    }
    writeFileSync(ENV_FILE, envContent, 'utf-8');
    return true;
  } catch (err) {
    logger.error('Failed to update VOICE_ASK_MODE in .env:', err.message);
    return false;
  }
}

export { TLDR_THRESHOLD_CHARS, TLDR_MAX_LENGTH };
