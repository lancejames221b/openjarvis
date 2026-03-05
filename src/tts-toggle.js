/**
 * TTS Provider Toggle
 * 
 * Voice commands to switch between Edge TTS (Ryan) and Piper (JARVIS)
 * - "switch to edge" / "use edge" → Edge TTS with en-GB-RyanNeural
 * - "switch to piper" / "use piper" → Piper JARVIS voice
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = `${__dirname}/../.env`;

// TTS toggle patterns — "switch to edge", "use piper", etc.
const TTS_TOGGLE_PATTERNS = [
  /\b(switch|change)\s+to\s+(edge|piper|ryan|jarvis)\b/i,
  /\buse\s+(edge|piper|ryan|jarvis)\s+(voice|tts)?\b/i,
  /\b(edge|piper|ryan|jarvis)\s+voice\b/i,
];

/**
 * Check if transcript is a TTS toggle command
 * @param {string} transcript - User's speech transcript
 * @returns {string|null} "edge" or "piper", or null if not a toggle
 */
export function isTtsToggleCommand(transcript) {
  const clean = transcript.trim().toLowerCase();
  
  for (const pattern of TTS_TOGGLE_PATTERNS) {
    const match = clean.match(pattern);
    if (match) {
      const provider = match[match.length - 1].toLowerCase();
      // Map "ryan" → "edge", "jarvis" → "piper"
      if (provider === 'edge' || provider === 'ryan') return 'edge';
      if (provider === 'piper' || provider === 'jarvis') return 'piper';
    }
  }
  
  return null;
}

/**
 * Get current TTS provider from .env
 * @returns {string} "edge" or "piper"
 */
export function getCurrentTtsProvider() {
  try {
    const envContent = readFileSync(ENV_FILE, 'utf-8');
    const piperMatch = envContent.match(/^PIPER_ENABLED=(true|false)$/m);
    const piperEnabled = piperMatch ? piperMatch[1] === 'true' : false;
    return piperEnabled ? 'piper' : 'edge';
  } catch {
    return 'edge'; // Default
  }
}

/**
 * Switch TTS provider in .env
 * @param {string} provider - "edge" or "piper"
 * @returns {boolean} Success
 */
export function setTtsProvider(provider) {
  try {
    let envContent = readFileSync(ENV_FILE, 'utf-8');
    
    // Set PIPER_ENABLED based on provider
    const piperEnabled = provider === 'piper' ? 'true' : 'false';
    const piperPattern = /^PIPER_ENABLED=.*/m;
    const piperLine = `PIPER_ENABLED=${piperEnabled}`;
    
    if (envContent.match(piperPattern)) {
      envContent = envContent.replace(piperPattern, piperLine);
    } else {
      envContent += `\n${piperLine}`;
    }
    
    writeFileSync(ENV_FILE, envContent, 'utf-8');
    
    // Also update runtime env var so it takes effect immediately
    process.env.PIPER_ENABLED = piperEnabled;
    
    return true;
  } catch (err) {
    console.error('Failed to update TTS provider in .env:', err.message);
    return false;
  }
}
