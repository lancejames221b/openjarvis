/**
 * thread-orchestrator — create-a-thread-with-gathered-context flow.
 *
 * Trigger: natural-language requests like
 *   "create a thread for the PR review, check Slack and hivemind for Alice's ones"
 *   "start a thread to review ENG-895"
 *   "open a research thread on project proxies"
 *
 * Flow:
 *   1. Parse intent → topic, threadName, contextSources (slack/haivemind), personHint
 *   2. Gather context in parallel (mcpCall slack + searchHaivemind)
 *   3. Create a Discord thread under the current channel
 *   4. Enable ask-mode (plan mode) + verbose-for-thread by default
 *   5. Seed the thread's Claude session via gateway POST with the gathered context
 *   6. Reply in the parent channel: "Started thread — context from: slack, haivemind"
 *
 * The seed prompt tells Claude to draft a plan, not execute. Combined with
 * `--permission-mode plan` from ask-mode, the new thread is a plan-first
 * workspace that reports back rather than running off.
 */

import { mcpCall } from '../mcp-access.js';
import { searchHaivemind } from '../agent/session-manager.js';
import { setAskMode } from './channel-ask-mode.js';
import { enableVerboseForThread } from '../verbose-mode.js';
import { setMcpMode } from './channel-mcp-mode.js';
import logger from '../logger.js';

// Concurrency dedup: if two orchestration triggers arrive for the same channel
// in quick succession (STT double-fire, double-tap send), we'd otherwise create
// two parallel 🧵 threads and do all the work twice. The Set gates entry.
const _inFlightOrch = new Set();

// Matches the orchestration trigger. Requires a trailing preposition (for/on/about/to)
// or colon after "thread" — without that constraint the regex fires on code questions
// like "how do I start a new thread in Go?" or "create a daemon thread" (false positives
// that created spurious Discord threads).
// Allows 0-3 adjectives between "a/an/the/new" and "thread" (e.g. "a new research thread").
const TRIGGER_RE = /\b(create|start|open|make|spin\s+up)\s+(?:a|an|the|new)\s+(?:\w+\s+){0,3}thread\b\s*(?:[:\-]|\b(for|on|about|to\s+review|to)\b)/i;

// Looser match used only to detect "the user clearly invoked a thread command".
// Not used for topic parsing.
const TRIGGER_LOOSE_RE = /\b(create|start|open|make|spin\s+up)\s+(?:a|an|the|new)\s+(?:\w+\s+){0,3}thread\b/i;

/** Detect whether a message is a thread-orchestration command. */
export function isOrchestrationCommand(text) {
  if (!text) return false;
  return TRIGGER_RE.test(text);
}

/**
 * Parse a thread-orchestration command.
 * Returns { topic, threadName, contextSources, personHint, originalText } or null.
 */
export function parseOrchestrationCommand(text) {
  if (!isOrchestrationCommand(text)) return null;
  const originalText = text.trim();
  const lower = originalText.toLowerCase();

  // Strip the trigger phrase, keeping only what follows.
  // Variants: "create a thread for X", "create a research thread on X", "create a thread: X",
  // "create a thread to review X" (note: `to review` first so `to` alone doesn't eat it).
  let topic = originalText
    .replace(/\b(create|start|open|make|spin\s+up)\s+(?:a|an|the|new)\s+(?:\w+\s+){0,3}thread\b\s*(?:[:\-]|\s+(?:for|on|about|to\s+review|to))\s+/i, '')
    .replace(TRIGGER_LOOSE_RE, '')
    .trim();

  // Thread name = first sentence (up to the first "." or ", check…" clause)
  // so "Create a thread for a new PR review. Check Slack for X" → name: "A New PR Review"
  let threadNameRaw = topic;
  const sentenceEnd = threadNameRaw.search(/[.!?]\s+[A-Z]|[.!?]$/);
  if (sentenceEnd > 0) threadNameRaw = threadNameRaw.substring(0, sentenceEnd);
  threadNameRaw = threadNameRaw
    .replace(/[,.;]?\s*(check(ing)?|look(ing)?\s+at|find|search(ing)?|pick(ing)?\s+up|continuing?|from\s+where).*$/i, '')
    .replace(/[,.;]?\s*(we\s+have|it'?s|its)\s+in\s+(hivemind|hive\s*mind|slack|notion).*/i, '')
    .replace(/[,.;]?\s*(in\s+|on\s+|via\s+)(slack|hivemind|hive\s*mind|notion|github).*$/i, '')
    .trim()
    .replace(/[,.;]+$/, '')
    .trim();

  // Context source detection
  const contextSources = [];
  if (/\b(slack|in\s+slack|check\s+slack|eng(ineering)?\s+slack|[a-z]+'s\s+slack)\b/.test(lower)) {
    contextSources.push('slack');
  }
  if (/\b(hivemind|hive\s*mind|haivemind|pick(ing)?\s+(this|that|it|back)?\s*up|from\s+where\s+we\s+are)\b/.test(lower)) {
    contextSources.push('haivemind');
  }
  // Default: always check hivemind, it's cheap and often relevant
  if (contextSources.length === 0) contextSources.push('haivemind');

  // Person hint: "Alice's ones", "Bob's PRs", "from <person>"
  let personHint = null;
  const posMatch = originalText.match(/\b([A-Z][a-z]{2,})'s\s+(ones|prs?|pull\s+requests?|messages|stuff|work)\b/);
  if (posMatch) personHint = posMatch[1];
  if (!personHint) {
    const fromMatch = originalText.match(/\bfrom\s+([A-Z][a-z]{2,})\b/);
    if (fromMatch) personHint = fromMatch[1];
  }

  // Thread name: title-case, strip filler, max 80 code points (not code units).
  // Use spread-to-array so emoji surrogate pairs aren't split mid-character —
  // Discord rejects thread names with unpaired surrogates.
  let threadName = threadNameRaw
    .replace(/^(a\s+|an\s+|the\s+|new\s+)+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!threadName) threadName = 'Research Thread';
  const threadChars = [...threadName];
  if (threadChars.length > 80) {
    threadName = threadChars.slice(0, 77).join('') + '...';
  }
  // Capitalize first letter for presentation
  threadName = threadName.charAt(0).toUpperCase() + threadName.slice(1);

  // Topic for search queries: keep it short and focused (grapheme-safe)
  const topicChars = [...threadNameRaw];
  let searchTopic = topicChars.length > 120 ? topicChars.slice(0, 120).join('') : threadNameRaw;

  return {
    topic: searchTopic,
    threadName,
    contextSources,
    personHint,
    originalText,
  };
}

/**
 * Search Slack via mcporter for messages matching the topic.
 * Returns trimmed mcporter stdout (or null on failure / auth required).
 */
async function gatherSlackContext(topic, { personHint } = {}) {
  const q = personHint ? `${topic} from:@${personHint}` : topic;
  try {
    const result = await mcpCall('slack', 'conversations_search_messages', {
      query: q,
      count: '8',
    });
    return result;
  } catch (err) {
    logger.warn(`[thread-orch] slack search failed: ${err.message}`);
    return null;
  }
}

/**
 * Build the seed system prompt from gathered context blobs.
 * Returns the system message string.
 */
function buildSeedContext(topic, haivemindCtx, slackCtx, contextSources) {
  const parts = [];
  parts.push(`You are being spawned in a fresh Discord thread dedicated to: ${topic}`);
  parts.push('');
  parts.push('This thread starts in PLAN MODE. Review the context below, draft a clear plan of action, and post it to the thread. Do NOT execute any actions yet — wait for the user to approve your plan.');
  parts.push('');

  if (haivemindCtx) {
    parts.push('=== Context from hAIveMind memory ===');
    parts.push(haivemindCtx);
    parts.push('');
  }
  if (slackCtx) {
    parts.push('=== Context from Slack search ===');
    // Grapheme-safe truncation — substring can split emoji surrogate pairs
    // and produce invalid UTF-16 that upstream JSON serializers choke on.
    const chars = [...slackCtx];
    parts.push(chars.length > 4000 ? chars.slice(0, 4000).join('') + '\n…(truncated)' : slackCtx);
    parts.push('');
  }
  if (!haivemindCtx && !slackCtx) {
    parts.push(`(No pre-gathered context was found for "${topic}" in: ${contextSources.join(', ')}. Ask the user for more context if needed before drafting the plan.)`);
    parts.push('');
  }

  parts.push('Format your reply as:');
  parts.push('  **Understanding:** what you think the task is');
  parts.push('  **Plan:** numbered steps');
  parts.push('  **Questions:** anything blocking or ambiguous');
  return parts.join('\n');
}

/**
 * Main orchestration: create thread, seed context, configure plan+verbose, notify parent.
 * @param {import('discord.js').Message} message — the user message that triggered this
 * @param {object} parsed — output of parseOrchestrationCommand
 * @param {object} opts — { gatewayUrl, gatewayToken }
 */
export async function orchestrateThread(message, parsed, opts) {
  const { topic, threadName, contextSources, personHint, originalText } = parsed;
  const { gatewayUrl, gatewayToken } = opts;

  // Dedup: one orchestration per source channel at a time. Prevents STT double-fire
  // or double-tap send from producing two 🧵 threads.
  const dedupKey = message.channel?.id;
  if (dedupKey && _inFlightOrch.has(dedupKey)) {
    logger.info(`[thread-orch] dedup skip — orchestration already in flight for ${dedupKey}`);
    return null;
  }
  if (dedupKey) _inFlightOrch.add(dedupKey);

  try {
  logger.info(`[thread-orch] orchestrating thread "${threadName}" (sources: ${contextSources.join(',')}, person: ${personHint || 'none'})`);

  // 1. Gather context in parallel
  const [haiResult, slackResult] = await Promise.allSettled([
    contextSources.includes('haivemind') ? searchHaivemind(topic) : Promise.resolve(null),
    contextSources.includes('slack')    ? gatherSlackContext(topic, { personHint }) : Promise.resolve(null),
  ]);
  const haivemindCtx = haiResult.status === 'fulfilled' ? haiResult.value : null;
  const slackCtx     = slackResult.status === 'fulfilled' ? slackResult.value : null;

  // 2. Create the thread on the parent channel (resolve parent if we're already in a thread)
  const parentChannel = message.channel?.isThread?.()
    ? (message.channel.parent || message.channel)
    : message.channel;

  // Grapheme-safe name truncation (substring can split emoji surrogate pairs).
  const fullName = `🧵 ${threadName}`;
  const nameChars = [...fullName];
  const safeName = nameChars.length > 100 ? nameChars.slice(0, 100).join('') : fullName;

  let thread;
  try {
    thread = await parentChannel.threads.create({
      name: safeName,
      autoArchiveDuration: 1440, // 24h
      reason: `Thread orchestrator: ${originalText.substring(0, 80)}`,
    });
  } catch (err) {
    logger.error(`[thread-orch] thread.create failed: ${err.message}`);
    try { await message.reply(`Thread creation failed: ${err.message}`); } catch {}
    return null;
  }

  // 3. Default this thread to plan mode + verbose streaming + full MCP (research workspace)
  try { setAskMode(thread.id, true); } catch (err) { logger.warn(`[thread-orch] setAskMode failed: ${err.message}`); }
  try { enableVerboseForThread(thread.id); } catch (err) { logger.warn(`[thread-orch] enableVerbose failed: ${err.message}`); }
  try { setMcpMode(thread.id, 'full'); } catch (err) { logger.warn(`[thread-orch] setMcpMode failed: ${err.message}`); }

  // 4. Build seed + POST to gateway to spawn the Claude session inside the thread
  const systemCtx = buildSeedContext(topic, haivemindCtx, slackCtx, contextSources);
  const channelKey = `agent:main:discord:channel:${parentChannel.id}:thread:${thread.id}`;

  try {
    const resp = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${gatewayToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemCtx },
          { role: 'user',   content: originalText },
        ],
        user: channelKey,
        stream: false,
      }),
      // Timeout so a stalled gateway doesn't hang orchestration indefinitely.
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      logger.warn(`[thread-orch] gateway seed POST returned ${resp.status}`);
    } else {
      // Pull the assistant's reply out of the OpenAI-shaped response and post it to the thread
      try {
        const body = await resp.json();
        const planText = body?.choices?.[0]?.message?.content;
        if (planText && planText.trim()) {
          // Grapheme-safe truncation (substring can split emoji).
          const chars = [...planText];
          const out = chars.length > 1900 ? chars.slice(0, 1900).join('') + '…' : planText;
          await thread.send(out);
        }
      } catch (err) {
        logger.warn(`[thread-orch] gateway response parse failed: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[thread-orch] gateway seed POST failed: ${err.message}`);
    // Thread still exists; the user can just start typing in it
  }

  // 5. Reply in parent channel pointing to the new thread
  const gatheredList = [];
  if (haivemindCtx) gatheredList.push('hivemind');
  if (slackCtx)     gatheredList.push('slack');
  const sourcesStr = gatheredList.length
    ? ` Context from: ${gatheredList.join(', ')}.`
    : ' (no prior context gathered — ask in-thread for more).';

  try {
    await message.reply(`Started ${thread} in plan mode.${sourcesStr}`);
  } catch (err) {
    logger.warn(`[thread-orch] parent reply failed: ${err.message}`);
  }

  return thread;
  } finally {
    if (dedupKey) _inFlightOrch.delete(dedupKey);
  }
}
