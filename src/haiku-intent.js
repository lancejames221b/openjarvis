/**
 * haiku-intent.js — Fast LLM intent classifier (Tier 2)
 *
 * Sits between regex dispatch and the full brain. When regex doesn't match
 * a voice command, this module makes a single fast Haiku call (~500ms-1s)
 * to extract structured intent + parameters from natural speech.
 *
 * Only classifies — does NOT execute. Returns a structured intent that
 * command-dispatch acts on through existing handlers.
 *
 * Intents covered:
 *   focus_set    — "focus on the deploy channel", "let's work on gibson", "bring up ewitness"
 *   focus_clear  — "stop focusing", "drop the focus", "no more focus"
 *   focus_query  — "what channel am I on", "where's my focus"
 *   channel_list — "what channels do I have", "show me the channels"
 *   persona      — "be snoop", "switch to alfred voice"
 *   not_command  — conversational / open-ended → send to brain
 */

import logger from './logger.js';
import { listChannels } from './focus-state.js';
import { listPersonalities } from './brain.js';

const GATEWAY_URL = process.env.CLAWDBOT_GATEWAY_URL || process.env.GATEWAY_URL || 'http://127.0.0.1:22100';
const GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN;
const COMPLETIONS_URL = `${GATEWAY_URL}/v1/chat/completions`;

// Model: Haiku for speed. ~500ms for a classification call.
const CLASSIFIER_MODEL = process.env.HAIKU_INTENT_MODEL || 'unit/claude-haiku-4-5';
const CLASSIFIER_TIMEOUT_MS = parseInt(process.env.HAIKU_INTENT_TIMEOUT_MS || '3000');

// Build channel vocabulary from registry (refreshed on each call — registry can change)
function buildVocabulary() {
  const channels = listChannels();
  const channelVocab = channels.map(ch => {
    const aliases = ch.aliases?.length ? ` (aliases: ${ch.aliases.join(', ')})` : '';
    return `  - ${ch.name}${aliases}`;
  }).join('\n');

  const personas = listPersonalities();
  const personaVocab = personas.join(', ');

  return { channelVocab, personaVocab };
}

const SYSTEM_PROMPT = `You are a voice command intent classifier for a Discord voice assistant called Jarvis.

Given a spoken transcript, classify it into ONE of these intents and extract parameters.

INTENTS:
1. focus_set — user wants to switch focus/context to a specific channel
   Triggers: "focus on X", "switch to X", "work on X", "go to X", "bring up X", "let's do X", "open X", "take me to X", "X channel please", "let's focus on X"
   Params: { channel: "<best matching channel name>", thread: "<thread hint if mentioned, else null>" }

2. focus_clear — user wants to clear/reset focus
   Triggers: "clear focus", "no focus", "reset focus", "stop focusing", "unfocus", "drop focus"
   Params: {}

3. focus_query — user wants to know current focus/channel
   Triggers: "where am I", "what channel", "what focus", "current context", "what am I focused on"
   Params: {}

4. channel_list — user wants to see available channels
   Triggers: "list channels", "show channels", "what channels", "available channels"
   Params: {}

5. persona — user wants to switch voice persona
   Triggers: "be X", "switch to X voice/persona/mode", "use X", "activate X"
   Params: { persona: "<persona name>" }

6. not_command — this is NOT a structured command. It's a question, request, conversation, or task.
   Use this for anything that doesn't clearly match the above intents.

IMPORTANT:
- When in doubt, return not_command. False positives are worse than false negatives.
- Match channel names fuzzily (e.g. "deploy" matches "deployments", "voice dev" matches "jarvis-voice-dev")
- The user is speaking via STT — expect minor transcription errors, filler words, articles ("the", "a")

Respond with ONLY a JSON object, no markdown, no explanation:
{"intent": "<intent_name>", "params": {<params>}, "confidence": <0.0-1.0>}`;

/**
 * Classify a transcript into a structured intent using Haiku.
 *
 * @param {string} transcript - The cleaned transcript (wake word already stripped)
 * @returns {Promise<{intent: string, params: object, confidence: number} | null>}
 *   Returns null if classification fails or times out (caller should fall through to brain).
 */
export async function classifyIntent(transcript) {
  if (!GATEWAY_TOKEN) {
    logger.warn('[haiku-intent] No gateway token — skipping classification');
    return null;
  }

  // Don't classify very long transcripts — those are real conversations
  if (transcript.length > 200) {
    return { intent: 'not_command', params: {}, confidence: 1.0 };
  }

  const { channelVocab, personaVocab } = buildVocabulary();

  const userMessage = `AVAILABLE CHANNELS:\n${channelVocab}\n\nAVAILABLE PERSONAS: ${personaVocab}\n\nTRANSCRIPT: "${transcript}"`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);

  try {
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 150,
        model: CLASSIFIER_MODEL,
        user: 'jarvis-voice-intent-classifier',
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text();
      logger.warn(`[haiku-intent] Gateway ${res.status}: ${body.substring(0, 100)}`);
      return null;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      logger.warn('[haiku-intent] Empty response');
      return null;
    }

    // Parse JSON response — handle potential markdown wrapping
    const jsonStr = content.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
    const result = JSON.parse(jsonStr);

    if (!result.intent) {
      logger.warn(`[haiku-intent] No intent in response: ${content}`);
      return null;
    }

    logger.info(`[haiku-intent] "${transcript.substring(0, 50)}" → ${result.intent} (conf=${result.confidence}) params=${JSON.stringify(result.params)}`);
    return result;

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      logger.warn(`[haiku-intent] Timed out after ${CLASSIFIER_TIMEOUT_MS}ms`);
    } else if (err instanceof SyntaxError) {
      logger.warn(`[haiku-intent] Failed to parse response as JSON`);
    } else {
      logger.warn(`[haiku-intent] Error: ${err.message}`);
    }
    return null;
  }
}
