/**
 * admin-api.js — small HTTP admin surface for the dashboard.
 *
 * Starts only when JARVIS_ADMIN_TOKEN is set. Binds to JARVIS_ADMIN_BIND
 * (default 0.0.0.0) on JARVIS_ADMIN_PORT (default 3101). All routes require
 * Authorization: Bearer ${JARVIS_ADMIN_TOKEN}.
 *
 * Intended to be reached over Tailscale from the admin UI server on another
 * host. One shared secret; household-scale auth, not SaaS.
 */

import http from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, createReadStream } from 'fs';
import { unlink, mkdir, readdir } from 'fs/promises';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execCb);
import logger from './logger.js';
import {
  getActivePersona,
  switchPersonaFull,
  listPersonalities,
  getVoiceModel,
  setVoiceModel,
  getTextModel,
  setTextModel,
} from './brain.js';
import {
  listVoiceShortcuts,
  addVoiceShortcut,
  updateVoiceShortcut,
  deleteVoiceShortcut,
} from './shortcut-engine.js';
import { enrollmentState } from './auth.js';
import { getAllowedUsers, addMember, removeMember } from './allowed-users.js';
import { emit as busEmit, getRingBuffer, subscribe } from './event-bus.js';
import { listSchedules, createSchedule, deleteSchedule, pauseSchedule, resumeSchedule } from './task-scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const STATE_DIR = `${homedir()}/.local/state/jarvis-voice`;
const ACCOUNTS_PATH = process.env.CHANNEL_ACCOUNTS_PATH || `${STATE_DIR}/channel-accounts.json`;
const PERSONALITIES_DIR = join(ROOT, 'personalities');

function readAccounts() {
  try {
    return JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf8'));
  } catch {
    return { profiles: { default: { configDir: null, label: 'primary' } }, channels: {} };
  }
}

function writeAccounts(data) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2) + '\n');
}

function effortFromModel(m) {
  const match = String(m || '').match(/-(low|medium|high|xhigh|max)$/);
  return match ? match[1] : null;
}

function personasSnapshot() {
  const active = getActivePersona();
  const activeLower = (active?.name || '').toLowerCase();
  const files = existsSync(PERSONALITIES_DIR)
    ? readdirSync(PERSONALITIES_DIR).filter(f => f.endsWith('.md'))
    : [];
  return files.map(f => {
    const raw = readFileSync(join(PERSONALITIES_DIR, f), 'utf8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    const meta = {};
    if (fm) {
      for (const line of fm[1].split('\n')) {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (m) meta[m[1]] = m[2].trim();
      }
    }
    const wake = (meta.wake_words || '')
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    return {
      name: meta.name || f.replace('.md', ''),
      voice: meta.voice || meta.tts_voice_edge || '—',
      wake,
      active: (meta.name || '').toLowerCase() === activeLower,
    };
  });
}

function stateSnapshot() {
  const accounts = readAccounts();
  const routes = Object.entries(accounts.channels || {}).map(([channel, account]) => ({
    channel,
    account,
  }));
  const profiles = Object.entries(accounts.profiles || {}).map(([name, p]) => ({
    name,
    label: p.label,
    configDir: p.configDir,
  }));
  const voice = getVoiceModel();
  const text = getTextModel();
  return {
    persona: getActivePersona()?.name || null,
    personas: personasSnapshot(),
    models: {
      voice,
      text,
      effort: effortFromModel(text) || 'high',
    },
    shortcuts: listVoiceShortcuts(),
    routing: { profiles, routes },
    enrollment: {
      active: enrollmentState.active,
      learnMode: enrollmentState.learnMode,
      userId: enrollmentState.userId,
      clipsCollected: enrollmentState.clipsCollected,
      clipsNeeded: enrollmentState.clipsNeeded,
      currentPrompt: enrollmentState.currentPrompt?.(),
    },
  };
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let buf = '';
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      buf += chunk;
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    ...headers,
  });
  res.end(body);
}
function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });
}

function authOk(req, token) {
  const h = req.headers['authorization'] || '';
  return h === `Bearer ${token}`;
}

export function startAdminApi({ discordClient } = {}) {
  const token = process.env.JARVIS_ADMIN_TOKEN;
  if (!token) {
    logger.info('[admin-api] JARVIS_ADMIN_TOKEN not set — admin API disabled');
    return null;
  }
  const port = parseInt(process.env.JARVIS_ADMIN_PORT || '3101', 10);
  const bind = process.env.JARVIS_ADMIN_BIND || '0.0.0.0';

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, '');

    if (!authOk(req, token)) return sendJSON(res, 401, { error: 'unauthorized' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    try {
      // ── GET /admin/state ───────────────────────────────────────────────
      if (path === '/admin/state' && req.method === 'GET') {
        return sendJSON(res, 200, stateSnapshot());
      }

      // ── POST /admin/handoff/from-terminal ──────────────────────────────
      // Called by the local `handoff --to-discord` script after it rsyncs
      // its .jsonl up. Creates a new thread in the target channel, binds the
      // chatId to that thread's channelKey (via gateway session-inject), marks
      // the thread verbose, and posts a seed breadcrumb.
      // Body: { channelId, chatId, directory?, model?, topic?, origin? }
      if (path === '/admin/handoff/from-terminal' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.channelId || !body.chatId) {
          return sendJSON(res, 400, { error: 'channelId and chatId required' });
        }
        if (!discordClient) return sendJSON(res, 503, { error: 'discord client not available' });
        try {
          const ch = await discordClient.channels.fetch(body.channelId);
          if (!ch || !ch.threads?.create) {
            return sendJSON(res, 400, { error: 'target channel does not support threads' });
          }
          const topic = (body.topic || `Resumed from terminal (${body.origin || 'gamez'})`).slice(0, 90);
          const thread = await ch.threads.create({
            name: `🔗 ${topic}`,
            autoArchiveDuration: 10080,
          });
          const channelKey = `agent:main:discord:channel:${body.channelId}:thread:${thread.id}`;

          // Tell the gateway: "this chatId now belongs to that thread"
          const gwUrl = process.env.JARVIS_GATEWAY_URL || 'http://127.0.0.1:22100';
          const gwToken = process.env.JARVIS_GATEWAY_TOKEN || '';
          const injectRes = await fetch(`${gwUrl}/v1/sessions/inject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gwToken}` },
            body: JSON.stringify({ channelKey, chatId: body.chatId }),
          });
          if (!injectRes.ok) {
            logger.warn(`[admin-api] session inject failed: HTTP ${injectRes.status}`);
          }

          // Mark this thread verbose by default.
          try {
            const vm = await import('./verbose-mode.js');
            vm.enableVerboseForThread(thread.id);
          } catch (e) {
            logger.warn(`[admin-api] enableVerboseForThread failed: ${e.message}`);
          }

          // Pin a per-thread model override so the next @mention in this thread
          // uses the model the user handed off with (e.g., opus for long sessions)
          // instead of the global default.
          if (body.model) {
            try {
              const cm = await import('./channel-models.js');
              // Pin for the thread AND the parent channel — belt and suspenders
              cm.setChannelModel(thread.id, body.model);
              cm.setChannelModel(body.channelId, body.model);
            } catch (e) {
              logger.warn(`[admin-api] setChannelModel failed: ${e.message}`);
            }
          }

          // Post seed breadcrumb in the thread.
          const seed = [
            `🔗 **Continuing from terminal.**`,
            body.directory ? `**Dir:** \`${body.directory}\`` : null,
            body.model ? `**Model:** \`${body.model}\`` : null,
            `**Session:** \`${body.chatId}\``,
            '',
            `@mention me here to pick up. Verbose mode is **on** for this thread.`,
          ].filter(Boolean).join('\n');
          await thread.send(seed).catch(() => {});

          return sendJSON(res, 200, { ok: true, threadId: thread.id, channelKey });
        } catch (err) {
          logger.warn(`[admin-api] handoff from-terminal failed: ${err.message}`);
          return sendJSON(res, 500, { error: err.message });
        }
      }

      // ── POST /admin/handoff/rotation ───────────────────────────────────
      // Called by jarvis-gateway when a channel's chatId rotates.
      // Body: { channelId, newChatId, oldChatId?, model?, directory? }
      if (path === '/admin/handoff/rotation' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.channelId || !body.newChatId) {
          return sendJSON(res, 400, { error: 'channelId and newChatId required' });
        }
        if (!discordClient) return sendJSON(res, 503, { error: 'discord client not available' });
        try {
          const { handleRotation } = await import('./handoff-thread.js');
          await handleRotation(discordClient, body);
          return sendJSON(res, 200, { ok: true });
        } catch (err) {
          logger.warn(`[admin-api] handoff rotation failed: ${err.message}`);
          return sendJSON(res, 500, { error: err.message });
        }
      }

      // ── POST /admin/persona ────────────────────────────────────────────
      if (path === '/admin/persona' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.name) return sendJSON(res, 400, { error: 'name required' });
        const prev = getActivePersona()?.name || '—';
        const r = await switchPersonaFull(body.name);
        busEmit('PERSONA', `${prev} → ${body.name}`);
        return sendJSON(res, 200, { ok: true, ...r });
      }

      // ── POST /admin/models ─────────────────────────────────────────────
      if (path === '/admin/models' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const applied = {};
        if (body.voice) {
          setVoiceModel(body.voice);
          applied.voice = body.voice;
        }
        if (body.text) {
          setTextModel(body.text);
          applied.text = body.text;
        }
        if (body.effort) {
          // Set effort by rewriting text model suffix
          const base = (getTextModel() || '').replace(/-(low|medium|high|xhigh|max)$/, '');
          const next = `${base}-${body.effort}`;
          setTextModel(next);
          applied.text = next;
          applied.effort = body.effort;
        }
        if (Object.keys(applied).length) {
          busEmit('MODEL', Object.entries(applied).map(([k, v]) => `${k}=${v}`).join(' '));
        }
        return sendJSON(res, 200, {
          ok: true,
          applied,
          voice: getVoiceModel(),
          text: getTextModel(),
          effort: effortFromModel(getTextModel()),
        });
      }

      // ── Shortcuts ──────────────────────────────────────────────────────
      if (path === '/admin/shortcuts' && req.method === 'GET') {
        return sendJSON(res, 200, { shortcuts: listVoiceShortcuts() });
      }
      if (path === '/admin/shortcuts' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.trigger || !body.actionType) {
          return sendJSON(res, 400, { error: 'trigger and actionType required' });
        }
        const r = addVoiceShortcut(body.trigger, body.actionType, body.actionData || {});
        return sendJSON(res, r.ok ? 200 : 400, r);
      }
      const scMatch = path.match(/^\/admin\/shortcuts\/([^\/]+)$/);
      if (scMatch) {
        const id = scMatch[1];
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req);
          const r = updateVoiceShortcut(id, body);
          return sendJSON(res, r.ok ? 200 : 404, r);
        }
        if (req.method === 'DELETE') {
          const r = deleteVoiceShortcut(id);
          return sendJSON(res, r.ok ? 200 : 404, r);
        }
      }

      // ── Routing ────────────────────────────────────────────────────────
      if (path === '/admin/routing' && req.method === 'GET') {
        const a = readAccounts();
        return sendJSON(res, 200, {
          profiles: a.profiles || {},
          channels: a.channels || {},
        });
      }
      if (path === '/admin/routing' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.channel || !body.account) {
          return sendJSON(res, 400, { error: 'channel and account required' });
        }
        const a = readAccounts();
        if (!a.profiles || !a.profiles[body.account]) {
          return sendJSON(res, 400, { error: `unknown profile: ${body.account}` });
        }
        a.channels = a.channels || {};
        a.channels[body.channel] = body.account;
        writeAccounts(a);
        logger.info(`[admin-api] routing: ${body.channel} → ${body.account}`);
        return sendJSON(res, 200, { ok: true, channel: body.channel, account: body.account });
      }
      const rtMatch = path.match(/^\/admin\/routing\/(.+)$/);
      if (rtMatch && req.method === 'DELETE') {
        const ch = decodeURIComponent(rtMatch[1]);
        const a = readAccounts();
        if (a.channels && a.channels[ch]) {
          delete a.channels[ch];
          writeAccounts(a);
          logger.info(`[admin-api] routing: unmapped ${ch}`);
          return sendJSON(res, 200, { ok: true });
        }
        return sendJSON(res, 404, { error: 'not_found' });
      }

      // ── Members ───────────────────────────────────────────────────────
      if (path === '/admin/members' && req.method === 'GET') {
        return sendJSON(res, 200, { members: getAllowedUsers() });
      }
      if (path === '/admin/members' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.userId || !body.name) return sendJSON(res, 400, { error: 'userId and name required' });
        const r = addMember(body.userId, body.name);
        return sendJSON(res, r.ok ? 200 : 400, r);
      }
      const mbMatch = path.match(/^\/admin\/members\/([^\/]+)$/);
      if (mbMatch && req.method === 'DELETE') {
        const userId = decodeURIComponent(mbMatch[1]);
        const r = removeMember(userId);
        if (!r.ok) return sendJSON(res, r.reason === 'not_found' ? 404 : 400, r);
        // Best-effort: delete voiceprint from speaker-verify service
        const svUrl = process.env.SPEAKER_VERIFY_URL || 'http://localhost:8767';
        try {
          await fetch(`${svUrl}/voiceprint/${encodeURIComponent(userId)}`, {
            method: 'DELETE', signal: AbortSignal.timeout(5_000),
          });
        } catch (e) {
          logger.warn(`[admin-api] speaker-verify delete failed (member removed anyway): ${e.message}`);
        }
        logger.info(`[admin-api] member removed: ${userId}`);
        return sendJSON(res, 200, { ok: true, userId });
      }

      // ── Enrollment ─────────────────────────────────────────────────────
      if (path === '/admin/enroll/start' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.userId) return sendJSON(res, 400, { error: 'userId required' });
        enrollmentState.start(body.userId, !!body.learn);
        logger.info(`[admin-api] enrollment started: user=${body.userId} learn=${!!body.learn}`);
        return sendJSON(res, 200, {
          ok: true,
          userId: body.userId,
          learn: !!body.learn,
          currentPrompt: enrollmentState.currentPrompt?.(),
        });
      }
      if (path === '/admin/enroll/cancel' && req.method === 'POST') {
        enrollmentState.cancel();
        return sendJSON(res, 200, { ok: true });
      }
      if (path === '/admin/enroll' && req.method === 'GET') {
        return sendJSON(res, 200, {
          active: enrollmentState.active,
          learnMode: enrollmentState.learnMode,
          userId: enrollmentState.userId,
          clipsCollected: enrollmentState.clipsCollected,
          clipsNeeded: enrollmentState.clipsNeeded,
          currentPrompt: enrollmentState.currentPrompt?.(),
        });
      }

      // ── Chatterbox: clone from YouTube ────────────────────────────────
      if (path === '/admin/chatterbox/clone-from-youtube' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const { url, name, make_default = false } = body;
        if (!url || !name) return sendJSON(res, 400, { error: 'url and name required' });
        if (!/^[a-z0-9_-]+$/.test(name)) return sendJSON(res, 400, { error: 'name must be lowercase alphanumeric/underscore/dash' });

        const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
        const tmpId = `jarvis-yt-${name}-${Date.now()}`;
        const tmpBase = join(tmpdir(), tmpId);
        const tmpTemplate = `${tmpBase}.%(ext)s`;

        logger.info(`[admin-api] yt clone: ${name} ← ${url}`);
        try {
          await exec(`"${ytdlp}" -x --audio-format wav --audio-quality 0 --no-playlist -o "${tmpTemplate}" "${url}"`, { timeout: 180_000 });
        } catch (e) {
          return sendJSON(res, 500, { error: `yt-dlp failed: ${e.message.slice(0, 200)}` });
        }

        // Find the file yt-dlp created (tmpBase.{wav|webm|...})
        const tmpFiles = (await readdir(tmpdir())).filter(f => f.startsWith(tmpId));
        if (!tmpFiles.length) return sendJSON(res, 500, { error: 'downloaded file not found' });
        const downloaded = join(tmpdir(), tmpFiles[0]);

        // Convert/trim to 15s 22kHz mono WAV
        const cloneDir = join(homedir(), 'dev', 'voice-clones', name);
        mkdirSync(cloneDir, { recursive: true });
        const refPath = join(cloneDir, `${name}_reference_15s.wav`);
        try {
          await exec(`ffmpeg -y -i "${downloaded}" -t 15 -ar 22050 -ac 1 -acodec pcm_s16le "${refPath}"`, { timeout: 60_000 });
        } catch (e) {
          await unlink(downloaded).catch(() => {});
          return sendJSON(res, 500, { error: `ffmpeg failed: ${e.message.slice(0, 200)}` });
        }
        await unlink(downloaded).catch(() => {});

        // Upload to chatterbox service for hot-reload
        const chatterboxUrl = process.env.CHATTERBOX_URL || 'http://localhost:3340';
        try {
          const fileStream = createReadStream(refPath);
          const boundary = `boundary${Date.now()}`;
          const nameField = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`);
          const makeDefaultField = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="make_default"\r\n\r\n${make_default}\r\n`);
          const fileHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${name}_reference_15s.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
          const fileEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
          const fileData = readFileSync(refPath);
          const multipart = Buffer.concat([nameField, makeDefaultField, fileHeader, fileData, fileEnd]);

          const cbRes = await fetch(`${chatterboxUrl}/voices/upload`, {
            method: 'POST',
            headers: {
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': String(multipart.length),
            },
            body: multipart,
            signal: AbortSignal.timeout(30_000),
          });
          const cbData = await cbRes.json().catch(() => ({}));
          logger.info(`[admin-api] chatterbox upload response: ${JSON.stringify(cbData)}`);
        } catch (e) {
          logger.warn(`[admin-api] chatterbox upload failed (voice saved to disk): ${e.message}`);
        }

        logger.info(`[admin-api] yt clone complete: ${name} → ${refPath}`);
        return sendJSON(res, 200, { ok: true, name, path: refPath, make_default });
      }

      // ── Activity SSE ──────────────────────────────────────────────────
      if (path === '/admin/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        const write = (ev) => {
          try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {}
        };
        // Flush backlog (newest 80) so the panel paints on connect
        const backlog = getRingBuffer().slice(-80);
        backlog.forEach(write);

        const unsub = subscribe(write);
        const hb = setInterval(() => {
          try { res.write(': heartbeat\n\n'); } catch {}
        }, 30_000);
        req.on('close', () => { unsub(); clearInterval(hb); });
        return;
      }

      // ── Schedules ──────────────────────────────────────────────────────
      if (path === '/admin/schedules' && req.method === 'GET') {
        return sendJSON(res, 200, { schedules: listSchedules() });
      }
      if (path === '/admin/schedules' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.prompt || !body.intervalMs || !body.channelId) {
          return sendJSON(res, 400, { error: 'prompt, intervalMs, and channelId required' });
        }
        const s = createSchedule({
          prompt: body.prompt,
          intervalMs: body.intervalMs,
          channelId: body.channelId,
          userId: body.userId || 'admin',
          terminationPhrase: body.terminationPhrase || null,
          maxRuns: body.maxRuns || 0,
        });
        return sendJSON(res, 200, { ok: true, schedule: s });
      }
      const schedMatch = path.match(/^\/admin\/schedules\/([^\/]+)$/);
      if (schedMatch) {
        const id = decodeURIComponent(schedMatch[1]);
        if (req.method === 'DELETE') {
          deleteSchedule(id);
          return sendJSON(res, 200, { ok: true });
        }
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req);
          if (body.enabled === false) pauseSchedule(id);
          else if (body.enabled === true) resumeSchedule(id);
          if (body.intervalMs) {
            const s = listSchedules().find(s => s.id === id);
            if (s) { s.intervalMs = body.intervalMs; }
          }
          return sendJSON(res, 200, { ok: true });
        }
      }

      // ── Fallback ───────────────────────────────────────────────────────
      return sendJSON(res, 404, { error: 'not_found', path });
    } catch (err) {
      logger.warn(`[admin-api] ${err.message}`);
      return sendJSON(res, 500, { error: err.message });
    }
  });

  server.listen(port, bind, () => {
    logger.info(`[admin-api] listening on http://${bind}:${port} (token auth)`);
  });

  return server;
}
