/**
 * feature-voice-pipeline.test.js
 *
 * Extended integration tests for the full voice I/O pipeline.
 * Covers edge cases not exercised by e2e-pipeline.test.js.
 *
 * Mocked:  stt.js, brain/brain.js, voice/tts.js, logger.js, command-dispatch deps
 * Real:    voice/wakeword.js checkWakeWord(), command-dispatch.js dispatchCommand()
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../voice/stt.js', () => ({
  transcribeAudio: vi.fn(async () => ({
    text: 'Jarvis what time is it',
    confidence: 0.95,
    no_speech_prob: 0.01,
  })),
  transcribeWhisperOnly: vi.fn(async () => ({
    text: 'Jarvis what time is it',
    confidence: 0.9,
    no_speech_prob: 0.02,
  })),
  getSTTHealth: vi.fn(() => 'deepgram'),
}));

vi.mock('../brain/brain.js', () => ({
  generateResponseStreaming: vi.fn(async (msg, history, signal, onSentence) => {
    onSentence('It is 2:30 PM.', false);
    return 'It is 2:30 PM.';
  }),
  generateResponse: vi.fn(async () => 'It is 2:30 PM.'),
  switchPersona: vi.fn((name) => ({ name, voice: 'edge', wakeWords: [] })),
  listPersonalities: vi.fn(() => ['jarvis', 'snoop']),
  getActivePersona: vi.fn(() => ({ name: 'jarvis' })),
}));

vi.mock('../voice/tts.js', () => ({
  synthesizeSpeech: vi.fn(async () => Buffer.from('fake-audio')),
  isTTSAvailable: vi.fn(() => true),
}));

vi.mock('../shortcut-engine.js', () => ({
  tryShortcut: vi.fn(async () => ({ handled: false })),
}));

vi.mock('../tldr-mode.js', () => ({
  isTldrToggleCommand: vi.fn(() => null),
  setTldrMode: vi.fn(() => true),
  isTranscriptToggleCommand: vi.fn(() => null),
  setTranscriptMode: vi.fn(() => true),
}));

vi.mock('../mobile-mode.js', () => ({
  isMobileModeToggle: vi.fn(() => null),
  setMobileMode: vi.fn(() => true),
}));

vi.mock('../visual-mode.js', () => ({
  isVisualModeToggle: vi.fn(() => null),
  setVisualMode: vi.fn(() => true),
  setVisualTargetChannel: vi.fn(),
  isVisualModeEnabled: vi.fn(() => false),
  getVisualTargetChannel: vi.fn(() => null),
}));

vi.mock('../voice/tts-toggle.js', () => ({
  isTtsToggleCommand: vi.fn(() => null),
  setTtsProvider: vi.fn(() => ({ ok: true, provider: 'edge' })),
}));

vi.mock('../brain/intent-classifier.js', () => ({
  shouldDismiss: vi.fn(() => ({ dismiss: false })),
  isSideTalk: vi.fn(() => false),
}));

vi.mock('../focus-state.js', () => ({
  setFocusByName: vi.fn(() => null),
  setFocusWithThread: vi.fn(async () => null),
  clearFocus: vi.fn(),
  getFocus: vi.fn(() => null),
  listChannels: vi.fn(() => []),
  refocus: vi.fn(() => null),
  getPreviousFocus: vi.fn(() => null),
  setFocusById: vi.fn(() => null),
}));

vi.mock('../channel-router.js', () => ({
  detectChannelCommand: vi.fn(() => ({ action: null, target: null, raw: '' })),
}));

vi.mock('../fuzzy-dispatch.js', () => ({
  fuzzyMatch: vi.fn(() => ({ matched: false })),
}));

vi.mock('../brain/haiku-intent.js', () => ({
  classifyIntent: vi.fn(async () => null),
}));

// ── Real imports ───────────────────────────────────────────────────────────────

import { checkWakeWord } from '../voice/wakeword.js';
import { dispatchCommand } from '../command-dispatch.js';
import { transcribeAudio, transcribeWhisperOnly, getSTTHealth } from '../voice/stt.js';
import { generateResponseStreaming } from '../brain/brain.js';
import { synthesizeSpeech } from '../voice/tts.js';
import logger from '../logger.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const ADMIN_ID = 'user-admin-001';
const ALLOWED_USERS = [ADMIN_ID];
const ENROLLMENT_STATE = { active: false };

// Mirrors the NO_SPEECH_PROB_THRESHOLD in stt.js / index.js
const NO_SPEECH_PROB_THRESHOLD = 0.6;

// ── Pipeline helper ────────────────────────────────────────────────────────────

/**
 * Simulates the full voice pipeline for one utterance.
 * STT is mocked; wake word detection and command dispatch are real.
 *
 * @param {string} rawTranscript - The transcript text (as if produced by STT)
 * @param {object} [opts]
 * @param {boolean} [opts.wakeWordEnabled=false] - When true, require an actual wake word phrase
 * @param {string}  [opts.userId=ADMIN_ID]
 */
async function runPipeline(rawTranscript, { wakeWordEnabled = false, userId = ADMIN_ID } = {}) {
  // Step 1: STT (mocked)
  const sttResult = await transcribeAudio('/fake/audio.wav');

  // Step 1.5: Confidence gate — mirrors index.js behaviour
  if (sttResult.no_speech_prob > NO_SPEECH_PROB_THRESHOLD) {
    return { dispatched: false, reason: 'low_confidence', sttResult };
  }

  // Step 2: Wake word check (REAL)
  const wakeResult = checkWakeWord(rawTranscript, userId, false);

  if (wakeWordEnabled && !wakeResult.wakeWordUsed) {
    return { dispatched: false, reason: 'no_wake_word', wakeResult };
  }

  // Step 3: Dispatch (REAL)
  const dispatchResult = await dispatchCommand(
    rawTranscript,
    wakeResult.cleanedTranscript,
    userId,
    ALLOWED_USERS,
    ENROLLMENT_STATE,
  );

  // Steps 4 + 5: Brain → TTS per sentence
  const ttsSentences = [];
  if (dispatchResult.type === 'brain') {
    const signal = new AbortController().signal;
    await generateResponseStreaming(
      dispatchResult.transcript,
      [],
      signal,
      (sentence) => ttsSentences.push(sentence),
    );
    for (const sentence of ttsSentences) {
      try {
        await synthesizeSpeech(sentence);
      } catch (err) {
        logger.error(`TTS synthesis failed: ${err.message}`);
      }
    }
  }

  return { dispatched: true, wakeResult, dispatchResult, ttsSentences };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 1. Wake word present → brain → TTS ───────────────────────────────────────

describe('1: wake word detected', () => {
  it('routes transcript to brain and TTS is called with the brain response', async () => {
    generateResponseStreaming.mockImplementation(async (msg, history, signal, onSentence) => {
      onSentence('The time is 3:00 PM.', false);
      return 'The time is 3:00 PM.';
    });

    const result = await runPipeline('Jarvis what time is it');

    // VOICE_WAKE_WORD_ENABLED=false in vitest env → free-listen, detected always true
    expect(result.wakeResult.detected).toBe(true);
    expect(result.dispatchResult.type).toBe('brain');
    expect(generateResponseStreaming).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.any(Object),
      expect.any(Function),
    );
    expect(synthesizeSpeech).toHaveBeenCalledWith('The time is 3:00 PM.');
  });

  it('free-listen mode: detected=true and wakeWordUsed=false when no explicit wake word phrase', () => {
    // With VOICE_WAKE_WORD_ENABLED=false, checkWakeWord bypasses wake word matching entirely.
    // detected is always true; wakeWordUsed is false because the feature is off.
    const result = checkWakeWord('hello there', ADMIN_ID, false);
    expect(result.detected).toBe(true);
    expect(result.wakeWordUsed).toBe(false);
  });
});

// ── 2. Wake word absent (ENABLED=true simulated) ─────────────────────────────

describe('2: wake word absent with VOICE_WAKE_WORD_ENABLED=true simulated', () => {
  it('"hello there" without wake word → short-circuits, no brain, no TTS', async () => {
    const result = await runPipeline('hello there', { wakeWordEnabled: true });

    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe('no_wake_word');
    expect(generateResponseStreaming).not.toHaveBeenCalled();
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it('"Jarvis hello there" in free-listen mode (no gate) → dispatched normally', async () => {
    // Without the wake-word gate, every transcript is dispatched regardless of prefix.
    const result = await runPipeline('Jarvis hello there');

    expect(result.dispatched).toBe(true);
    expect(result.wakeResult.detected).toBe(true);
    expect(result.dispatchResult.type).toBe('brain');
  });
});

// ── 3. Stop words and interrupts ──────────────────────────────────────────────

describe('3: stop words and interrupts', () => {
  it('"thank you" → stop_word type → no brain, no TTS', async () => {
    const result = await runPipeline('thank you');

    expect(result.dispatchResult.type).toBe('stop_word');
    expect(generateResponseStreaming).not.toHaveBeenCalled();
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it('"stop" → interrupt type → no brain, no TTS', async () => {
    const result = await runPipeline('stop');

    expect(result.dispatchResult.type).toBe('interrupt');
    expect(generateResponseStreaming).not.toHaveBeenCalled();
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });
});

// ── 4. Low-confidence transcript ──────────────────────────────────────────────

describe('4: low-confidence rejection', () => {
  it('no_speech_prob > 0.85 → rejected before dispatch', async () => {
    transcribeAudio.mockResolvedValueOnce({
      text: 'you you you you',
      confidence: 0.3,
      no_speech_prob: 0.9,
    });

    const result = await runPipeline('you you you you');

    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe('low_confidence');
    expect(generateResponseStreaming).not.toHaveBeenCalled();
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it('no_speech_prob exactly at threshold (0.6) is not rejected', async () => {
    transcribeAudio.mockResolvedValueOnce({
      text: 'Jarvis what time is it',
      confidence: 0.7,
      no_speech_prob: 0.6, // equal to threshold, not strictly greater
    });

    const result = await runPipeline('Jarvis what time is it');

    expect(result.dispatched).toBe(true);
  });
});

// ── 5. Brain streaming → TTS per sentence ─────────────────────────────────────

describe('5: brain streaming', () => {
  it('onSentence fires for each chunk → synthesizeSpeech called once per chunk', async () => {
    generateResponseStreaming.mockImplementation(async (msg, history, signal, onSentence) => {
      onSentence('First sentence.', false);
      onSentence('Second sentence.', false);
      onSentence('Third sentence.', false);
      return 'First sentence. Second sentence. Third sentence.';
    });

    const result = await runPipeline('Jarvis tell me a story');

    expect(result.ttsSentences).toHaveLength(3);
    expect(synthesizeSpeech).toHaveBeenCalledTimes(3);
    expect(synthesizeSpeech).toHaveBeenNthCalledWith(1, 'First sentence.');
    expect(synthesizeSpeech).toHaveBeenNthCalledWith(2, 'Second sentence.');
    expect(synthesizeSpeech).toHaveBeenNthCalledWith(3, 'Third sentence.');
  });
});

// ── 6. TTS failure handling ────────────────────────────────────────────────────

describe('6: TTS failure handling', () => {
  it('TTS throws → error logged, pipeline does not crash, dispatch result is still returned', async () => {
    synthesizeSpeech.mockRejectedValueOnce(new Error('TTS provider unavailable'));
    generateResponseStreaming.mockImplementation(async (msg, history, signal, onSentence) => {
      onSentence('This will fail to synthesize.', false);
      return 'This will fail to synthesize.';
    });

    const result = await runPipeline('Jarvis say something');

    expect(result.dispatched).toBe(true);
    expect(result.dispatchResult.type).toBe('brain');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('TTS synthesis failed'),
    );
  });
});

// ── 7. STT circuit breaker ─────────────────────────────────────────────────────

describe('7: STT circuit breaker open → Whisper-only fallback', () => {
  it('circuit breaker open → transcribeWhisperOnly used, transcript flows through pipeline', async () => {
    getSTTHealth.mockReturnValue('whisper (circuit breaker, 240s remaining)');
    transcribeWhisperOnly.mockResolvedValue({
      text: 'Jarvis what is the weather',
      confidence: 0.88,
      no_speech_prob: 0.03,
    });

    // Routing decision mirrors index.js behaviour when getSTTHealth detects circuit breaker
    const health = getSTTHealth();
    const isCircuitBreakerOpen = health.startsWith('whisper (circuit breaker');

    const sttResult = isCircuitBreakerOpen
      ? await transcribeWhisperOnly('/fake/audio.wav')
      : await transcribeAudio('/fake/audio.wav');

    expect(isCircuitBreakerOpen).toBe(true);
    expect(transcribeWhisperOnly).toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(sttResult.no_speech_prob).toBeLessThan(NO_SPEECH_PROB_THRESHOLD);

    // Transcript still reaches brain via the real pipeline
    const wakeResult = checkWakeWord(sttResult.text, ADMIN_ID, false);
    expect(wakeResult.detected).toBe(true);

    const dispatchResult = await dispatchCommand(
      sttResult.text,
      wakeResult.cleanedTranscript,
      ADMIN_ID,
      ALLOWED_USERS,
      ENROLLMENT_STATE,
    );
    expect(dispatchResult.type).toBe('brain');
  });

  it('normal health → transcribeAudio used, not Whisper fallback', async () => {
    getSTTHealth.mockReturnValue('deepgram');

    const health = getSTTHealth();
    const isCircuitBreakerOpen = health.startsWith('whisper (circuit breaker');

    expect(isCircuitBreakerOpen).toBe(false);

    await transcribeAudio('/fake/audio.wav');
    expect(transcribeAudio).toHaveBeenCalled();
    expect(transcribeWhisperOnly).not.toHaveBeenCalled();
  });
});

// ── 8. Fake STT endpoint (DEV_MODE) injection ─────────────────────────────────

describe('8: DEV_MODE fake STT injection', () => {
  it('injected transcript routes through checkWakeWord → dispatchCommand → brain → TTS', async () => {
    generateResponseStreaming.mockImplementation(async (msg, history, signal, onSentence) => {
      onSentence('Playing your playlist.', false);
      return 'Playing your playlist.';
    });

    // Mirrors the pipeline handler that index.js registers via setHandleFakeSttCallback
    // when DEV_MODE=true. The /test/stt endpoint calls this function with the POSTed text.
    const fakeSttPipelineHandler = async (text, userId = ADMIN_ID) => {
      const wakeResult = checkWakeWord(text, userId, false);
      const dispatchResult = await dispatchCommand(
        text,
        wakeResult.cleanedTranscript,
        userId,
        ALLOWED_USERS,
        ENROLLMENT_STATE,
      );
      if (dispatchResult.type === 'brain') {
        const signal = new AbortController().signal;
        await generateResponseStreaming(dispatchResult.transcript, [], signal, async (s) => {
          await synthesizeSpeech(s);
        });
      }
      return { wakeResult, dispatchResult };
    };

    const result = await fakeSttPipelineHandler('Jarvis play my playlist', ADMIN_ID);

    expect(result.wakeResult.detected).toBe(true);
    expect(result.dispatchResult.type).toBe('brain');
    expect(generateResponseStreaming).toHaveBeenCalled();
    expect(synthesizeSpeech).toHaveBeenCalledWith('Playing your playlist.');
  });

  it('injected stop word → stop_word dispatch (same as real STT path)', async () => {
    const fakeSttPipelineHandler = async (text, userId = ADMIN_ID) => {
      const wakeResult = checkWakeWord(text, userId, false);
      return dispatchCommand(text, wakeResult.cleanedTranscript, userId, ALLOWED_USERS, ENROLLMENT_STATE);
    };

    const dispatchResult = await fakeSttPipelineHandler('thank you');

    expect(dispatchResult.type).toBe('stop_word');
    expect(generateResponseStreaming).not.toHaveBeenCalled();
  });
});

// ── 9. Voice spawn → slash command routing ────────────────────────────────────

describe('9: voice spawn routing', () => {
  it('"spawn monitor kafka" → voice_spawn with task extracted', async () => {
    const wakeResult = checkWakeWord('spawn monitor kafka', ADMIN_ID, false);
    const dispatchResult = await dispatchCommand(
      'spawn monitor kafka',
      wakeResult.cleanedTranscript,
      ADMIN_ID,
      ALLOWED_USERS,
      ENROLLMENT_STATE,
    );

    expect(dispatchResult.type).toBe('voice_spawn');
    expect(dispatchResult.task).toBe('monitor kafka');
  });

  it('"start a thread check build errors" → voice_spawn via thread-trigger variant', async () => {
    const wakeResult = checkWakeWord('start a thread check build errors', ADMIN_ID, false);
    const dispatchResult = await dispatchCommand(
      'start a thread check build errors',
      wakeResult.cleanedTranscript,
      ADMIN_ID,
      ALLOWED_USERS,
      ENROLLMENT_STATE,
    );

    expect(dispatchResult.type).toBe('voice_spawn');
    expect(dispatchResult.task).toBe('check build errors');
  });

  it('"spawn with opus: analyze logs" → voice_spawn with model override', async () => {
    const wakeResult = checkWakeWord('spawn with opus: analyze logs', ADMIN_ID, false);
    const dispatchResult = await dispatchCommand(
      'spawn with opus: analyze logs',
      wakeResult.cleanedTranscript,
      ADMIN_ID,
      ALLOWED_USERS,
      ENROLLMENT_STATE,
    );

    expect(dispatchResult.type).toBe('voice_spawn');
    expect(dispatchResult.model).toBe('opus');
    expect(dispatchResult.task).toBe('analyze logs');
  });
});
