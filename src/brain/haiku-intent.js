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
 *   session_start / chat_project — coding session hooks
 *   calendar_query / gmail_check / notion_fetch / notion_meeting / slack_search
 *     — MCP-backed lookups; handled by mcp-intent-handlers.js, data
 *       pre-fetched via mcporter and injected as workspaceContext before
 *       the brain call (no MCP tools needed inside the Claude subprocess).
 *   not_command  — conversational / open-ended → send to brain
 */

import logger from '../logger.js';
import { listChannels } from '../focus-state.js';
import { listPersonalities } from './brain.js';
import { listProjectMaps } from '../slash/project-map.js';

const GATEWAY_URL = process.env.JARVIS_GATEWAY_URL || process.env.GATEWAY_URL || 'http://127.0.0.1:22100';
const GATEWAY_TOKEN = process.env.JARVIS_GATEWAY_TOKEN;
const COMPLETIONS_URL = `${GATEWAY_URL}/v1/chat/completions`;

// Model: Haiku for speed. ~500ms for a classification call.
const CLASSIFIER_MODEL = process.env.HAIKU_INTENT_MODEL || 'jamesgroup/claude-haiku-4-5';
const CLASSIFIER_TIMEOUT_MS = parseInt(process.env.HAIKU_INTENT_TIMEOUT_MS || '1500');

// Build channel vocabulary from registry (refreshed on each call — registry can change)
function buildVocabulary() {
  const channels = listChannels();
  const channelVocab = channels.map(ch => {
    const aliases = ch.aliases?.length ? ` (aliases: ${ch.aliases.join(', ')})` : '';
    return `  - ${ch.name}${aliases}`;
  }).join('\n');

  const personas = listPersonalities();
  const personaVocab = personas.join(', ');

  const projects = listProjectMaps();
  const projectVocab = projects.length
    ? projects.map(p => `  - ${p.name} (box: ${p.box}, cwd: ${p.cwd})`).join('\n')
    : '  (none yet)';

  return { channelVocab, personaVocab, projectVocab };
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

6. session_start — user wants to start or resume a coding/tmux session in a known project channel
   Triggers: "go to X", "jump into X", "start working on X", "resume X", "open X on <box>",
             "get into X", "pull up X", "dev X", "work on X", "fire up X", "hop into X"
   Only match if the project name (X) appears in AVAILABLE PROJECTS.
   Params: { name: "<project name from list>", box: "<box name if mentioned, else null>" }

7. chat_project — user wants a lightweight text chat response with project context (no tmux session)
   Triggers: "chat", "quick chat", "just chat", "chat openjarvis", "hey chat", "chat about X"
   Params: { name: "<project name if mentioned, else null>" }

8. calendar_query — user wants to check a calendar (own events, availability, someone else's freebusy)
   Triggers: "is <person> free at <time>", "what's on my calendar", "am I busy at <time>",
             "what do I have <day>", "next meeting", "<person>'s availability", "when is <person> free"
   Params: { person: "<name or email, null for self>", timeStart: "<ISO 8601 or null>",
             timeEnd: "<ISO 8601 or null>", relativeDay: "<today|tomorrow|monday|null>" }

9. gmail_check — user wants to search their email
   Triggers: "any emails from <person>", "emails about <topic>", "latest from <person>",
             "unread emails", "check my inbox for <X>", "anything new from <sender>"
   Params: { from: "<sender email/name or null>", subject: "<subject keywords or null>",
             newerThan: "<1d|7d|14d|null>", unread: <true|false> }

10. notion_fetch — user wants to pull up a Notion page or search Notion
    Triggers: "pull up the <page title> in Notion", "what's in the <X> doc",
              "show me the <topic> Notion page", "check the Notion doc about <X>"
    Params: { pageQuery: "<search keywords>", title: "<exact title if mentioned, else null>" }

11. notion_meeting — user wants meeting notes from Notion
    Triggers: "today's meeting notes", "the weekly 1:1 notes", "latest meeting with <person>",
              "meeting notes from <day>", "what did we decide in <meeting>"
    Params: { titleQuery: "<keywords or null>", days: <number, default 14> }

12. slack_search — user wants to search Slack messages
    Triggers: "what did <person> say about <topic>", "any Slack about <X>",
              "check Slack for <topic>", "<person>'s messages about <X>", "Slack thread on <topic>"
    Params: { query: "<search keywords>", channel: "<channel hint or null>",
              from: "<person name or null>" }

13. needs_agent — the user is asking for something that clearly needs broad tool access
    (shell commands, file edits, SSH to a box, browser automation, reading logs, running
    migrations, scraping sites, editing code, running tests, etc.). NOT for simple lookups
    already covered by intents 8-12. This triggers auto-spawn of a dedicated agent thread
    with full MCP — the agent does the work in the thread while Jarvis acks briefly by voice.

    Triggers (high confidence only — when in doubt, prefer not_command):
      - "check if the gateway service is up on generic"
      - "SSH into chris-dev and tail the error logs"
      - "run the migration on staging and tell me what breaks"
      - "scrape this URL and pull out the pricing"
      - "edit my .bashrc and add a line that says X"
      - "look through all my python files for the import of Y"
      - "restart jarvis-voice and check the logs"
      - "build the project and fix any errors"

    NOT triggers (stay on not_command):
      - "what's the weather" (chat)
      - "what's on my calendar tomorrow" (covered by calendar_query)
      - "any emails from <person>" (covered by gmail_check)
      - "pull up the Notion page about X" (covered by notion_fetch)
      - "what did <person> say in slack about auth" (covered by slack_search)
      - "what do you think about X" (pure conversation)
      - "explain how Y works" (pure explanation — brain call is fine)

    Params: { task: "<the full request, cleaned up as a clear instruction for the agent>" }

14. not_command — this is NOT a structured command. It's a question, request, conversation, or task.
    Use this for anything that doesn't clearly match the above intents.

IMPORTANT:
- When in doubt, return not_command. False positives are worse than false negatives.
- For session_start: ONLY match if the project name is in the AVAILABLE PROJECTS list. Do not invent projects.
- Match channel/project names fuzzily (e.g. "deploy" matches "deployments", "openjarvis" matches "open jarvis")
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

  const { channelVocab, personaVocab, projectVocab } = buildVocabulary();

  const userMessage = `AVAILABLE CHANNELS:\n${channelVocab}\n\nAVAILABLE PERSONAS: ${personaVocab}\n\nAVAILABLE PROJECTS:\n${projectVocab}\n\nTRANSCRIPT: "${transcript}"`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);

  try {
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        'X-Jarvis-Scopes': 'operator.write',
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

    // Parse JSON response — handle potential markdown wrapping.
    // Previously only matched ```json / ```jsonc fences — plain ``` fences
    // (which Haiku sometimes emits) fell through and JSON.parse threw.
    const jsonStr = content
      .replace(/^\s*```(?:json|jsonc)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();
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
