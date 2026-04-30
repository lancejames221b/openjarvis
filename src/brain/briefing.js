/**
 * briefing.js — Alert and handoff briefings on voice join.
 *
 * Extracted from src/index.js. Handles:
 * - briefPendingAlerts: speak queued alerts on voice join
 * - briefPendingHandoffs: speak queued handoffs on voice join
 * - scheduleBriefingOnPause: schedule briefing after current task
 * - generateDynamicGreeting: AI-generated greeting per time of day
 * - getTimeAgo: human-readable time delta
 */

import { unlinkSync } from 'fs';
import { synthesizeSpeech } from '../voice/tts.js';
import { getPendingAlerts, clearAlerts } from '../alert-queue.js';
import { hasPendingHandoffs, getPendingHandoffs, clearHandoffs } from '../alert-webhook.js';
import { markBotResponse } from '../voice/wakeword.js';
import { conversations, briefingState } from '../state/runtime.js';
import logger from '../logger.js';

const GATEWAY_URL = process.env.JARVIS_GATEWAY_URL || 'http://127.0.0.1:22100';
const GATEWAY_TOKEN = process.env.JARVIS_GATEWAY_TOKEN;
const CONVERSATION_HISTORY_MAX = parseInt(process.env.CONVERSATION_HISTORY_MAX ?? '10000');
const CONVERSATION_HISTORY_MAX_CHARS = parseInt(process.env.CONVERSATION_HISTORY_MAX_CHARS ?? String(900000 * 4));

function trimHistory(history) {
  while (history.length > CONVERSATION_HISTORY_MAX) history.shift();
  let charCount = history.reduce((acc, m) => acc + (m.content || '').length, 0);
  while (charCount > CONVERSATION_HISTORY_MAX_CHARS && history.length > 1) {
    const removed = history.shift();
    charCount -= (removed.content || '').length;
  }
}

// ── Time Helper ───────────────────────────────────────────────────────

export function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours > 1 ? 's' : ''} ago`;
}

// ── Alert Briefing ────────────────────────────────────────────────────

export async function briefPendingAlerts(userId, playAudioEnhanced) {
  const alerts = getPendingAlerts();
  if (alerts.length === 0) return;

  let briefing = 'Welcome back. ';
  if (alerts.length === 1) {
    const alert = alerts[0];
    briefing += `${alert.priority === 'urgent' ? 'Urgent alert' : 'Alert'} from ${getTimeAgo(alert.timestamp)}: ${alert.message}. Want the rundown?`;
  } else {
    briefing += `You have ${alerts.length} alerts. `;
    const urgentCount = alerts.filter(a => a.priority === 'urgent').length;
    if (urgentCount > 0) briefing += `${urgentCount} urgent. `;
    briefing += 'Want the briefing?';
  }

  const audio = await synthesizeSpeech(briefing);
  if (audio) { await playAudioEnhanced(audio); try { unlinkSync(audio); } catch {} }
  markBotResponse(userId, { followUpLikely: true });

  if (!conversations.has(userId)) conversations.set(userId, { history: [], lastActive: Date.now() });
  const conv = conversations.get(userId);
  conv.lastActive = Date.now();

  let alertContext = `[SYSTEM] The following alerts were queued while user was away and just briefed via TTS:\n`;
  for (const alert of alerts) {
    alertContext += `- [${alert.priority}] ${getTimeAgo(alert.timestamp)}: ${alert.message}`;
    if (alert.fullDetails) alertContext += ` | Details: ${alert.fullDetails}`;
    if (alert.source) alertContext += ` (source: ${alert.source})`;
    alertContext += '\n';
  }
  alertContext += `User was told: "${briefing}"\nIf they ask for details, provide the full alert information above.`;

  conv.history.push({ role: 'assistant', content: alertContext });
  trimHistory(conv.history);

  clearAlerts();
}

// ── Handoff Briefing ──────────────────────────────────────────────────

export async function briefPendingHandoffs(userId, playAudioEnhanced) {
  const handoffs = getPendingHandoffs();
  if (handoffs.length === 0) return;

  const latestWithChannel = [...handoffs].reverse().find(h => h.channelId);
  if (latestWithChannel) {
    const { setFocusById } = await import('../state/focus-state.js');
    setFocusById(latestWithChannel.channelId, latestWithChannel.channel || null);
    logger.info(`🎯 Voice auto-focused on #${latestWithChannel.channel || latestWithChannel.channelId} from handoff briefing`);
  }

  let briefing = '';
  if (handoffs.length === 1) {
    const h = handoffs[0];
    briefing = `You have a handoff from ${h.channel}. ${h.topic ? h.topic + '. ' : ''}${h.summary.substring(0, 200)}`;
    if (h.instructions) briefing += ` Instructions: ${h.instructions.substring(0, 100)}`;
  } else {
    briefing = `You have ${handoffs.length} handoffs. `;
    for (const h of handoffs) {
      briefing += `From ${h.channel}: ${h.summary.substring(0, 80)}. `;
    }
  }

  const audio = await synthesizeSpeech(briefing);
  if (audio) { await playAudioEnhanced(audio); try { unlinkSync(audio); } catch {} }
  markBotResponse(userId, { followUpLikely: true });

  if (!conversations.has(userId)) conversations.set(userId, { history: [], lastActive: Date.now() });
  const conv = conversations.get(userId);
  conv.lastActive = Date.now();

  let context = `[SYSTEM] Voice handoff context - the following was queued from text channels:\n`;
  for (const h of handoffs) {
    context += `\n--- Handoff from #${h.channel} (${getTimeAgo(h.timestamp)}) ---\n`;
    if (h.topic) context += `Topic: ${h.topic}\n`;
    context += `Summary: ${h.summary}\n`;
    if (h.instructions) context += `Instructions: ${h.instructions}\n`;
  }
  context += `\nUser has been briefed via TTS. Continue from this context.`;

  conv.history.push({ role: 'assistant', content: context });
  trimHistory(conv.history);

  clearHandoffs();
}

// ── Schedule Briefing On Pause ────────────────────────────────────────

export function scheduleBriefingOnPause(userId) {
  briefingState.pendingAlertBriefingForUser = userId;
}

// ── Dynamic Greeting ──────────────────────────────────────────────────

export async function generateDynamicGreeting(voiceName) {
  const now = new Date();
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

  const prompt = `You are ${voiceName}, a British AI butler. Generate ONE short greeting (under 15 words) for ${timeOfDay}. Dry wit welcome. No quotes, just the text.`;

  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GATEWAY_TOKEN}`, 'x-jarvis-scopes': 'operator.write' },
      body: JSON.stringify({
        model: process.env.VOICE_MODEL || 'anthropic-console/claude-sonnet-4-6',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50,
        temperature: 0.9,
      }),
    });
    if (!res.ok) throw new Error(`Gateway ${res.status}`);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content?.trim() || 'Welcome back, sir.').replace(/^["']|["']$/g, '');
  } catch {
    return 'Welcome back, sir.';
  }
}
