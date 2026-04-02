/**
 * TTS Provider + Wake Word Toggle
 *
 * Handles voice and text commands to switch TTS provider and wake word.
 *
 * Providers:
 *   edge        — Edge TTS (en-GB-SoniaNeural) — cloud, no GPU
 *   piper       — Piper TTS (JARVIS voice clone) — local, CPU
 *   chatterbox  — Chatterbox TTS (owner voice clone) — local, GPU
 *   owner       — alias for chatterbox + sets wake word to owner's name
 *
 * Voice command patterns (handled via isTtsToggleCommand):
 *   "switch to edge / piper / chatterbox / owner"
 *   "use edge / piper / chatterbox / owner voice"
 *
 * Text command: /jvoice [edge|piper|chatterbox|owner|status]
 *   Handled in index.js — calls setTtsProvider() / setWakeWord() from here.
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = `${__dirname}/../.env`;

// ── Provider display metadata ─────────────────────────────────────────────────
// Wake words are read from .env at call time (JVOICE_WAKE_<PROVIDER>=<word>).
// "owner" is a named alias for chatterbox that also sets the wake word.
export const TTS_PROVIDERS = {
  edge:        { label: 'Edge TTS (Sonia)',         actualProvider: 'edge' },
  piper:       { label: 'Piper TTS (JARVIS)',        actualProvider: 'piper' },
  chatterbox:  { label: 'Chatterbox (Owner clone)',  actualProvider: 'chatterbox' },
  owner:       { label: 'Chatterbox (Owner clone)',  actualProvider: 'chatterbox' },
};

/**
 * Get the configured wake word for a provider from env (JVOICE_WAKE_<PROVIDER>).
 * Returns null if not set (meaning: don't change the wake word).
 */
export function getProviderWakeWord(provider) {
  const key = `JVOICE_WAKE_${provider.toUpperCase()}`;
  const val = (process.env[key] || '').trim();
  return val || null;
}

// ── Voice toggle patterns ─────────────────────────────────────────────────────
// "switch to edge/piper/chatterbox/owner", "use owner voice", etc.
const TTS_TOGGLE_PATTERNS = [
  /\b(switch|change)\s+to\s+(edge|piper|ryan|jarvis|chatterbox|owner)\b/i,
  /\buse\s+(edge|piper|ryan|jarvis|chatterbox|owner)\s*(voice|tts)?\b/i,
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
    case 'owner':    return 'owner';
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
 * If provider is "owner", also calls setWakeWord(the configured owner wake word).
 *
 * @param {string} provider — "edge" | "piper" | "chatterbox" | "owner"
 * @returns {{ ok: boolean, provider: string, wakeWordChanged: boolean, needsRestart: boolean }}
 */
export function setTtsProvider(provider) {
  const canonical = normalizeProvider(provider);
  if (!canonical) {
    logger.warn(`setTtsProvider: unknown provider "${provider}"`);
    return { ok: false };
  }

  // Resolve alias (e.g. "owner" → "chatterbox") and look up configured wake word
  const actualProvider = TTS_PROVIDERS[canonical]?.actualProvider ?? canonical;
  const newWakeWord    = getProviderWakeWord(canonical);

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
 * @param {string} word — e.g. "owner", "sonia", "jarvis"
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
