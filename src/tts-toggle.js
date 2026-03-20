/**
 * TTS Provider + Wake Word Toggle
 *
 * Handles voice and text commands to switch TTS provider and wake word.
 *
 * Providers:
 *   edge        — Edge TTS (en-GB-SoniaNeural) — cloud, no GPU
 *   piper       — Piper TTS (JARVIS voice clone) — local, CPU
 *   chatterbox  — Chatterbox TTS (Lance voice clone) — local, GPU
 *   lance       — alias for chatterbox + sets wake word to "lance"
 *
 * Voice command patterns (handled via isTtsToggleCommand):
 *   "switch to edge / piper / chatterbox / lance"
 *   "use edge / piper / chatterbox / lance voice"
 *
 * Text command: /jvoice [edge|piper|chatterbox|lance|status]
 *   Handled in index.js — calls setTtsProvider() / setWakeWord() from here.
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = `${__dirname}/../.env`;

// ── Provider display metadata ─────────────────────────────────────────────────
export const TTS_PROVIDERS = {
  edge:        { label: 'Edge TTS (Sonia)',         wakeWord: null },
  piper:       { label: 'Piper TTS (JARVIS)',        wakeWord: null },
  chatterbox:  { label: 'Chatterbox (Lance clone)',  wakeWord: null },
  lance:       { label: 'Chatterbox (Lance clone)',  wakeWord: 'lance', actualProvider: 'chatterbox' },
};

// ── Voice toggle patterns ─────────────────────────────────────────────────────
// "switch to edge/piper/chatterbox/lance", "use lance voice", etc.
const TTS_TOGGLE_PATTERNS = [
  /\b(switch|change)\s+to\s+(edge|piper|ryan|jarvis|chatterbox|lance)\b/i,
  /\buse\s+(edge|piper|ryan|jarvis|chatterbox|lance)\s*(voice|tts)?\b/i,
];

/**
 * Check if transcript is a TTS toggle voice command.
 * @param {string} transcript
 * @returns {string|null} canonical provider name, or null
 */
export function isTtsToggleCommand(transcript) {
  const clean = transcript.trim().toLowerCase();

  for (const pattern of TTS_TOGGLE_PATTERNS) {
    const match = clean.match(pattern);
    if (match) {
      const raw = match[match.length - 1].toLowerCase();
      return normalizeProvider(raw);
    }
  }
  return null;
}

/**
 * Normalize provider aliases to canonical names.
 */
function normalizeProvider(raw) {
  switch (raw) {
    case 'ryan':
    case 'edge':     return 'edge';
    case 'jarvis':
    case 'piper':    return 'piper';
    case 'lance':    return 'lance';
    case 'chatterbox': return 'chatterbox';
    default:         return null;
  }
}

// ── .env read / write helpers ─────────────────────────────────────────────────

function readEnv() {
  try { return readFileSync(ENV_FILE, 'utf-8'); }
  catch { return ''; }
}

function writeEnv(content) {
  writeFileSync(ENV_FILE, content, 'utf-8');
}

function setEnvKey(content, key, value) {
  const pattern = new RegExp(`^${key}=.*`, 'm');
  const line = `${key}=${value}`;
  return content.match(pattern)
    ? content.replace(pattern, line)
    : content + `\n${line}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get current TTS provider from process.env (set at startup or by setTtsProvider).
 */
export function getCurrentTtsProvider() {
  return (process.env.TTS_PROVIDER || 'edge').toLowerCase();
}

/**
 * Get current wake word from process.env.
 */
export function getCurrentWakeWord() {
  return (process.env.VOICE_WAKE_WORD || 'sonia').toLowerCase();
}

/**
 * Switch TTS provider — hot-apply to process.env + persist to .env.
 * If provider is "lance", also calls setWakeWord("lance").
 *
 * @param {string} provider — "edge" | "piper" | "chatterbox" | "lance"
 * @returns {{ ok: boolean, provider: string, wakeWordChanged: boolean, needsRestart: boolean }}
 */
export function setTtsProvider(provider) {
  const canonical = normalizeProvider(provider);
  if (!canonical) {
    logger.warn(`setTtsProvider: unknown provider "${provider}"`);
    return { ok: false };
  }

  // "lance" = chatterbox + wake word change
  const actualProvider = TTS_PROVIDERS[canonical]?.actualProvider ?? canonical;
  const newWakeWord    = TTS_PROVIDERS[canonical]?.wakeWord ?? null;

  try {
    let env = readEnv();
    env = setEnvKey(env, 'TTS_PROVIDER', actualProvider);
    writeEnv(env);

    // Hot-apply TTS provider immediately (getTTSProvider() reads process.env each call)
    process.env.TTS_PROVIDER = actualProvider;

    logger.info(`🔊 TTS provider → ${actualProvider} (was ${getCurrentTtsProvider()})`);

    let wakeWordChanged = false;
    let needsRestart = false;

    if (newWakeWord) {
      const wwr = setWakeWord(newWakeWord);
      wakeWordChanged = wwr.ok;
      needsRestart    = wwr.needsRestart;
    }

    return { ok: true, provider: actualProvider, wakeWordChanged, needsRestart };
  } catch (err) {
    logger.error('setTtsProvider failed:', err.message);
    return { ok: false };
  }
}

/**
 * Change the wake word — persists to .env.
 * Requires service restart to take effect (wake word is read at module init).
 *
 * @param {string} word — e.g. "lance", "sonia", "jarvis"
 * @returns {{ ok: boolean, needsRestart: boolean }}
 */
export function setWakeWord(word) {
  const ww = word.toLowerCase().trim();
  try {
    let env = readEnv();
    env = setEnvKey(env, 'VOICE_WAKE_WORD', ww);
    writeEnv(env);
    logger.info(`🎯 Wake word → ${ww} (restart required to activate)`);
    return { ok: true, needsRestart: true };
  } catch (err) {
    logger.error('setWakeWord failed:', err.message);
    return { ok: false, needsRestart: false };
  }
}
