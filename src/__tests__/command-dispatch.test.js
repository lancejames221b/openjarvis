import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks must be declared before imports ────────────────────────────
vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

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
  setVisualTargetChannel: vi.fn(() => true),
}));

vi.mock('../voice/tts-toggle.js', () => ({
  isTtsToggleCommand: vi.fn(() => null),
  setTtsProvider: vi.fn(() => ({ ok: true, provider: 'edge' })),
}));

vi.mock('../brain/intent-classifier.js', () => ({
  shouldDismiss: vi.fn(() => ({ dismiss: false })),
  isSideTalk: vi.fn(() => false),
}));

vi.mock('../brain/brain.js', () => ({
  switchPersona: vi.fn((name) => ({ name, voice: 'edge', wakeWords: [] })),
  listPersonalities: vi.fn(() => ['jarvis', 'snoop', 'alfred']),
  getActivePersona: vi.fn(() => ({ name: 'jarvis' })),
}));

vi.mock('../state/focus-state.js', () => ({
  setFocusByName: vi.fn(() => null),
  setFocusWithThread: vi.fn(async () => null),
  clearFocus: vi.fn(),
  getFocus: vi.fn(() => null),
  listChannels: vi.fn(() => [
    { channelId: 'chan-001', name: 'gibson', aliases: ['gib'] },
    { channelId: 'chan-002', name: 'security', aliases: [] },
  ]),
}));

vi.mock('../discord/channel-router.js', () => ({
  detectChannelCommand: vi.fn(() => ({ action: null, target: null, raw: '' })),
}));

vi.mock('../fuzzy-dispatch.js', () => ({
  fuzzyMatch: vi.fn(() => ({ matched: false })),
}));

vi.mock('../brain/haiku-intent.js', () => ({
  classifyIntent: vi.fn(async () => null),
}));

// Import after all mocks
import { dispatchCommand, isInterruptCommand } from '../command-dispatch.js';
import * as tldrMode from '../tldr-mode.js';
import * as mobileMode from '../mobile-mode.js';
import * as visualMode from '../visual-mode.js';
import * as ttsToggle from '../voice/tts-toggle.js';
import * as intentClassifier from '../brain/intent-classifier.js';
import * as brain from '../brain/brain.js';
import * as focusState from '../state/focus-state.js';
import * as channelRouter from '../discord/channel-router.js';
import * as shortcutEngine from '../shortcut-engine.js';
import * as fuzzyDispatch from '../fuzzy-dispatch.js';
import * as haikuIntent from '../brain/haiku-intent.js';

// ── Test helpers ────────────────────────────────────────────────────
const ADMIN_ID = 'user-admin';
const NON_ADMIN_ID = 'user-random';
const ALLOWED_USERS = [ADMIN_ID];
const ENROLLMENT_STATE = { active: false };

function dispatch(raw, cleaned, userId = ADMIN_ID) {
  return dispatchCommand(raw, cleaned, userId, ALLOWED_USERS, ENROLLMENT_STATE);
}

describe('command-dispatch.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to safe defaults
    tldrMode.isTldrToggleCommand.mockReturnValue(null);
    tldrMode.isTranscriptToggleCommand.mockReturnValue(null);
    mobileMode.isMobileModeToggle.mockReturnValue(null);
    visualMode.isVisualModeToggle.mockReturnValue(null);
    ttsToggle.isTtsToggleCommand.mockReturnValue(null);
    intentClassifier.shouldDismiss.mockReturnValue({ dismiss: false });
    brain.listPersonalities.mockReturnValue(['jarvis', 'snoop', 'alfred']);
    brain.getActivePersona.mockReturnValue({ name: 'jarvis' });
    channelRouter.detectChannelCommand.mockReturnValue({ action: null, target: null, raw: '' });
    focusState.setFocusByName.mockReturnValue(null);
    focusState.getFocus.mockReturnValue(null);
    focusState.listChannels.mockReturnValue([]);
    shortcutEngine.tryShortcut.mockResolvedValue({ handled: false });
    fuzzyDispatch.fuzzyMatch.mockReturnValue({ matched: false });
    haikuIntent.classifyIntent.mockResolvedValue(null);
  });

  // ── isInterruptCommand ────────────────────────────────────────────
  describe('isInterruptCommand()', () => {
    it('"stop" → true', () => {
      expect(isInterruptCommand('stop')).toBe(true);
    });

    it('"cancel" → true', () => {
      expect(isInterruptCommand('cancel')).toBe(true);
    });

    it('"shut up" → true', () => {
      expect(isInterruptCommand('shut up')).toBe(true);
    });

    it('"jarvis stop talking" → true', () => {
      expect(isInterruptCommand('jarvis stop talking')).toBe(true);
    });

    it('"jarvis, stop" → true', () => {
      expect(isInterruptCommand('jarvis, stop')).toBe(true);
    });

    it('"check my email" → false', () => {
      expect(isInterruptCommand('check my email')).toBe(false);
    });
  });

  // ── Mode toggles (admin) ──────────────────────────────────────────
  describe('mode toggles', () => {
    it('admin "tldr on" → type: mode_toggle, mode: tldr, enabled: true', async () => {
      tldrMode.isTldrToggleCommand.mockReturnValue(true);
      const result = await dispatch('tldr on', 'tldr on');
      expect(result.type).toBe('mode_toggle');
      expect(result.mode).toBe('tldr');
      expect(result.enabled).toBe(true);
    });

    it('admin "tldr off" → type: mode_toggle, mode: tldr, enabled: false', async () => {
      tldrMode.isTldrToggleCommand.mockReturnValue(false);
      const result = await dispatch('tldr off', 'tldr off');
      expect(result.type).toBe('mode_toggle');
      expect(result.mode).toBe('tldr');
      expect(result.enabled).toBe(false);
    });

    it('admin "transcript on" → type: mode_toggle, mode: transcript', async () => {
      tldrMode.isTranscriptToggleCommand.mockReturnValue(true);
      const result = await dispatch('full transcript mode on', 'full transcript mode on');
      expect(result.type).toBe('mode_toggle');
      expect(result.mode).toBe('transcript');
    });

    it('admin "mobile mode on" → type: mode_toggle, mode: mobile', async () => {
      mobileMode.isMobileModeToggle.mockReturnValue(true);
      const result = await dispatch('mobile mode on', 'mobile mode on');
      expect(result.type).toBe('mode_toggle');
      expect(result.mode).toBe('mobile');
      expect(result.enabled).toBe(true);
    });

    it('admin "visual mode on" → type: mode_toggle, mode: visual', async () => {
      visualMode.isVisualModeToggle.mockReturnValue(true);
      const result = await dispatch('visual mode on', 'visual mode on');
      expect(result.type).toBe('mode_toggle');
      expect(result.mode).toBe('visual');
      expect(result.enabled).toBe(true);
    });
  });

  // ── Non-admin blocked from toggles ───────────────────────────────
  describe('non-admin cannot use mode toggles', () => {
    it('non-admin "tldr on" falls through (not mode_toggle)', async () => {
      tldrMode.isTldrToggleCommand.mockReturnValue(true);
      // When non-admin, the isAdmin check prevents the toggle
      const result = await dispatchCommand('tldr on', 'tldr on', NON_ADMIN_ID, ALLOWED_USERS, ENROLLMENT_STATE);
      // isTldrToggleCommand is called with rawTranscript only when isAdmin — for non-admin it returns mode_toggle=false
      // Actually the check is: `isAdmin ? isTldrToggleCommand(...) : null`
      // So non-admin gets null and falls through to brain
      expect(result.type).not.toBe('mode_toggle');
    });
  });

  // ── Interrupt detection ───────────────────────────────────────────
  describe('interrupt detection', () => {
    it('"stop" → type: interrupt', async () => {
      const result = await dispatch('stop', 'stop');
      expect(result.type).toBe('interrupt');
    });

    it('"cancel" → type: interrupt', async () => {
      const result = await dispatch('cancel', 'cancel');
      expect(result.type).toBe('interrupt');
    });

    it('"shut up" → type: interrupt', async () => {
      const result = await dispatch('shut up', 'shut up');
      expect(result.type).toBe('interrupt');
    });

    it('"jarvis stop talking" → type: interrupt', async () => {
      const result = await dispatch('jarvis stop talking', 'stop talking');
      expect(result.type).toBe('interrupt');
    });
  });

  // ── Bare wake word ────────────────────────────────────────────────
  describe('bare wake word', () => {
    it('empty cleaned transcript → type: bare_wake', async () => {
      const result = await dispatch('jarvis', '');
      expect(result.type).toBe('bare_wake');
    });

    it('whitespace only cleaned transcript → type: bare_wake', async () => {
      const result = await dispatch('jarvis!', '   ');
      expect(result.type).toBe('bare_wake');
    });

    it('punctuation-only cleaned transcript → type: bare_wake', async () => {
      const result = await dispatch('jarvis.', '.');
      expect(result.type).toBe('bare_wake');
    });
  });

  // ── Stop word filtering ───────────────────────────────────────────
  describe('stop word filtering', () => {
    it('"sounds good" → type: stop_word', async () => {
      const result = await dispatch('sounds good', 'sounds good');
      expect(result.type).toBe('stop_word');
    });

    it('"thank you" → type: stop_word', async () => {
      const result = await dispatch('thank you', 'thank you');
      expect(result.type).toBe('stop_word');
    });

    it('"ok" → type: stop_word', async () => {
      const result = await dispatch('ok', 'ok');
      expect(result.type).toBe('stop_word');
    });

    it('"obviously" → type: stop_word', async () => {
      const result = await dispatch('obviously', 'obviously');
      expect(result.type).toBe('stop_word');
    });
  });

  // ── shouldDismiss ────────────────────────────────────────────────
  describe('shouldDismiss', () => {
    it('dismissed phrase → type: stop_word with reason', async () => {
      intentClassifier.shouldDismiss.mockReturnValue({ dismiss: true, reason: 'stop-prefix' });
      const result = await dispatch('sounds good, let me handle it', 'sounds good, let me handle it');
      expect(result.type).toBe('stop_word');
      expect(result.reason).toBe('stop-prefix');
    });
  });

  // ── Focus commands ────────────────────────────────────────────────
  describe('focus commands', () => {
    it('"focus on gibson" → type: focus_set', async () => {
      focusState.setFocusByName.mockReturnValue({
        channelId: 'chan-001',
        channelName: 'gibson',
        purpose: 'Gibson AI project',
        directive: null,
        references: {},
        setAt: new Date().toISOString(),
      });
      const result = await dispatch('focus on gibson', 'focus on gibson');
      expect(result.type).toBe('focus_set');
      expect(result.channelName).toBe('gibson');
    });

    it('"focus on unknown channel" → type: focus_not_found', async () => {
      focusState.setFocusByName.mockReturnValue(null);
      const result = await dispatch('focus on unknown channel', 'focus on unknown channel');
      expect(result.type).toBe('focus_not_found');
    });

    it('"clear focus" → type: focus_clear', async () => {
      const result = await dispatch('clear focus', 'clear focus');
      expect(result.type).toBe('focus_clear');
      expect(focusState.clearFocus).toHaveBeenCalled();
    });

    it('"unfocus" → type: focus_clear', async () => {
      const result = await dispatch('unfocus', 'unfocus');
      expect(result.type).toBe('focus_clear');
    });

    it('"where am i" → type: focus_query', async () => {
      focusState.getFocus.mockReturnValue({ channelId: 'chan-001', channelName: 'gibson' });
      const result = await dispatch('where am i', 'where am i');
      expect(result.type).toBe('focus_query');
    });

    it('"list channels" → type: channel_list', async () => {
      focusState.listChannels.mockReturnValue([
        { channelId: 'chan-001', name: 'gibson', aliases: [] },
      ]);
      const result = await dispatch('list channels', 'list channels');
      expect(result.type).toBe('channel_list');
      expect(Array.isArray(result.channels)).toBe(true);
    });
  });

  // ── Channel move ────────────────────────────────────────────────
  describe('channel move', () => {
    it('"go to lobby" → type: voice_move', async () => {
      channelRouter.detectChannelCommand.mockReturnValue({
        action: 'move',
        target: 'lobby',
        raw: 'go to lobby',
      });
      const result = await dispatch('go to lobby', 'go to lobby');
      expect(result.type).toBe('voice_move');
      expect(result.target).toBe('lobby');
    });
  });

  // ── Persona switch ──────────────────────────────────────────────
  describe('persona switch', () => {
    it('"switch to snoop" → type: persona_switch', async () => {
      brain.listPersonalities.mockReturnValue(['jarvis', 'snoop', 'alfred']);
      brain.switchPersona.mockReturnValue({ name: 'snoop', voice: 'edge', wakeWords: ['snoop', 'hey snoop'] });
      const result = await dispatch('switch to snoop', 'switch to snoop');
      expect(result.type).toBe('persona_switch');
      expect(result.persona).toBe('snoop');
    });

    it('"switch to unknown" → falls through (not persona_switch)', async () => {
      brain.listPersonalities.mockReturnValue(['jarvis', 'snoop']);
      const result = await dispatch('switch to unknown', 'switch to unknown');
      expect(result.type).not.toBe('persona_switch');
    });

    it('"list personas" → type: persona_list', async () => {
      brain.listPersonalities.mockReturnValue(['jarvis', 'snoop', 'alfred']);
      brain.getActivePersona.mockReturnValue({ name: 'jarvis' });
      const result = await dispatch('list personas', 'list personas');
      expect(result.type).toBe('persona_list');
      expect(result.available).toContain('snoop');
    });
  });

  // ── Enrollment ───────────────────────────────────────────────────
  describe('enrollment', () => {
    it('"enroll my voice" → type: enrollment, action: start', async () => {
      const result = await dispatch('enroll my voice', 'enroll my voice');
      expect(result.type).toBe('enrollment');
      expect(result.action).toBe('start');
    });

    it('"learn mode" → type: enrollment, action: learn', async () => {
      const result = await dispatch('learn mode', 'learn mode');
      expect(result.type).toBe('enrollment');
      expect(result.action).toBe('learn');
    });

    it('"cancel enroll" when active → type: enrollment, action: cancel', async () => {
      const enrollState = { active: true };
      const result = await dispatchCommand('cancel enroll', 'cancel enroll', ADMIN_ID, ALLOWED_USERS, enrollState);
      expect(result.type).toBe('enrollment');
      expect(result.action).toBe('cancel');
    });
  });

  // ── Shortcut fast-path ────────────────────────────────────────────
  describe('shortcut fast-path', () => {
    it('handled shortcut → type: shortcut', async () => {
      shortcutEngine.tryShortcut.mockResolvedValue({
        handled: true,
        speech: 'Your next meeting is at 2pm.',
        silent: false,
      });
      const result = await dispatch('what is my next meeting', 'what is my next meeting');
      expect(result.type).toBe('shortcut');
      expect(result.speech).toBe('Your next meeting is at 2pm.');
    });
  });

  // ── Brain fallback ────────────────────────────────────────────────
  describe('brain fallback', () => {
    it('normal query → type: brain', async () => {
      const result = await dispatch('what is the weather like today', 'what is the weather like today');
      expect(result.type).toBe('brain');
    });

    it('brain result includes transcript', async () => {
      const result = await dispatch('who won the game last night', 'who won the game last night');
      expect(result.type).toBe('brain');
      expect(result.transcript).toBeTruthy();
    });
  });

  // ── Voice spawn (admin, STT-tolerant, no false positives on real English) ─
  describe('voice_spawn trigger', () => {
    it('"spawn audit kafka" → voice_spawn with task', async () => {
      const result = await dispatch('spawn audit kafka', 'spawn audit kafka');
      expect(result.type).toBe('voice_spawn');
      expect(result.task).toBe('audit kafka');
    });

    it('"spawm monitor the queue" (STT variant) → voice_spawn', async () => {
      const result = await dispatch('spawm monitor the queue', 'spawm monitor the queue');
      expect(result.type).toBe('voice_spawn');
      expect(result.task).toBe('monitor the queue');
    });

    it('"spon check build errors" (STT variant) → voice_spawn', async () => {
      const result = await dispatch('spon check build errors', 'spon check build errors');
      expect(result.type).toBe('voice_spawn');
      expect(result.task).toBe('check build errors');
    });

    it('"start a thread for audit kafka" → voice_spawn', async () => {
      const result = await dispatch('start a thread for audit kafka', 'start a thread for audit kafka');
      expect(result.type).toBe('voice_spawn');
      expect(result.task).toBe('audit kafka');
    });

    it('"create a new thread summarize the logs" → voice_spawn', async () => {
      const result = await dispatch('create a new thread summarize the logs', 'create a new thread summarize the logs');
      expect(result.type).toBe('voice_spawn');
      expect(result.task).toBe('summarize the logs');
    });

    it('"run audit in a thread" (trailing syntax) → voice_spawn', async () => {
      const result = await dispatch('run audit in a thread', 'run audit in a thread');
      expect(result.type).toBe('voice_spawn');
      expect(result.task).toBe('audit');
    });

    it('"spam emails to bob" (real English) → NOT voice_spawn', async () => {
      const result = await dispatch('spam emails to bob', 'spam emails to bob');
      expect(result.type).not.toBe('voice_spawn');
    });

    it('"span the table" (real English) → NOT voice_spawn', async () => {
      const result = await dispatch('span the table', 'span the table');
      expect(result.type).not.toBe('voice_spawn');
    });

    it('"spanm the entries" (garbage) → NOT voice_spawn', async () => {
      const result = await dispatch('spanm the entries', 'spanm the entries');
      expect(result.type).not.toBe('voice_spawn');
    });

    it('non-admin "spawn audit kafka" → falls through (no voice_spawn)', async () => {
      const result = await dispatchCommand('spawn audit kafka', 'spawn audit kafka', NON_ADMIN_ID, ALLOWED_USERS, ENROLLMENT_STATE);
      expect(result.type).not.toBe('voice_spawn');
    });
  });
});
