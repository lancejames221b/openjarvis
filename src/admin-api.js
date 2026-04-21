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

export function startAdminApi() {
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

      // ── POST /admin/persona ────────────────────────────────────────────
      if (path === '/admin/persona' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.name) return sendJSON(res, 400, { error: 'name required' });
        const r = await switchPersonaFull(body.name);
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
