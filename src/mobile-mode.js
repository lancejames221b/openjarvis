/**
 * Mobile / On-the-Go Mode
 *
 * When active: running-commentary narration, sub-agent live spoken updates.
 * Good for walking/driving/hands-free technical work — reverse engineering,
 * code analysis, security investigations, anything where you want the live feel
 * of an analyst narrating alongside you.
 *
 * Enable:  "I'm on the go" / "mobile mode on" / "heading out"
 * Disable: "I'm at my desk" / "at a screen" / "mobile mode off"
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = `${__dirname}/../.env`;

const MOBILE_ON_PATTERNS = [
  /\bI'?m\s+on\s+the\s+go\b/i,
  /\bon\s+the\s+go\s+mode\b/i,
  /\bmobile\s+mode\s+on\b/i,
  /\bturn\s+on\s+mobile\s+mode\b/i,
  /\bI'?m\s+heading\s+out\b/i,
  /\bheading\s+out\b/i,
  /\bgoing\s+mobile\b/i,
  /\bI'?m\s+(mobile|walking|on\s+the\s+move)\b/i,
];

const MOBILE_OFF_PATTERNS = [
  /\bI'?m\s+(back\s+)?(at|on)\s+(my\s+)?(desk|screen|laptop|computer)\b/i,
  /\bat\s+a\s+screen\b/i,
  /\bmobile\s+mode\s+off\b/i,
  /\bturn\s+off\s+mobile\s+mode\b/i,
  /\bI'?ve?\s+got\s+a\s+screen\b/i,
  /\bdesk\s+mode\b/i,
  /\bI'?m\s+home\b/i,
  /\bback\s+home\b/i,
];

/**
 * Check if transcript is a mobile mode toggle command.
 * @param {string} transcript
 * @returns {true|false|null} true=enable, false=disable, null=not a toggle
 */
export function isMobileModeToggle(transcript) {
  const clean = transcript.trim();
  if (MOBILE_ON_PATTERNS.some(p => p.test(clean))) return true;
  if (MOBILE_OFF_PATTERNS.some(p => p.test(clean))) return false;
  return null;
}

/**
 * Read current mobile mode state from .env
 */
export function isMobileModeEnabled() {
  try {
    const envContent = readFileSync(ENV_FILE, 'utf-8');
    const match = envContent.match(/^VOICE_MOBILE_MODE=(true|false)$/m);
    return match ? match[1] === 'true' : false;
  } catch {
    return false;
  }
}

/**
 * Persist mobile mode state to .env
 */
export function setMobileMode(enabled) {
  try {
    let envContent = readFileSync(ENV_FILE, 'utf-8');
    const pattern = /^VOICE_MOBILE_MODE=.*/m;
    const newLine = `VOICE_MOBILE_MODE=${enabled}`;
    if (envContent.match(pattern)) {
      envContent = envContent.replace(pattern, newLine);
    } else {
      envContent += `\n${newLine}`;
    }
    writeFileSync(ENV_FILE, envContent, 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to update VOICE_MOBILE_MODE in .env:', err.message);
    return false;
  }
}
