/**
 * Command dispatch — intent routing
 * Routes cleaned transcript → action (mode toggle, enrollment command, interrupt, brain call).
 * Returns a dispatch result that index.js acts on.
 */

import logger from './logger.js';
import { tryShortcut } from './shortcut-engine.js';
import { isTldrToggleCommand, setTldrMode, isTranscriptToggleCommand, setTranscriptMode } from './tldr-mode.js';
import { isMobileModeToggle, setMobileMode } from './mobile-mode.js';
import { isVisualModeToggle, setVisualMode, setVisualTargetChannel } from './visual-mode.js';
import { isTtsToggleCommand, setTtsProvider } from './tts-toggle.js';
import { shouldDismiss, isSideTalk } from './intent-classifier.js';
import { switchPersona, listPersonalities, getActivePersona } from './brain.js';
import { setFocusByName, setFocusWithThread, clearFocus, getFocus, listChannels, refocus, getPreviousFocus } from './focus-state.js';
import { detectChannelCommand } from './channel-router.js';
import { fuzzyMatch } from './fuzzy-dispatch.js';
import { classifyIntent as haikuClassify } from './haiku-intent.js';

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

  // ── Visual mode toggle ─────────────────────────────────────────────
  // "visual mode on", "screen mode", "text only", "expanse mode" → visual on
  // "voice mode", "talk to me", "audio mode" → visual off
  // Also handles "visual mode in #channel" — enable + set target channel
  if (isAdmin) {
    // Check for combined "visual mode in <channel>" first
    const visualChannelMatch = rawTranscript.match(/(?:visual|screen|display|expanse)\s+mode\s+(?:in|to|for)\s+(?:#?)([\w-]+)/i);
    if (visualChannelMatch) {
      const channelTarget = visualChannelMatch[1];
      setVisualMode(true);
      // Try to resolve channel name to ID via focus-state
      const focusResult = setFocusByName(channelTarget);
      if (focusResult) {
        setVisualTargetChannel(focusResult.channelId);
        return { type: 'mode_toggle', mode: 'visual', enabled: true, success: true, channelName: focusResult.channelName, channelId: focusResult.channelId };
      }
      return { type: 'mode_toggle', mode: 'visual', enabled: true, success: true, channelName: channelTarget };
    }

    const visualToggle = isVisualModeToggle(rawTranscript);
    if (visualToggle !== null) {
      const success = setVisualMode(visualToggle);
      return { type: 'mode_toggle', mode: 'visual', enabled: visualToggle, success };
    }
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
    // Channel-router: detect move/focus/query actions from transcript
    // This wires the dead channel-router.js into the voice pipeline.
    const channelCmd = detectChannelCommand(rawTranscript);
    if (channelCmd.action === 'move') {
      // Physical voice channel hop — return to index.js for actual join
      return { type: 'voice_move', target: channelCmd.target };
    }
    // focus and query actions fall through to existing handlers below

    // "focus on gibson" / "switch to ewitness" / "work on gibson" / "focus ewitness"
    // "focus on the deploy channel" / "switch to the gibson channel"
    // Also handles threads: "focus on gibson gtm, the beta launch thread"
    //   / "switch to pr-reviews team-member thread" / "focus on jarvis voice dev"
    const focusMatch = cleanedTranscript.match(
      /(?:focus\s+(?:on\s+(?:the\s+)?)?|switch\s+(?:to\s+(?:the\s+)?)?|work\s+(?:on\s+(?:the\s+)?)?)([\w\s-]{1,40}?)(?:\s*[,;]?\s*(?:the\s+)?([\w\s-]+?)\s+thread)?\s*$/i
    );
    if (focusMatch) {
      const target = focusMatch[1].trim();
      const threadHint = focusMatch[2]?.trim() || null; // e.g. "beta launch" or "team-member"
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
        // Channel not found — return immediately instead of falling through to the brain.
        // The brain doesn't know how to "focus" either, so it just wastes 300s timing out.
        // Strip noise words from target for a cleaner error message.
        const cleanTarget = target.replace(/^(?:the|a|an|my)\s+/i, '').replace(/\s+(?:channel|in\s+discord|please)$/i, '').trim();
        return { type: 'focus_not_found', query: cleanTarget };
      }
    }

    // "clear focus" / "unfocus" / "no focus" / "reset focus"
    // Also resets visual channel target back to #hud (VOICE_REPORT_CHANNEL_ID)
    if (/(?:clear|reset|remove|drop|no)\s*focus|unfocus/i.test(cleanedTranscript)) {
      clearFocus();
      // Reset visual channel to default (#hud) so output goes back there
      try {
        const { setVisualTargetChannel } = await import('./visual-mode.js');
        setVisualTargetChannel(null);
      } catch {}
      return { type: 'focus_clear' };
    }

    // "refocus" / "go back" / "back to last" — restore previous focus
    if (/\brefocus\b|(?:go|switch|get)\s*back(?:\s+to\s+(?:last|previous|that))?|(?:back\s+to\s+)?(?:last|previous)\s+(?:focus|channel|project)/i.test(cleanedTranscript)) {
      const restored = refocus();
      if (restored) {
        // Also update visual channel target to the restored focus
        try {
          const { setVisualTargetChannel } = await import('./visual-mode.js');
          setVisualTargetChannel(restored.channelId);
        } catch {}
        return { type: 'focus_restore', focus: restored };
      }
      return { type: 'focus_restore_empty' };
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

  // ── Voice spawn ───────────────────────────────────────────────────
  // "spawn monitor kafka", "start a thread check build errors",
  // "create a thread summarize the logs", "run audit in a thread"
  //
  // Triggers: explicit STT variants of "spawn" only. Do NOT match "spam" or
  // "span" — both are real English that users say naturally (e.g. "spam
  // emails to Bob", "span the table"). For harder mishearings the user can
  // fall back to "start a thread for X" or "run X in a thread".
  if (isAdmin) {
    // Model-explicit: "spawn with opus: check kafka", "spawn haiku analyze logs"
    const spawnModelMatch = cleanedTranscript.match(
      /^(?:spawn|spawm|spoan|spon|(?:start|create|open)\s+(?:a\s+)?(?:new\s+)?thread(?:\s+for)?)\s+(?:with\s+)?(opus|haiku|sonnet|claude)[\s:]+(.+)$/i
    );
    if (spawnModelMatch) {
      return { type: 'voice_spawn', model: spawnModelMatch[1].toLowerCase(), task: spawnModelMatch[2].trim() };
    }

    const spawnLeadMatch = cleanedTranscript.match(
      /^(?:spawn|spawm|spoan|spon|(?:start|create|open)\s+(?:a\s+)?(?:new\s+)?thread(?:\s+for)?)\s+(.+)$/i
    );
    const spawnTrailMatch = cleanedTranscript.match(
      /^run\s+(.+?)\s+in\s+a(?:\s+new)?\s+thread$/i
    );
    const spawnTask = (spawnLeadMatch || spawnTrailMatch)?.[1]?.trim();
    if (spawnTask) {
      return { type: 'voice_spawn', task: spawnTask };
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

  // ── Tier 1.5: Fuzzy keyword matching ────────────────────────────────
  // Zero-latency: strips action verbs + noise words, tries resolveChannel()
  // on the remaining noun. Catches "bring up deploy", "take me to gibson",
  // "let's work on ewitness", etc. without any LLM call.
  if (isAdmin) {
    const fuzzyResult = fuzzyMatch(cleanedTranscript);
    if (fuzzyResult.matched) {
      if (fuzzyResult.type === 'focus_set' && fuzzyResult.params) {
        return { type: 'focus_set', channelName: fuzzyResult.params.channelName, channelId: fuzzyResult.params.channelId, purpose: fuzzyResult.params.purpose };
      }
      if (fuzzyResult.type === 'focus_clear') {
        clearFocus();
        return { type: 'focus_clear' };
      }
      if (fuzzyResult.type === 'focus_query') {
        const focus = getFocus();
        return { type: 'focus_query', focus };
      }
      if (fuzzyResult.type === 'channel_list') {
        const channels = listChannels();
        return { type: 'channel_list', channels };
      }
    }
  }

  // ── Tier 2: Haiku intent classifier ───────────────────────────────
  // Fast LLM classification (~500ms-1s) catches structured commands that
  // BOTH regex AND fuzzy matching missed. Only runs for admin users.
  // Returns null on timeout/error → falls through to brain.
  if (isAdmin) {
    try {
      const haikuResult = await haikuClassify(cleanedTranscript);
      if (haikuResult && haikuResult.intent !== 'not_command' && haikuResult.confidence >= 0.7) {
        logger.info(`[dispatch] Haiku classified: ${haikuResult.intent} (conf=${haikuResult.confidence})`);

        if (haikuResult.intent === 'focus_set' && haikuResult.params?.channel) {
          const threadHint = haikuResult.params.thread || null;
          if (threadHint) {
            const result = await setFocusWithThread(haikuResult.params.channel, threadHint);
            if (result) {
              return { type: 'focus_set', channelName: result.channelName, channelId: result.channelId, purpose: result.purpose, threadName: result.threadName };
            }
          }
          const result = setFocusByName(haikuResult.params.channel);
          if (result) {
            return { type: 'focus_set', channelName: result.channelName, channelId: result.channelId, purpose: result.purpose };
          }
          // Haiku thought it was a focus command but channel not found
          const cleanTarget = haikuResult.params.channel.replace(/\s+channel$/i, '').trim();
          return { type: 'focus_not_found', query: cleanTarget };
        }

        if (haikuResult.intent === 'focus_clear') {
          clearFocus();
          return { type: 'focus_clear' };
        }

        if (haikuResult.intent === 'focus_query') {
          const focus = getFocus();
          return { type: 'focus_query', focus };
        }

        if (haikuResult.intent === 'channel_list') {
          const channels = listChannels();
          return { type: 'channel_list', channels };
        }

        if (haikuResult.intent === 'persona' && haikuResult.params?.persona) {
          const requested = haikuResult.params.persona.toLowerCase();
          const available = listPersonalities();
          if (available.includes(requested)) {
            const { switchPersona } = await import('./brain.js');
            const p = switchPersona(requested);
            return { type: 'persona_switch', persona: p.name, voice: p.voice, wakeWords: p.wakeWords };
          }
        }
      }
    } catch (err) {
      logger.warn(`[dispatch] Haiku intent error: ${err.message}`);
      // Fall through to brain on any error
    }
  }

  // ── Brain call (Tier 3 — full agent, slow) ────────────────────────
  return { type: 'brain', transcript: cleanedTranscript };
}
