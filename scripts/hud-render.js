#!/usr/bin/env node
/**
 * hud-render.js — Terminal HUD renderer for Jarvis Voice
 *
 * Reads data/hud-state.json + polls the bot webhook, renders a
 * full-width ANSI dashboard to stdout. Designed to run inside
 * `watch -n 2 -t` inside a tmux pane.
 *
 * Usage: node scripts/hud-render.js
 * In tmux: watch -n 2 -t node ~/jarvis-voice/scripts/hud-render.js
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATE_FILE = join(ROOT, 'data', 'hud-state.json');
const BOX_FILE   = join(ROOT, 'data', 'box-state.json');
const WEBHOOK = process.env.JARVIS_WEBHOOK_URL || 'http://TAILSCALE_HOST:3335';

// ── ANSI helpers ──────────────────────────────────────────────────────
const R = '\x1b[0m';
const B = '\x1b[1m';
const DIM = '\x1b[2m';
const C = {
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  magenta: '\x1b[35m',
  red:     '\x1b[31m',
  white:   '\x1b[97m',
  grey:    '\x1b[90m',
  bgBlue:  '\x1b[44m',
  bgDark:  '\x1b[48;5;234m',
};

const cols = process.stdout.columns || 100;

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str.slice(0, n) : str + ' '.repeat(n - str.length);
}
function rpad(s, n) {
  const str = String(s);
  return str.length >= n ? str.slice(0, n) : ' '.repeat(n - str.length) + str;
}
function line(char = '─', color = C.grey) {
  return color + char.repeat(cols) + R;
}
function box(label, content, color = C.cyan) {
  return `${color}${B}${label}${R}  ${content}`;
}

function elapsed(ms) {
  if (ms < 0) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Data loading ──────────────────────────────────────────────────────

function loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return {};
}

function loadBoxState() {
  try {
    if (existsSync(BOX_FILE)) return JSON.parse(readFileSync(BOX_FILE, 'utf8'));
  } catch {}
  return null;
}

async function fetchHealth() {
  try {
    const res = await fetch(`${WEBHOOK}/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

async function fetchContext() {
  try {
    const res = await fetch(`${WEBHOOK}/context/active`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

// ── Render ────────────────────────────────────────────────────────────

async function render() {
  const state = loadState();
  const boxState = loadBoxState();
  const [health, context] = await Promise.all([fetchHealth(), fetchContext()]);

  const now = Date.now();
  const updatedAt = state.updatedAt ? new Date(state.updatedAt).getTime() : 0;
  const stateAge = updatedAt ? elapsed(now - updatedAt) : '?';

  const botState = health?.fsm?.state || health?.state || context?.botState || '?';
  const uptime   = health?.uptimeHuman || (health?.uptime ? elapsed(health.uptime * 1000) : '?');
  const focus    = health?.focus || context?.focus || '—';
  const output   = health?.visualMode ? `Visual → ${health.visualChannel || '?'}` : 'Voice';
  const boxName  = boxState?.activeBox || health?.activeBox || '—';
  const boxCwd   = boxState?.cwd || '~';
  const boxSsh   = boxState?.ssh || null;
  const tasks    = health?.tasks?.ledger || {};

  const last = state.lastCompletedTask;
  const lastAgo  = last?.completedAt ? elapsed(now - last.completedAt) : null;
  const lastText = last?.transcript ? last.transcript.slice(0, cols - 30) : null;

  const stateColor = botState === 'ACTIVE' || botState === 'LISTENING' ? C.green
    : botState === 'SLEEP' ? C.grey
    : C.yellow;

  const lines = [];

  // Header
  lines.push('');
  lines.push(
    `${C.bgBlue}${B}${C.white}  🎙️  JARVIS VOICE HUD  ${R}` +
    `${C.grey}  ${new Date().toLocaleTimeString('en-US', { hour12: false })}  ${R}`
  );
  lines.push(line('═', C.cyan));

  // State row
  const stateStr = `${stateColor}${B}${pad(botState, 12)}${R}`;
  const uptimeStr = `${C.white}${uptime}${R}`;
  const focusStr  = `${C.cyan}#${focus}${R}`;
  const outputStr = `${C.magenta}${output}${R}`;
  const sessionStr = tasks.total
    ? `${C.green}${tasks.completed || 0}✓${R}  ${C.red}${tasks.failed || 0}✗${R}  ${C.grey}/ ${tasks.total}${R}`
    : `${C.grey}—${R}`;

  lines.push(
    `  ${box('STATE', stateStr)}    ` +
    `${box('UPTIME', uptimeStr)}    ` +
    `${box('FOCUS', focusStr)}    ` +
    `${box('OUTPUT', outputStr)}    ` +
    `${box('SESSION', sessionStr, C.grey)}`
  );
  lines.push('');

  // Active box / shell context
  if (boxName && boxName !== '—') {
    const sshLabel = boxSsh ? `  ${C.grey}(${boxSsh})${R}` : `  ${C.grey}(local)${R}`;
    const cwdLabel = `  ${DIM}${boxCwd}${R}`;
    lines.push(`  ${box('BOX', `${C.yellow}${B}${boxName}${R}${sshLabel}${cwdLabel}`, C.grey)}`);
  }

  lines.push(line());

  // Current task
  const curTask = context?.currentTask || health?.currentTask;
  if (curTask) {
    const taskElapsed = curTask.startedAt ? elapsed(now - new Date(curTask.startedAt).getTime()) : '?';
    lines.push(`  ${C.green}${B}⚡ ACTIVE TASK${R}`);
    lines.push(`     ${C.white}${B}#${curTask.taskId}${R}  ${curTask.transcript || '(in progress)'}`);
    lines.push(`     ${DIM}${curTask.state} — ${taskElapsed}${R}`);
  } else {
    lines.push(`  ${C.grey}⚡ No active task${R}`);
  }

  lines.push('');

  // Last completed
  if (last) {
    const icon = last.state === 'failed' ? `${C.red}✗${R}` : `${C.green}✓${R}`;
    lines.push(`  ${icon} ${B}LAST${R}  ${C.grey}#${last.taskId}${R}  ${C.white}${lastText || '—'}${R}  ${DIM}${lastAgo} ago${R}`);
  }

  lines.push('');
  lines.push(line());

  // Footer
  const stateFileAge = updatedAt ? `state: ${stateAge} ago` : 'state: no data';
  const healthStatus = health ? `${C.green}webhook ✓${R}` : `${C.red}webhook ✗${R}`;
  lines.push(`  ${C.grey}${stateFileAge}  │  ${R}${healthStatus}${C.grey}  │  hud-state.json${R}`);
  lines.push('');

  process.stdout.write(lines.join('\n') + '\n');
}

render().catch(err => {
  process.stdout.write(`\x1b[31mRender error: ${err.message}\x1b[0m\n`);
});
