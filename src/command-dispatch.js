/**
 * Command dispatch — intent routing
 * Routes cleaned transcript → action (mode toggle, enrollment command, interrupt, brain call).
 * Returns a dispatch result that index.js acts on.
 */

import logger from './logger.js';
import { tryShortcut } from './shortcut-engine.js';
import { isTldrToggleCommand, setTldrMode, isTranscriptToggleCommand, setTranscriptMode } from './tldr-mode.js';
import { isMobileModeToggle, setMobileMode } from './mobile-mode.js';
import { isTtsToggleCommand, setTtsProvider } from './tts-toggle.js';
import { shouldDismiss, isSideTalk } from './intent-classifier.js';
import { switchPersona, listPersonalities, getActivePersona } from './brain.js';
import { setFocusByName, setFocusWithThread, clearFocus, getFocus, listChannels } from './focus-state.js';

// ── Interrupt pattern detection ───────────────────────────────────────

const INTERRUPT_PATTERNS = [
  /^(jarvis\s*[,.]?\s*)?(stop|cancel|abort|shut up|be quiet|enough|nevermind|never mind|hold on|wait)\.?$/i,
  /^(jarvis\s*[,.]?\s*)?(stop|cancel)\s+(that|it|talking|speaking|please|now)\.?$/i,
  /^(jarvis\s*[,.]?\s*)?that's\s+(enough|ok|okay|fine)\.?$/i,
];

export function isInterruptCommand(transcript) {
  const clean = transcript.trim().replace(/[.,!?;:]+$/g, '');
  return INTERRUPT_PATTERNS.some(p => p.test(clean));
}

// ── Stop word filter ──────────────────────────────────────────────────

const STOP_WORDS = ['sounds good', 'thank you', 'thanks', 'obviously', 'ok', 'okay'];

/**
 * Route a cleaned transcript to an action.
 *
 * @param {string} rawTranscript - original (pre-wake-word-strip) transcript
 * @param {string} cleanedTranscript - wake-word-stripped, lowercased transcript
 * @param {string} userId
 * @param {string[]} allowedUsers
 * @param {object} enrollmentState - enrollment state object from auth.js
 * @returns {object} dispatch result:
 *   { type: 'mode_toggle' | 'enrollment' | 'interrupt' | 'stop_word' | 'side_talk' | 'bare_wake' | 'brain', ... }
 */
export async function dispatchCommand(rawTranscript, cleanedTranscript, userId, allowedUsers, enrollmentState) {
  const isAdmin = allowedUsers.includes(userId);

  // ── TL;DR mode toggle ──────────────────────────────────────────────
  const tldrToggle = isAdmin ? isTldrToggleCommand(rawTranscript) : null;
  if (tldrToggle !== null) {
    const success = setTldrMode(tldrToggle);
    return { type: 'mode_toggle', mode: 'tldr', enabled: tldrToggle, success };
  }

  // ── Full transcript mode toggle ────────────────────────────────────
  const transcriptToggle = isAdmin ? isTranscriptToggleCommand(rawTranscript) : null;
  if (transcriptToggle !== null) {
    const success = setTranscriptMode(transcriptToggle);
    return { type: 'mode_toggle', mode: 'transcript', enabled: transcriptToggle, success };
  }

  // ── TTS provider toggle ────────────────────────────────────────────
  const ttsToggle = isAdmin ? isTtsToggleCommand(rawTranscript) : null;
  if (ttsToggle) {
    const result = setTtsProvider(ttsToggle);
    return { type: 'mode_toggle', mode: 'tts', provider: result.provider ?? ttsToggle, success: result.ok, needsRestart: result.needsRestart };
  }

  // ── Mobile mode toggle ─────────────────────────────────────────────
  const mobileToggle = isAdmin ? isMobileModeToggle(rawTranscript) : null;
  if (mobileToggle !== null) {
    const success = setMobileMode(mobileToggle);
    return { type: 'mode_toggle', mode: 'mobile', enabled: mobileToggle, success };
  }

  // ── Persona switch ────────────────────────────────────────────────
  if (isAdmin) {
    // "switch to snoop" / "be snoop" / "use jarvis" / "jarvis persona" / "switch persona to alfred"
    // "switch to snoop voice" / "snoop voice" / "snoop mode" are also valid triggers
    const personaMatch = cleanedTranscript.match(/(?:switch\s+(?:to|persona\s+to)|be|use|load|activate)\s+([a-zA-Z0-9_-]+)(?:\s+(?:persona|mode|personality|voice))?$/i)
      || cleanedTranscript.match(/([a-zA-Z0-9_-]+)\s+(?:persona|mode|personality|voice)$/i);
    if (personaMatch) {
      const requested = personaMatch[1].toLowerCase();
      const available = listPersonalities();
      if (available.includes(requested)) {
        const p = switchPersona(requested);
        return { type: 'persona_switch', persona: p.name, voice: p.voice, wakeWords: p.wakeWords };
      }
    }
    // "list personas" / "what personas" / "show personalities"
    if (/(?:list|show|what)\s+(?:personas?|personalities|voices)/i.test(cleanedTranscript)) {
      const available = listPersonalities();
      const current = getActivePersona().name;
      return { type: 'persona_list', available, current };
    }
  }

  // ── Channel focus commands ──────────────────────────────────────────
  if (isAdmin) {
    // "focus on gibson" / "switch to ewitness" / "work on gibson" / "focus ewitness"
    // Also handles threads: "focus on gibson gtm, the beta launch thread"
    //   / "switch to pr-reviews Contact3 thread" / "focus on jarvis voice dev"
    const focusMatch = cleanedTranscript.match(
      /(?:focus\s+(?:on\s+)?|switch\s+(?:to\s+)?|work\s+(?:on\s+)?)\s*([\w\s-]{1,40?}?)(?:\s*[,;]?\s*(?:the\s+)?([\w\s-]+?)\s+thread)?\s*$/i
    );
    if (focusMatch) {
      const target = focusMatch[1].trim();
      const threadHint = focusMatch[2]?.trim() || null; // e.g. "beta launch" or "Contact3"
      // Don't match persona/mode/tts commands that overlap
      const personas = listPersonalities();
      const nonFocusKeywords = new Set(['tldr', 'transcript', 'mobile', 'tts', 'piper', 'chatterbox', 'edge', ...personas]);
      if (!nonFocusKeywords.has(target.toLowerCase())) {
        if (threadHint) {
          // Thread focus: resolve channel + pass thread hint for Discord lookup
          const result = await setFocusWithThread(target, threadHint);
          if (result) {
            return { type: 'focus_set', channelName: result.channelName, channelId: result.channelId, purpose: result.purpose, threadName: result.threadName };
          }
        }
        const result = setFocusByName(target);
        if (result) {
          return { type: 'focus_set', channelName: result.channelName, channelId: result.channelId, purpose: result.purpose };
        }
        // Channel not found — fall through to brain (might be a different command)
      }
    }

    // "clear focus" / "unfocus" / "no focus" / "reset focus"
    if (/(?:clear|reset|remove|drop|no)\s*focus|unfocus/i.test(cleanedTranscript)) {
      clearFocus();
      return { type: 'focus_clear' };
    }

    // "where am i" / "what channel" / "what focus" / "what context"
    if (/(?:where\s+am\s+i|what\s+(?:channel|focus|context)|current\s+(?:focus|context))/i.test(cleanedTranscript)) {
      const focus = getFocus();
      return { type: 'focus_query', focus };
    }

    // "list channels" / "available channels" / "show channels"
    if (/(?:list|show|available|what)\s+channels/i.test(cleanedTranscript)) {
      const channels = listChannels();
      return { type: 'channel_list', channels };
    }
  }

  // ── Enrollment commands ────────────────────────────────────────────
  if (isAdmin) {
    const cancelEnrollMatch = cleanedTranscript.match(/^(cancel|stop)\s*enroll/i);
    if (cancelEnrollMatch && enrollmentState.active) {
      return { type: 'enrollment', action: 'cancel' };
    }

    const restartEnrollMatch = cleanedTranscript.match(/^(restart|redo|reset)\s*(enroll|enrollment|voice)/i);
    if (restartEnrollMatch) {
      return { type: 'enrollment', action: 'restart', restartMatch: restartEnrollMatch };
    }

    const learnMatch = cleanedTranscript.match(/^(learn\s*mode|add\s*(more\s*)?samples|improve\s*voice)/i);
    if (learnMatch) {
      return { type: 'enrollment', action: 'learn' };
    }

    const enrollMatch = rawTranscript.match(/(en\s*roll|in\s*roll|and\s*roll|can\s*roll|un\s*roll)\s*(my\s*)?voice/i);
    if (enrollMatch) {
      return { type: 'enrollment', action: 'start' };
    }
  }

  // ── Interrupt/stop ────────────────────────────────────────────────
  if (isAdmin && isInterruptCommand(rawTranscript)) {
    return { type: 'interrupt' };
  }

  // ── Bare wake word (empty after strip) ───────────────────────────
  const bareCheck = cleanedTranscript.replace(/[.,!?;:\-'"]/g, '').trim();
  if (!bareCheck || bareCheck.length === 0) {
    return { type: 'bare_wake' };
  }

  // ── Ambiguous single-word after wake strip — pass raw transcript to brain ──
  // e.g. "Jarvis voice" → stripped to "voice" → would confuse AI as TTS command
  // When stripped transcript is a single ambiguous word, restore context by using rawTranscript.
  const AMBIGUOUS_SINGLE_WORDS = new Set(['voice', 'audio', 'mode', 'model', 'channel']);
  const bareWords = bareCheck.split(/\s+/);
  if (bareWords.length === 1 && AMBIGUOUS_SINGLE_WORDS.has(bareWords[0].toLowerCase())) {
    logger.info(`[voice] ambiguous single word "${bareCheck}" — restoring full transcript context`);
    return { type: 'brain', transcript: rawTranscript };
  }

  // ── Stop word filter ──────────────────────────────────────────────
  const normalizedTranscript = cleanedTranscript.trim().toLowerCase().replace(/[.,!?]+$/, '');
  if (STOP_WORDS.includes(normalizedTranscript)) {
    logger.info(`[voice] stop word filtered: "${cleanedTranscript}"`);
    return { type: 'stop_word' };
  }

  // ── Dismiss / side-talk ───────────────────────────────────────────
  const dismissResult = shouldDismiss(cleanedTranscript);
  if (dismissResult.dismiss) {
    logger.info(`🤚 Stop word dismissed (${dismissResult.reason}): "${cleanedTranscript}"`);
    return { type: 'stop_word', reason: dismissResult.reason };
  }

  // Note: wakeWordUsed must be passed in; extracted from checkWakeWord result upstream
  // We can't call checkWakeWord here without the full pipeline context.
  // Callers must check isSideTalk separately if needed.

  // ── Shortcut fast-path (bypasses LLM for known commands) ────────────
  const shortcutResult = await tryShortcut(cleanedTranscript, null);
  if (shortcutResult.handled) {
    return { type: 'shortcut', speech: shortcutResult.speech, silent: shortcutResult.silent };
  }

  // ── Brain call ────────────────────────────────────────────────────
  return { type: 'brain', transcript: cleanedTranscript };
}
