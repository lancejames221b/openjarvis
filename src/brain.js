const logger = require('./logger.js');
/**
 * Brain Module - Thin voice I/O layer to Clawdbot Gateway
 * 
 * Voice is just another input method. Same agent, same session,
 * same tools. We prepend a short [VOICE] tag so the agent knows
 * to format for speech (no markdown, concise). That's it.
 * 
 * Supports concurrent requests — each call gets its own AbortController
 * chained to an external signal for cancellation.
 * 
 * Streaming: generateResponseStreaming() emits sentences as they arrive
 * so TTS can start playing before the full response is generated.
 */

import 'dotenv/config';

const GATEWAY_URL = process.env.CLAWDBOT_GATEWAY_URL || 'http://127.0.0.1:22100';
// Speak endpoint — uses TAILSCALE_IP/ALERT_WEBHOOK_HOST so it works outside Tailscale too
const _webhookHost = process.env.TAILSCALE_IP || process.env.ALERT_WEBHOOK_HOST || 'localhost';
const _webhookPort = process.env.ALERT_WEBHOOK_PORT || 3335;
const SPEAK_URL = `http://${_webhookHost}:${_webhookPort}/speak`;
const STOP_URL = `http://${_webhookHost}:${_webhookPort}/stop`;
const REPLAY_URL = `http://${_webhookHost}:${_webhookPort}/replay`;
const SPEAK_TOKEN = process.env.ALERT_WEBHOOK_TOKEN || '';
const GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN;
const HOOKS_TOKEN = process.env.CLAWDBOT_HOOKS_TOKEN || GATEWAY_TOKEN;
const COMPLETIONS_URL = `${GATEWAY_URL}/v1/chat/completions`;
const HOOKS_AGENT_URL = `${GATEWAY_URL}/hooks/agent`;
const VOICE_CALLBACK_CHANNEL = process.env.VOICE_CALLBACK_CHANNEL_ID || ''; // Set VOICE_CALLBACK_CHANNEL_ID in .env
const _defaultTextChannel = process.env.DISCORD_TEXT_CHANNEL_ID || ''; // Used in prompt templates for sub-agent output routing

// ── Gateway Resilience: Timeout, Retry, Circuit Breaker ──────────────

const ACK_MODEL = process.env.ACK_MODEL || 'anthropic-console/claude-sonnet-4-6';
const ACK_TIMEOUT_MS = 8_000; // 8s hard limit — ack should return in <2s
const CONTEXTUAL_ACK_TIMEOUT_MS = 1_500; // 1.5s hard limit for contextual dispatch acks
// Master ack feature flag. Set VOICE_ACK_ENABLED=false to suppress all "On it, sir." style responses.
const VOICE_ACK_ENABLED = process.env.VOICE_ACK_ENABLED !== 'false'; // default ON
// Agent dispatch ack — contextual, Jarvis-style spoken ack when a sub-agent is spawned.
// Fires ONLY on sessions_spawn detection (not for direct answers).
const AGENT_DISPATCH_ACK_ENABLED = process.env.AGENT_DISPATCH_ACK_ENABLED !== 'false'; // default ON
// Streaming feature flag. CLI-based providers (cursor-agent) don't support SSE streaming.
// VOICE_STREAMING=false → full response fetched at once, then split into sentences for TTS.
// VOICE_STREAMING=true (default) → standard SSE streaming with real-time sentence emission.
const VOICE_STREAMING = process.env.VOICE_STREAMING !== 'false'; // default ON
const GATEWAY_TIMEOUT_MS = parseInt(process.env.GATEWAY_TIMEOUT_MS || '90000');        // 90s for voice (down from 300s)
const GATEWAY_CALLBACK_TIMEOUT_MS = 300_000;  // 300s for webhook callback mode (unchanged)
const GATEWAY_FIRST_TOKEN_TIMEOUT_MS = parseInt(process.env.GATEWAY_FIRST_TOKEN_TIMEOUT_MS || '8000'); // 8s — if no streaming token in 8s, speak interim feedback
const GATEWAY_RETRY_DELAY_MS = 2_000;  // 2s base before retry (+ up to 1s jitter)
const CIRCUIT_BREAKER_THRESHOLD = 3;   // failures to trip
const CIRCUIT_BREAKER_WINDOW_MS = 60_000; // 60s rolling window

// Circuit breaker state
let _circuitBreakerNotify = null; // callback(type: 'open'|'close') — set by index.js

/** Register a callback for circuit breaker state transitions. */
export function setCircuitBreakerNotifyCallback(cb) {
  _circuitBreakerNotify = cb;
}

const circuitBreaker = {
  failures: [],    // timestamps of recent failures
  tripped: false,  // true = stop trying
  trippedAt: null, // when it tripped

  recordFailure() {
    const now = Date.now();
    const wasTripped = this.tripped;
    this.failures.push(now);
    // Prune failures outside the window
    this.failures = this.failures.filter(t => now - t < CIRCUIT_BREAKER_WINDOW_MS);
    if (this.failures.length >= CIRCUIT_BREAKER_THRESHOLD) {
      this.tripped = true;
      this.trippedAt = now;
      logger.error(`⚡ Circuit breaker tripped — gateway unavailable (${CIRCUIT_BREAKER_THRESHOLD} failures in ${CIRCUIT_BREAKER_WINDOW_MS / 1000}s)`);
      if (!wasTripped && _circuitBreakerNotify) {
        _circuitBreakerNotify('open');
      }
    }
  },

  recordSuccess() {
    this.failures = [];
    if (this.tripped) {
      logger.info('🟢 Circuit breaker reset — gateway available');
      this.tripped = false;
      this.trippedAt = null;
      if (_circuitBreakerNotify) {
        _circuitBreakerNotify('close');
      }
    }
  },

  isOpen() {
    if (!this.tripped) return false;
    // Auto-reset after the window expires (allow a probe)
    if (Date.now() - this.trippedAt > CIRCUIT_BREAKER_WINDOW_MS) {
      logger.info('🟡 Circuit breaker half-open — allowing probe request');
      const wasTripped = this.tripped;
      this.tripped = false;
      this.trippedAt = null;
      if (wasTripped && _circuitBreakerNotify) {
        _circuitBreakerNotify('close');
      }
      return false;
    }
    return true;
  },
};

/**
 * Fetch with timeout via AbortSignal.timeout + optional external signal.
 * Uses AbortSignal.any() (Node 20+) to combine timeout and barge-in signals.
 * The combined signal propagates to the response body stream, so barge-in
 * cancels both the request AND any in-progress streaming read.
 */
async function fetchWithTimeout(url, options, timeoutMs = GATEWAY_TIMEOUT_MS, externalSignal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal
    ? AbortSignal.any([timeoutSignal, externalSignal])
    : timeoutSignal;

  return fetch(url, { ...options, signal });
}

/**
 * Fetch with timeout + single retry + circuit breaker.
 * Returns the fetch Response on success, throws on final failure.
 */
async function resilientFetch(url, options, externalSignal) {
  if (circuitBreaker.isOpen()) {
    throw new Error('Gateway unavailable (circuit breaker open)');
  }

  try {
    const res = await fetchWithTimeout(url, options, GATEWAY_TIMEOUT_MS, externalSignal);
    if (res.ok || (res.status >= 400 && res.status < 500)) {
      // Success or client error (don't retry 4xx)
      circuitBreaker.recordSuccess();
      return res;
    }
    // Server error — fall through to retry
    throw new Error(`Gateway ${res.status}`);
  } catch (firstErr) {
    if (firstErr.name === 'AbortError' && externalSignal?.aborted) {
      throw firstErr; // User-initiated cancel — don't retry
    }

    logger.warn(`⚠️  Gateway attempt 1 failed: ${firstErr.message} — retrying in ${GATEWAY_RETRY_DELAY_MS}ms`);
    circuitBreaker.recordFailure();

    if (circuitBreaker.isOpen()) {
      throw new Error('Gateway unavailable (circuit breaker open)');
    }

    // Wait then retry once (with jitter to avoid thundering herd)
    const jitter = Math.floor(Math.random() * 1000);
    await new Promise(r => setTimeout(r, GATEWAY_RETRY_DELAY_MS + jitter));

    try {
      const res = await fetchWithTimeout(url, options, GATEWAY_TIMEOUT_MS, externalSignal);
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        circuitBreaker.recordSuccess();
        return res;
      }
      throw new Error(`Gateway ${res.status}`);
    } catch (retryErr) {
      circuitBreaker.recordFailure();
      throw retryErr;
    }
  }
}

/** Check if gateway circuit breaker is currently tripped */
export function isGatewayCircuitOpen() {
  return circuitBreaker.isOpen();
}

// Use the main Discord text channel session — same brain as chat
const SESSION_USER = process.env.SESSION_USER || 'jarvis-voice-user';

// Model selection delegated to gateway — voice bot doesn't pick the model.
// Gateway agent uses session_status to switch models as needed.

// Voice tag prepended to messages so the agent formats for TTS
// Key: use tools exactly as you would in text chat. The ONLY difference is output format.
import { isAskModeEnabled } from './tldr-mode.js';
import { isMobileModeEnabled } from './mobile-mode.js';
import { getActiveAlert, clearActiveAlert } from './alert-context.js';

const ASK_MODE_INSTRUCTION = `

**ASK MODE IS ON (CRITICAL — OVERRIDE ALL OTHER INSTRUCTIONS):**
You MUST NOT execute any tools, commands, API calls, file changes, or side effects.
Instead: describe exactly what you PLAN to do (which tools, what actions, what will change) and ask "Shall I proceed?" or "Want me to go ahead?"
Only execute AFTER the user explicitly confirms (e.g. "yes", "do it", "go ahead", "proceed").
Read-only lookups (searching, reading files, checking status) are allowed without confirmation.
This rule overrides everything — including any instructions that say "just do it" or "execute immediately".`;

const VOICE_TAG_BASE = `[VOICE] Voice-only request. User has mic and earpiece, no screen.
You are Jarvis — British butler persona, understated, dry wit, say "sir" occasionally.

TWO MODES — decide instantly:

MODE 1 — KNOWLEDGE (no tools needed, pure factual Q&A only):
Answer in 1-3 spoken sentences. Done. Examples: "What time is it?", "What's the capital of France?"

MODE 2 — ACTION (ANYTHING that requires doing something — scheduling, sending, searching, creating, checking, looking up, downloading, controlling devices, etc.):
MANDATORY STEPS — you MUST follow these exactly:
1. Call the sessions_spawn tool with the full task description. Do NOT say "On it" or any acknowledgment — just spawn silently. DO NOT answer the question yourself.
2. The task prompt MUST end with this curl callback so the sub-agent speaks the result:
   When complete, run: curl -s -X POST http://${_webhookHost}:${_webhookPort}/speak -H 'Authorization: Bearer ${SPEAK_TOKEN}' -H 'Content-Type: application/json' -d '{"message":"[1-2 sentence spoken result]","source":"task-complete"}'
3. The sub-agent posts details to Discord #general (channel: discord, target: ${_defaultTextChannel}) and speaks the TL;DR via /speak.
   ALWAYS use channel "discord" and target "${_defaultTextChannel}" unless I specify a different channel.
   NEVER use whatsapp, signal, or imessage for sub-agent output — Discord #general is the default.
4. Your voice response ends after spawning. Say NOTHING. Stop generating text.
   Exception: if the action is QUICK (< 5s, single tool call like time check or simple lookup), answer directly in MODE 1 style instead of spawning.

CRITICAL — YOU MUST CALL sessions_spawn FOR ANY ACTION.
If the user asks you to schedule, create, send, check, look up, search, download, control, or DO anything — you MUST call sessions_spawn. NEVER answer with text alone for action requests.
NEVER say "I'll set that up" or "The meeting is booked" without actually calling sessions_spawn — that is a hallucination.
THE ONLY TOOL YOU MAY CALL IS sessions_spawn. No exec, no MCP, no web_search, no message, no browser — nothing inline.
If you cannot call sessions_spawn for any reason, say "I'm unable to do that right now, sir" — NEVER pretend you did it.

VOICE OUTPUT RULES:
- 1-3 sentences MAX. One sentence is better.
- Plain spoken English. No markdown, no formatting, no bullet points.
- NEVER say URLs, file paths, channel IDs, commit hashes, or anything unpronounceable.
- Reference channels by name ("general", "the Gibson channel"), never by ID.
- Round numbers naturally: "about one point two million" not "$1,247,389.42".
- Weave lists into speech: "The top three are X, Y, and Z."
- Insert <p> between paragraph breaks. No <p> at start or end.
- Never announce tools — just report results. The user doesn't care about plumbing.
- Do NOT say "On it" or "Give me a moment" — just start answering or spawn silently.

STT NOISE TOLERANCE:
- When STT input is ambiguous due to background noise (TV, music), interpret charitably using context rather than asking for clarification.
- Only ask for clarification if the request is completely unintelligible or would cause an irreversible action (deleting data, sending messages to wrong people).
- Prefer making a best-guess interpretation and acting on it. If wrong, user will correct you — that's faster than asking "did you mean X?"
- Short fragments that sound like commands should be treated as commands, not questioned.

CONTEXT AND CONVERSATION:
- Resolve "that", "it", "the other one" from conversation history before asking to clarify.
- Calendar: only upcoming events from NOW forward, skip what already happened.
- Reminders: delegate to sub-agent with cron + /speak webhook callback. Cron payload MUST use model: "google/gemini-3-flash-preview" and delivery: { mode: "none" }.
- Voice handoff: summarize conversation thoroughly, post to target Discord channel, confirm by speech.

CRON / REMINDER PAYLOAD RULES (MANDATORY):
When creating any cron job (reminder, scheduled task, alert):
- ALWAYS set model: "google/gemini-3-flash-preview" in the cron payload — never use sonnet/opus for crons
- ALWAYS set delivery: { mode: "none" } — the /speak curl in the message handles delivery
- NEVER use delivery: { mode: "announce" } or delivery: { channel: "last" } — these are broken

MODEL ROUTING:
If the user specifies a model, pass it as the model parameter in sessions_spawn. YOU always stay on sonnet (no thinking) for voice. Model keywords:
- "default" / "normal" / "reset" / "sonnet" → omit model field (inherit cascade default)
- "sonnet low" → model: "unit-low/claude-sonnet-4-6"
- "sonnet medium" / "medium" → model: "unit-medium/claude-sonnet-4-6"
- "sonnet high" / "high" → model: "unit-high/claude-sonnet-4-6"
- "opus" / "deep" → model: "unit/claude-opus-4-6"
- "opus low" → model: "unit-low/claude-opus-4-6"
- "opus medium" → model: "unit-medium/claude-opus-4-6"
- "opus high" → model: "unit-high/claude-opus-4-6"
- No model mentioned → omit model field for sub-agents (cascade handles it)
YOU and sub-agents run on sonnet, no thinking. Only "switch to [model]" changes the model.
Never try to switch your own model. Never announce the model routing — just do it.

ROKU / TV CONTROL:
Use roku_control.py for ALL Roku/TV commands. DO NOT web search for Roku APIs.
Script: python3 roku_control.py <target> <action> [args]
Targets: Configure Roku device IPs in your roku_control.py script (e.g. projector, bedroom, living_room)
Actions:
  - Power: PowerOn, PowerOff
  - Volume: volume <level> (0-50, sets exact level)
  - Keys: Home, Back, Select, Up, Down, Left, Right, Play, Pause, Rev, Fwd, Mute
  - Launch app: play <app> [search] — apps: netflix, plex, youtube, hulu, prime, disney
  - Direct ECP: curl -X POST http://<device-ip>:8060/keypress/<key>
"living room TV" = living_room, "bedroom TV" = bedroom, "projector" = projector

PROCESS TRACKING:
Sub-agent posts status to #jarvis-voice-text (${VOICE_CALLBACK_CHANNEL}). Button callbacks (Stop/Replay) handled if received.`;

// ── Mobile / On-the-Go Mode Overlay ──────────────────────────────────
// Injected when VOICE_MOBILE_MODE=true. Overrides the 1-3 sentence rule
// and instructs sub-agents to narrate live progress via /speak.
const MOBILE_MODE_TAG = `

MOBILE/ON-THE-GO MODE IS ACTIVE — user is away from a screen. Adjust all behavior:

VOICE OUTPUT — MOBILE OVERRIDES (replace standard 1-3 sentence rule):
- 3-8 sentences is acceptable for technical or complex topics. Give real substance.
- Use running-commentary style: name what you are finding, what it means, what you are checking next. Think live analyst narrating.
- Spoken transitions encouraged: "All right so...", "Interesting —", "Digging into that..."
- Round numbers and describe code concepts in plain English — never read syntax verbatim.
- Still no markdown, URLs, file paths, or channel IDs spoken aloud.

SUB-AGENT SPOKEN UPDATES — MANDATORY IN MOBILE MODE:
When spawning a sub-agent for any technical or investigative task (malware RE, code review, network investigation, system audit, log analysis, security research, etc.):
1. Kickoff speak immediately after spawn: curl /speak "Starting [task] — walking you through it as I go..."
2. Mid-task progress: call /speak 2-3 times DURING work, not only at completion:
   - Each key discovery: "Found [what] — that means [significance]. Checking [what is next]..."
   - Halfway summary: "About halfway — so far [brief finding summary]..."
3. Completion: curl /speak "[2-sentence spoken summary of findings]. Full details posted to general."
4. Post complete technical output (disassembly, IOCs, configs, code, raw data) to Discord #general for screen review later.

Keep each /speak update to 1-2 spoken sentences — frequent and brief. Goal: user feels alongside the work in real time.`;

// Dynamic VOICE_TAG — composes mode overlays at call time
function getVoiceTag() {
  let tag = VOICE_TAG_BASE;
  if (isMobileModeEnabled()) tag += MOBILE_MODE_TAG;
  if (isAskModeEnabled()) tag += ASK_MODE_INSTRUCTION;
  return tag;
}

// Sentence boundary pattern — split on . ! ? followed by space or end
// Only split on sentence-ending punctuation, NOT commas (causes choppy audio)
const SENTENCE_END = /[.!?]+(?:\s|$)/;
const PHRASE_END = /[.!?]+\s+/; // Sentence-ending punctuation only

// Patterns that are agent signals, not speech — suppress from TTS
// Catches: NO, NO_, NO_REPLY, _NO, _NO_REPLY, HEARTBEAT_OK, and partials
const AGENT_SIGNAL_PATTERN = /^\s*_?(NO_?R?E?P?L?Y?|HEARTBEAT_?O?K?|NO)\s*[.!?]*\s*$/i;

/**
 * Trim response for voice - strip any markdown that slipped through
 */
export function trimForVoice(text) {
  let clean = text
    .replace(/<br\s*\/?>/gi, ' ')            // <br> / <br/> HTML line breaks → space
    .replace(/<\/?p>/gi, ' ')                // <p> / </p> HTML paragraphs → space
    .replace(/<[^>]+>/g, '')                 // any remaining HTML tags → remove
    .replace(/\[\[tts:[^\]]*\]\]/g, '')      // [[tts:anything]] complete tag → remove
    .replace(/\[\[\/tts:[^\]]*\]\]/g, '')    // [[/tts:anything]] closing tag → remove
    .replace(/\[\[reply_to[^\]]*\]\]/g, '')  // [[reply_to:...]] tags → remove
    .replace(/\[\[tts:[^\]]*$/g, '')         // [[tts:partial (unclosed) → remove
    .replace(/\[\[\/tts:[^\]]*$/g, '')       // [[/tts:partial (unclosed) → remove
    .replace(/\[\[(?:tts|reply_to)[^\]]*$/g, '') // any unclosed [[ tag at end
    .replace(/^\]\]/g, '')                   // orphaned ]] at start → remove
    .replace(/\]\]\s*/g, '')                 // orphaned ]] anywhere → remove
    .replace(/\*\*([^*]+)\*\*/g, '$1')       // bold
    .replace(/\*([^*]+)\*/g, '$1')           // italic
    .replace(/#{1,6}\s+/g, '')               // headers
    .replace(/```[\s\S]*?```/g, '')          // code blocks
    .replace(/`([^`]+)`/g, '$1')             // inline code
    .replace(/^[-*+]\s+/gm, '')              // bullets
    .replace(/^\d+\.\s+/gm, '')              // numbered lists
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // markdown links → text only
    .replace(/https?:\/\/\S+/g, '')          // bare URLs → remove entirely
    .replace(/\/[\w./-]+\.\w+/g, '')         // file paths like /home/user/file.txt → remove
    .replace(/\b[a-f0-9]{7,40}\b/g, '')     // commit hashes → remove
    .replace(/<#\d+>/g, '')                  // Discord channel mentions → remove
    .replace(/<@!?\d+>/g, '')               // Discord user mentions → remove
    .replace(/<@&\d+>/g, '')                // Discord role mentions → remove
    .replace(/\b\d{10,20}\b/g, '')           // Discord channel/message IDs → remove
    .replace(/\n{2,}/g, '. ')               // double newlines to periods
    .replace(/\n/g, ' ')                     // single newlines to spaces
    .replace(/\s{2,}/g, ' ')                // collapse spaces
    .trim();
  
  return clean;
}

/**
 * Generate response via streaming SSE — calls onSentence() as each
 * complete sentence arrives, so TTS can start immediately.
 * 
 * @param {string} userMessage - The transcribed voice input
 * @param {Array} history - Conversation history
 * @param {AbortSignal} signal - For cancellation
 * @param {Function} onSentence - Called with each complete sentence
 * @param {object} [options] - Additional context options
 * @param {string} [options.speaker] - Speaker's display name (for multi-user)
 * @param {object} [options.sentiment] - Sentiment data from STT { sentiment, sentiment_score }
 * @returns {{ text: string, aborted?: boolean }} Full response text
 */
export async function generateResponseStreaming(userMessage, history = [], signal, onSentence, options = {}) {
  const _now = new Date();
  let contextTags = `[DATETIME: ${_now.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}] `;
  if (options.speaker) {
    contextTags += `[SPEAKER: ${options.speaker}] `;
  }
  if (options.sentiment && options.sentiment.sentiment && options.sentiment.sentiment !== 'neutral') {
    const score = options.sentiment.sentiment_score != null ? `, score: ${options.sentiment.sentiment_score.toFixed(2)}` : '';
    contextTags += `[SENTIMENT: ${options.sentiment.sentiment}${score}] `;
  }
  // Inject active alert context
  const alertCtx = getActiveAlert();
  if (alertCtx) {
    contextTags += `[ALERT CONTEXT: You just spoke this alert: "${alertCtx}". User's next message responds to THIS — not prior conversation. Address the alert first.] `;
    clearActiveAlert();
  }
  const voiceMessage = `${getVoiceTag()}\n\n${contextTags}${userMessage}`;
  
  const messages = [
    ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: voiceMessage },
  ];
  
  if (signal?.aborted) {
    return { text: '', aborted: true };
  }

  // Circuit open — speak immediately rather than failing inside resilientFetch
  if (circuitBreaker.isOpen()) {
    const offlineMsg = "I'm offline right now. My brain is unreachable.";
    onSentence(offlineMsg);
    return { text: offlineMsg, offline: true };
  }

  let buffer = ''; // Declare outside try so catch handler can access it
  let fullText = ''; // Declare outside try so catch handler can check if anything was spoken

  const voiceModel = isAskModeEnabled() ? 'anthropic-console/claude-opus-4-6' : (process.env.VOICE_MODEL || 'anthropic-console/claude-sonnet-4-6');

  // ── Non-streaming path (VOICE_STREAMING=false) ──────────────────────
  // CLI providers (cursor-agent) don't support SSE. Fetch full response,
  // split into sentences, feed to onSentence() for TTS pipeline.
  if (!VOICE_STREAMING) {
    try {
      logger.info(`🔄 Non-streaming request to gateway (model: ${voiceModel})`);
      const res = await resilientFetch(COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        },
        body: JSON.stringify({
          messages,
          max_tokens: 8192,
          user: SESSION_USER,
          stream: false,
          model: voiceModel,
        }),
      }, signal);

      if (!res.ok) {
        const body = await res.text();
        logger.error('Gateway Error:', res.status, body);
        throw new Error(`Gateway ${res.status}: ${body}`);
      }

      const data = await res.json();
      fullText = data.choices?.[0]?.message?.content || '';
      fullText = trimForVoice(fullText);

      // Check for agent signals
      if (AGENT_SIGNAL_PATTERN.test(fullText.trim())) {
        return { text: '', silent: true };
      }

      if (!fullText || fullText.length < 2) {
        logger.warn('Gateway returned empty/whitespace response (subagent likely spawned)');
        return { text: '', empty: true };
      }

      // Split into sentences and feed to TTS pipeline
      // Use <p> tags as primary split points, then sentence boundaries
      const paragraphs = fullText.split('<p>').map(p => p.trim()).filter(p => p.length > 0);
      for (const para of paragraphs) {
        // Split paragraph into sentences on . ! ? followed by space
        const sentences = para.match(/[^.!?]+[.!?]+[\s]?|[^.!?]+$/g) || [para];
        for (const sentence of sentences) {
          const clean = trimForVoice(sentence.trim());
          if (clean && clean.length > 1 && !AGENT_SIGNAL_PATTERN.test(clean)) {
            onSentence(clean);
          }
        }
      }

      return { text: fullText.replace(/<p>/g, '\n\n') };

    } catch (err) {
      if (err.name === 'AbortError') {
        return { text: '', aborted: true };
      }
      logger.error('Gateway failed (non-streaming):', err.message);
      onSentence("I'm having trouble connecting right now. Try again?");
      return { text: "I'm having trouble connecting right now. Try again?" };
    }
  }

  // ── Streaming path (default) ────────────────────────────────────────
  try {
    const res = await resilientFetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        messages,
        max_tokens: 8192,
        user: SESSION_USER,
        stream: true,
        model: voiceModel,
      }),
    }, signal);

    if (!res.ok) {
      const body = await res.text();
      logger.error('Gateway Error:', res.status, body);
      throw new Error(`Gateway ${res.status}: ${body}`);
    }

    // Parse SSE stream, accumulate text, emit sentences (phrase-level for voice)
    fullText = '';
    let firstSentenceEmitted = false;
    let firstTokenReceived = false;
    let firstTokenTimerFired = false;
    let lastTokenTime = Date.now(); // Track when we last received a token
    const PAUSE_THRESHOLD_MS = 2000; // If no tokens for 2s, emit buffer chunk

    // First-token timeout: if no streaming token arrives in 15s, speak interim feedback
    let firstTokenTimer = null;
    if (GATEWAY_FIRST_TOKEN_TIMEOUT_MS > 0) {
      firstTokenTimer = setTimeout(async () => {
        if (!firstTokenReceived && !signal?.aborted) {
          firstTokenTimerFired = true;
          // Try contextual interim; fall back to generic if it fails or is disabled
          if (AGENT_DISPATCH_ACK_ENABLED) {
            try {
              const interim = await generateContextualInterim(userMessage);
              logger.info(`First-token timeout (${GATEWAY_FIRST_TOKEN_TIMEOUT_MS}ms) -- contextual interim: "${interim}"`);
              onSentence(interim);
            } catch {
              logger.info(`First-token timeout (${GATEWAY_FIRST_TOKEN_TIMEOUT_MS}ms) -- speaking generic interim`);
              onSentence('One moment.');
            }
          } else {
            logger.info(`First-token timeout (${GATEWAY_FIRST_TOKEN_TIMEOUT_MS}ms) -- speaking interim`);
            onSentence('One moment.');
          }
        }
      }, GATEWAY_FIRST_TOKEN_TIMEOUT_MS);
    }
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let pauseCheckInterval = null;
    
    // Check for pauses every 500ms while streaming
    // If no tokens for 2s, emit buffer chunk so user doesn't wait
    const checkForPause = () => {
      if (Date.now() - lastTokenTime > PAUSE_THRESHOLD_MS && buffer.trim().length > 0) {
        const phrase = trimForVoice(buffer.trim());
        if (phrase && phrase.length > 2 && !AGENT_SIGNAL_PATTERN.test(phrase)) {
          // Hold back first emission if it looks like start of a signal (NO, _NO → NO_REPLY)
          if (!firstSentenceEmitted && /^_?NO_?$/i.test(phrase)) {
            return; // Wait for more tokens
          }
          onSentence(phrase);
          buffer = '';
          lastTokenTime = Date.now(); // Reset timer
        }
      }
    };
    
    // Start pause check interval
    pauseCheckInterval = setInterval(checkForPause, 500);
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      sseBuffer += decoder.decode(value, { stream: true });
      
      // Process complete SSE lines
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop(); // Keep incomplete line
      
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (!content) continue;
          
          buffer += content;
          fullText += content;
          lastTokenTime = Date.now(); // Reset pause timer on new token

          // Clear first-token timer on first real content
          if (!firstTokenReceived) {
            firstTokenReceived = true;
            if (firstTokenTimer) { clearTimeout(firstTokenTimer); firstTokenTimer = null; }
          }
          
          // Strip [[tts:...]] tags from the streaming buffer before sentence detection
          buffer = buffer.replace(/\[\[tts:[^\]]*\]\]/g, '');
          buffer = buffer.replace(/\[\[\/tts:text\]\]/g, '');
          buffer = buffer.replace(/\[\[tts:text\]\]/g, '');
          buffer = buffer.replace(/\[\[reply_to[^\]]*\]\]/g, '');
          
          // Filter out NO_REPLY / _NO_REPLY / HEARTBEAT_OK signals
          if (/^\s*_?NO_?REPLY\s*$/i.test(buffer) || /^\s*HEARTBEAT_?OK\s*$/i.test(buffer)) {
            buffer = '';
            continue;
          }
          
          // Split on <p> paragraph tags — emit one complete paragraph per TTS chunk
          // This avoids choppy sentence-by-sentence audio; model inserts <p> at natural breaks
          while (buffer.includes('<p>')) {
            const tagIdx = buffer.indexOf('<p>');
            let paragraph = buffer.substring(0, tagIdx).trim();
            buffer = buffer.substring(tagIdx + 3).trim(); // consume <p>

            paragraph = trimForVoice(paragraph);
            if (!paragraph || paragraph.length < 2 || AGENT_SIGNAL_PATTERN.test(paragraph)) continue;

            firstSentenceEmitted = true;
            onSentence(paragraph);
          }
        } catch {}
      }
    }
    
    // Clean up timers
    clearInterval(pauseCheckInterval);
    if (firstTokenTimer) { clearTimeout(firstTokenTimer); firstTokenTimer = null; }
    
    // Flush remaining buffer as final sentence
    if (buffer.trim()) {
      const final = trimForVoice(buffer.trim());
      if (final && final.length > 1 && !AGENT_SIGNAL_PATTERN.test(final)) {
        onSentence(final);
      }
    }
    
    // Strip signal fragments from fullText (SSE may interleave signals with content)
    // Removes NO_REPLY, _NO_REPLY, HEARTBEAT_OK, and partial fragments
    fullText = fullText.replace(/\s*_?NO_?R?E?P?L?Y?\s*/gi, ' ')
                       .replace(/\s*HEARTBEAT_?O?K?\s*/gi, ' ')
                       .trim();

    // Check for NO_REPLY / HEARTBEAT_OK -- agent had nothing to say
    const trimmedFull = fullText.trim();
    if (!trimmedFull || AGENT_SIGNAL_PATTERN.test(trimmedFull)) {
      return { text: '', silent: true };
    }

    // Empty response detection -- gateway returned nothing useful
    // If empty, a subagent was likely spawned and will call /speak when done.
    // Stay silent -- don't ack, the result will come back via webhook.
    const cleanedFull = trimForVoice(fullText);
    if (!cleanedFull || cleanedFull.length < 2) {
      logger.warn('Gateway returned empty/whitespace response (subagent likely spawned)');
      return { text: '', empty: true };
    }

    return { text: cleanedFull };
    
  } catch (err) {
    if (err.name === 'AbortError') {
      return { text: '', aborted: true };
    }
    logger.error('Gateway failed:', err.message);

    // Flush whatever we have
    if (buffer && buffer.trim()) {
      const partial = trimForVoice(buffer.trim());
      if (partial) onSentence(partial);
    }

    // Speak connection failure feedback if nothing was spoken yet
    if (!fullText || trimForVoice(fullText).length < 2) {
      onSentence("I'm having trouble connecting right now. Try again?");
    }

    return { text: "I'm having trouble connecting right now. Try again?" };
  }
}

/**
 * Generate response (non-streaming fallback)
 * @param {string} userMessage - The transcribed voice input
 * @param {Array} history - Conversation history
 * @param {AbortSignal} signal - For cancellation
 * @param {object} [options] - Additional context options
 * @param {string} [options.speaker] - Speaker's display name (for multi-user)
 * @param {object} [options.sentiment] - Sentiment data from STT
 */
export async function generateResponse(userMessage, history = [], signal, options = {}) {
  const _now = new Date();
  let contextTags = `[DATETIME: ${_now.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}] `;
  if (options.speaker) {
    contextTags += `[SPEAKER: ${options.speaker}] `;
  }
  if (options.sentiment && options.sentiment.sentiment && options.sentiment.sentiment !== 'neutral') {
    const score = options.sentiment.sentiment_score != null ? `, score: ${options.sentiment.sentiment_score.toFixed(2)}` : '';
    contextTags += `[SENTIMENT: ${options.sentiment.sentiment}${score}] `;
  }
  const voiceMessage = `${getVoiceTag()}\n\n${contextTags}${userMessage}`;
  
  const messages = [
    ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: voiceMessage },
  ];
  
  if (signal?.aborted) {
    return { text: '', aborted: true };
  }
  
  try {
    const res = await resilientFetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        messages,
        max_tokens: 8192,
        user: SESSION_USER,
        model: isAskModeEnabled() ? 'anthropic-console/claude-opus-4-6' : (process.env.VOICE_MODEL || 'anthropic-console/claude-sonnet-4-6'),
      }),
    }, signal);
    
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gateway ${res.status}: ${body}`);
    }
    
    const data = await res.json();
    let text = data.choices?.[0]?.message?.content || "Trouble thinking. Try again?";
    text = trimForVoice(text);
    return { text };
    
  } catch (err) {
    if (err.name === 'AbortError') {
      return { text: '', aborted: true };
    }
    logger.error('Gateway failed:', err.message);
    return { text: "I'm having trouble connecting right now. Try again?" };
  }
}

// ── Fast Acknowledgment ──────────────────────────────────────────────
// Generates a 1-sentence spoken acknowledgment using a fast model (haiku).
// No tools, no history, no blocking — just "On it." style response in <2s.

/**
 * Generate a brief spoken acknowledgment for a voice request.
 * Uses a lightweight model with no tools. Returns in ~1-2s.
 * Falls back to "On it." if the call fails or times out.
 *
 * @param {string} userMessage - The transcribed voice input
 * @returns {Promise<string>} - Short ack string e.g. "On it, sir."
 */
export async function generateAck(userMessage) {
  const ACK_SYSTEM = `You are Jarvis, a British AI butler. Generate exactly ONE brief acknowledgment sentence (4-8 words) for this voice request. No explanation. No tools. Just the ack. Speak in first person. Examples: "On it, sir.", "Checking that now.", "Give me a moment.", "Right away.", "Looking into that."`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACK_TIMEOUT_MS);

  try {
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: ACK_MODEL,
        stream: false,
        max_tokens: 30,
        messages: [
          { role: 'system', content: ACK_SYSTEM },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) throw new Error(`Ack HTTP ${res.status}`);
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content?.trim();
    return text || 'On it.';
  } catch (err) {
    clearTimeout(timer);
    logger.warn(`⚡ Ack generation failed (${err.message}) — using fallback`);
    return 'On it.';
  }
}

// ── Contextual Agent Dispatch Acknowledgment ─────────────────────────
// Based on actual J.A.R.V.I.S. dialogue patterns from Iron Man (2008),
// Iron Man 2 (2010), Iron Man 3 (2013), The Avengers (2012),
// Avengers: Age of Ultron (2015).
//
// Design principles derived from movie Jarvis:
// - Task acks are 3-10 words. Never a full explanation.
// - "sir" appears ~60% of the time, more in formal/complex tasks.
// - Jarvis names the action, not the process. "Deploying countermeasures." not "I'm going to start deploying..."
// - Status updates are declarative: "Flight power restored." "The barrier is pure energy."
// - Completion is terse: "All wrapped up here, sir." "Yes, sir."
// - Pushback is polite but direct: "Sir, the suit is not combat-ready."

const CONTEXTUAL_ACK_SYSTEM = `You are J.A.R.V.I.S. from Iron Man. Generate ONE brief spoken acknowledgment (6-12 words max) for a sub-agent task being dispatched.

REAL JARVIS PATTERNS (use these as your template):
Task dispatch: "For you, sir, always.", "As you wish, sir.", "Yes, sir.", "Right away, sir."
Running analysis: "Initiating virtual crime scene reconstruction.", "Creating a flight plan for Tennessee."
Status report: "The Oracle cloud has completed analysis.", "All wrapped up here, sir."
With subject: "Accessing satellites and plotting thermogenic occurrences now.", "I've compiled a Mandarin database for you, sir."

RULES:
- Name the SPECIFIC action + subject from the request. Not generic.
- 6-12 words. Terse. Declarative.
- Use "sir" naturally (~60% of the time). More for complex/formal tasks.
- NO filler: no "I'll be working on", no "Let me go ahead and", no "I'm going to".
- NO tools, no markdown, no explanation.
- Present tense or imperative: "Running the analysis now, sir." not "I will run the analysis."
- If the task involves a specific model (Opus, Cursor), you may mention it: "Spinning up Opus for the code review, sir."
- For long tasks (code review, security scan, research): append "That'll take a moment." or "I'll have the result shortly."
- For quick tasks: just the action. No time estimate.
- Sound like the MOVIE Jarvis, not a generic AI assistant.`;

// Canned fallback acks — used when LLM call times out (>1.5s) or fails.
// Rotated to avoid repetition. Modeled on actual Jarvis lines.
const CANNED_DISPATCH_ACKS = [
  'On it, sir.',
  'Right away, sir.',
  'Working on it now.',
  'Give me just a moment, sir.',
  'Already on it.',
  'As you wish, sir.',
  'Understood, sir.',
  'Processing that now.',
];
let _cannedAckIndex = 0;

function getNextCannedAck() {
  const ack = CANNED_DISPATCH_ACKS[_cannedAckIndex % CANNED_DISPATCH_ACKS.length];
  _cannedAckIndex++;
  return ack;
}

/**
 * Generate a contextual, Jarvis-style spoken ack for a sub-agent dispatch.
 * Uses a fast model with a 1.5s hard timeout — falls back to canned phrase if slow.
 *
 * @param {string} userRequest - The full transcribed user utterance
 * @param {string} [taskType] - What kind of agent is spawned (code review, research, etc.)
 * @param {string} [modelName] - What model is being used (opus-high, sonnet, cursor, etc.)
 * @returns {Promise<string>} - Contextual ack string e.g. "Running an Opus code review on ENG-695, sir."
 */
export async function generateContextualAck(userRequest, taskType, modelName) {
  if (!AGENT_DISPATCH_ACK_ENABLED) return null;

  const userPrompt = `User said: "${userRequest}"${taskType ? `\nTask type: ${taskType}` : ''}${modelName ? `\nModel: ${modelName}` : ''}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTEXTUAL_ACK_TIMEOUT_MS);

  try {
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: ACK_MODEL,
        stream: false,
        max_tokens: 50,
        messages: [
          { role: 'system', content: CONTEXTUAL_ACK_SYSTEM },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) throw new Error(`ContextualAck HTTP ${res.status}`);
    const json = await res.json();
    let text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return getNextCannedAck();
    // Strip quotes if the model wraps in them
    text = text.replace(/^["']|["']$/g, '');
    // Enforce max length — if model was verbose, truncate gracefully
    if (text.length > 120) {
      const dotIdx = text.indexOf('.', 40);
      text = dotIdx > 0 ? text.substring(0, dotIdx + 1) : text.substring(0, 100) + '.';
    }
    return text;
  } catch (err) {
    clearTimeout(timer);
    logger.warn(`⚡ Contextual ack timed out or failed (${err.message}) — using canned fallback`);
    return getNextCannedAck();
  }
}

/**
 * Generate a contextual "still working" interim message.
 * Fires when the gateway takes >8s for first token (sessions_spawn call in progress).
 * Instead of generic "One moment.", produces something like "Still running the analysis, sir."
 *
 * @param {string} userRequest - The original user utterance (for context)
 * @returns {Promise<string>} - Contextual interim e.g. "The review is still in progress, sir."
 */
export async function generateContextualInterim(userRequest) {
  const INTERIM_SYSTEM = `You are J.A.R.V.I.S. The user asked something and it's taking longer than expected. Generate ONE brief status update (4-8 words). Examples from the movies: "Still working on it, sir.", "One moment, sir.", "Almost there.", "The analysis is still running." Be contextual — reference what the user asked about. No tools, no markdown.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTEXTUAL_ACK_TIMEOUT_MS);

  try {
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: ACK_MODEL,
        stream: false,
        max_tokens: 30,
        messages: [
          { role: 'system', content: INTERIM_SYSTEM },
          { role: 'user', content: `Original request: "${userRequest}"\n\nIt's been 8+ seconds with no response yet. Generate a brief contextual "still working" message.` },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) throw new Error(`Interim HTTP ${res.status}`);
    const json = await res.json();
    let text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return 'One moment.';
    text = text.replace(/^["']|["']$/g, '');
    return text;
  } catch (err) {
    clearTimeout(timer);
    return 'One moment.';
  }
}

// ── Webhook Callback Mode ────────────────────────────────────────────
// Fire-and-forget: POST to /hooks/agent, gateway processes with no timeout
// pressure. Response delivered back via /speak endpoint on the voice bot.

/**
 * Dispatch a voice request via gateway webhook (async callback).
 * The hook instruction tells the agent to POST the response to /speak.
 * Returns immediately — response arrives via /speak webhook.
 * 
 * @param {string} userMessage - The transcribed voice input
 * @param {Array} history - Conversation history (used for context in the message)
 * @param {object} [options] - { speaker, sentiment }
 * @returns {{ dispatched: boolean, error?: string }}
 */
/**
 * Generate a text-channel response (no voice formatting, no trimForVoice).
 * Used for @mention handling in Discord text channels.
 * Routes through the same gateway session but with a [TEXT] tag instead of [VOICE].
 */
export async function generateTextResponse(userMessage, options = {}) {
  const textTag = `[TEXT] Discord text channel mention. User tagged @Jarvis in a channel.
You are Jarvis — same agent, same tools. Respond in Discord markdown (bold, code blocks, etc. are fine).
No voice constraints — full detail is OK. Use tools via sessions_spawn as needed.
If the task requires action, call sessions_spawn and tell the user you're on it.
Post results back to the same channel (channel: "discord", target: "${options.channelId || _defaultTextChannel}").`;

  const messages = [
    { role: 'user', content: `${textTag}\n\n${userMessage}` },
  ];

  try {
    const res = await resilientFetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        messages,
        max_tokens: 8192,
        user: options.sessionUser || SESSION_USER,
        model: process.env.VOICE_MODEL || 'anthropic-console/claude-sonnet-4-6',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gateway ${res.status}: ${body}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    return { text };

  } catch (err) {
    logger.error('Text gateway failed:', err.message);
    return { text: "Having trouble connecting to the gateway right now." };
  }
}

export async function dispatchViaWebhook(userMessage, history = [], options = {}) {
  const _now = new Date();
  let contextTags = `[DATETIME: ${_now.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}] `;
  if (options.speaker) {
    contextTags += `[SPEAKER: ${options.speaker}] `;
  }
  if (options.sentiment && options.sentiment.sentiment && options.sentiment.sentiment !== 'neutral') {
    const score = options.sentiment.sentiment_score != null ? `, score: ${options.sentiment.sentiment_score.toFixed(2)}` : '';
    contextTags += `[SENTIMENT: ${options.sentiment.sentiment}${score}] `;
  }
  const voiceMessage = `${getVoiceTag()}\n\n${contextTags}${userMessage}`;

  // Wrap the voice message with delivery instructions
  const hookMessage = `${voiceMessage}

IMPORTANT: After generating your response, deliver it by running this command:
curl -s -X POST ${SPEAK_URL} -H "Authorization: Bearer ${SPEAK_TOKEN}" -H "Content-Type: application/json" -d '{"message":"YOUR_RESPONSE_HERE","source":"voice-callback"}'

Replace YOUR_RESPONSE_HERE with your actual spoken response (escaped for JSON). This is how the voice bot receives your answer.`;

  try {
    const res = await fetch(HOOKS_AGENT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HOOKS_TOKEN}`,
      },
      body: JSON.stringify({
        message: hookMessage,
        sessionKey: SESSION_USER,
        wakeMode: 'now',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error('Webhook dispatch failed:', res.status, body);
      return { dispatched: false, error: `${res.status}: ${body}` };
    }

    logger.info('📨 Dispatched to gateway webhook (async callback via /speak)');
    return { dispatched: true };
  } catch (err) {
    logger.error('Webhook dispatch error:', err.message);
    return { dispatched: false, error: err.message };
  }
}
