#!/usr/bin/env node
/**
 * Jarvis Admin UI — tiny static server + data/proxy API.
 * Run: node admin-ui/server.js   (PORT env overrides default 3100)
 *
 * Endpoints:
 *   GET  /                       → index.html
 *   GET  /api/state              → aggregated { users, models, personas, voices, routes, shortcuts, services }
 *   GET  /api/speaker/health     → proxy speaker-verify :8767/health
 *   POST /api/chatterbox/tts     → proxy chatterbox :3340/tts (returns audio/wav)
 */

import http from 'http';
import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = parseInt(process.env.PORT || '3100', 10);

const SERVICES = {
  'speaker-verify': process.env.SPEAKER_VERIFY_URL || 'http://localhost:8767',
  chatterbox: process.env.CHATTERBOX_URL || 'http://localhost:3340',
  piper: process.env.PIPER_URL || 'http://localhost:59125',
  whisper: process.env.WHISPER_URL || 'http://localhost:8765',
  gateway: process.env.JARVIS_GATEWAY_URL || 'http://localhost:31338',
  bot: process.env.JARVIS_ADMIN_URL || 'http://localhost:3101',
};
const ADMIN_TOKEN = process.env.JARVIS_ADMIN_TOKEN || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};

async function readJSON(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function fetchJSON(url, timeoutMs = 1500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probe(url, timeoutMs = 800) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return r.ok ? 'live' : 'idle';
  } catch {
    return 'dead';
  } finally {
    clearTimeout(timer);
  }
}

async function loadPersonas() {
  const dir = join(ROOT, 'personalities');
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
  const active = (await readJSON(join(ROOT, 'data', 'persona-state.json'), {}))?.active;
  const personas = [];
  for (const f of files) {
    const raw = await readFile(join(dir, f), 'utf-8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    const meta = {};
    if (fm) {
      for (const line of fm[1].split('\n')) {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (m) meta[m[1]] = m[2].trim();
      }
    }
    const wake = (meta.wake_words || '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    personas.push({
      name: meta.name || f.replace('.md', ''),
      voice: meta.voice || meta.tts_voice_edge || '—',
      wake,
      active: active && meta.name && active.toLowerCase() === meta.name.toLowerCase(),
    });
  }
  return personas;
}

async function buildState() {
  const speaker = await fetchJSON(`${SERVICES['speaker-verify']}/health`);
  const chatterboxVoices = await fetchJSON(`${SERVICES.chatterbox}/voices`);

  const enrolledIds = speaker?.enrolled_users || [];
  const nameMap = Object.fromEntries(
    (process.env.JARVIS_USER_NAMES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => p.split(':'))
  );
  const ownerId = (process.env.ALLOWED_USERS || '').split(',')[0]?.trim();
  const users = enrolledIds.map((id) => ({
    id,
    name: nameMap[id] || (id === ownerId ? 'Owner' : id.slice(0, 6)),
    refs: speaker?.per_user_refs?.[id] || Math.round((speaker?.total_reference_embeddings || 0) / Math.max(enrolledIds.length, 1)),
    primary: id === ownerId,
  }));

  const channelAccounts = await readJSON(join(ROOT, 'channel-accounts.json'), {});
  const routes = Object.entries(channelAccounts).map(([channel, account]) => ({
    channel: channel.startsWith('#') ? channel : `#${channel}`,
    id: channel,
    account,
  }));

  const shortcutsData = await readJSON(join(ROOT, 'data', 'shortcuts.json'), []);
  const shortcuts = (Array.isArray(shortcutsData) ? shortcutsData : shortcutsData.items || []).map((s) => ({
    phrase: s.phrase || s.trigger || '(untitled)',
    action: s.action || s.command || s.script || '—',
  }));

  const personas = await loadPersonas();

  const [svSt, cbSt, pipSt, whSt, gwSt] = await Promise.all([
    probe(`${SERVICES['speaker-verify']}/health`),
    probe(`${SERVICES.chatterbox}/health`),
    probe(`${SERVICES.piper}/`),
    probe(`${SERVICES.whisper}/health`),
    probe(`${SERVICES.gateway}/health`),
  ]);
  const services = [
    { name: 'speaker-verify', port: 8767, state: svSt, meta: speaker ? `cosine ${speaker.threshold} · ${speaker.total_reference_embeddings} refs` : 'offline' },
    { name: 'whisper-stt', port: 8765, state: whSt, meta: whSt === 'live' ? 'ready' : 'offline' },
    { name: 'piper-tts', port: 59125, state: pipSt, meta: pipSt === 'live' ? 'ready' : 'offline' },
    { name: 'chatterbox-tts', port: 3340, state: cbSt, meta: chatterboxVoices ? `${Object.keys(chatterboxVoices).length} voices` : 'offline' },
    { name: 'jarvis-gateway', port: 31338, state: gwSt, meta: gwSt === 'live' ? 'ready' : 'offline' },
  ];

  const voices = chatterboxVoices?.voices
    ? Object.entries(chatterboxVoices.voices).map(([name, v]) => {
        const ref = v?.reference || '';
        const source = ref ? ref.split('/').pop().replace(/\.(wav|mp3|flac)$/, '') : '—';
        return {
          name,
          source,
          active: name === chatterboxVoices.default,
          available: v?.available !== false,
        };
      })
    : [
        { name: 'jarvis', source: 'Paul Bettany · YT ref', active: true },
        { name: 'owner', source: 'Owner · reference sample' },
        { name: 'snoop', source: 'Doggystyle era' },
        { name: 'c3po', source: 'Anthony Daniels' },
      ];

  const models = {
    voice: process.env.VOICE_MODEL || 'claude-sonnet-4-6',
    text: process.env.TEXT_MODEL || 'claude-sonnet-4-6',
    effort: (process.env.TEXT_MODEL || '').match(/-(low|medium|high|xhigh|max)$/)?.[1] || 'high',
    persona: personas.find((p) => p.active)?.name.toLowerCase() || 'jarvis',
  };

  const activity = [];

  return { users, models, personas, voices, routes, shortcuts, services, activity };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(body);
}
function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });

  // ── SSE passthrough: stream /api/admin/events without buffering ──
  if (path === '/api/admin/events' && req.method === 'GET') {
    try {
      const r = await fetch(`${SERVICES.bot}/admin/events`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      res.writeHead(r.status, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const reader = r.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done || req.destroyed) break;
            res.write(value);
          }
        } catch {}
        res.end();
      };
      pump();
      req.on('close', () => reader.cancel().catch(() => {}));
    } catch (e) {
      sendJSON(res, 502, { error: `SSE proxy failed: ${e.message}` });
    }
    return;
  }

  // ── Admin API proxy: /api/admin/* → bot admin-api with bearer token ──
  if (path.startsWith('/api/admin/')) {
    const botPath = path.replace(/^\/api\/admin/, '/admin') + (url.search || '');
    try {
      const proxyUrl = `${SERVICES.bot}${botPath}`;
      const init = {
        method: req.method,
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': req.headers['content-type'] || 'application/json',
        },
      };
      if (!['GET', 'HEAD', 'DELETE'].includes(req.method)) {
        init.body = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', c => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        });
      }
      const r = await fetch(proxyUrl, init);
      const text = await r.text();
      res.writeHead(r.status, {
        'Content-Type': r.headers.get('content-type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(text);
    } catch (e) {
      sendJSON(res, 502, { error: `bot unreachable: ${e.message}` });
    }
    return;
  }

  if (path === '/api/state') {
    try {
      const state = await buildState();
      return sendJSON(res, 200, state);
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  if (path === '/api/speaker/health') {
    const data = await fetchJSON(`${SERVICES['speaker-verify']}/health`);
    return sendJSON(res, data ? 200 : 502, data || { error: 'offline' });
  }

  if (path === '/api/chatterbox/defaults' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const r = await fetch(`${SERVICES.chatterbox}/voice/defaults`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        const data = await r.json().catch(() => ({}));
        sendJSON(res, r.status, data);
      } catch (e) {
        sendJSON(res, 502, { error: e.message });
      }
    });
    return;
  }

  if (path === '/api/chatterbox/tts' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const r = await fetch(`${SERVICES.chatterbox}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'audio/wav', 'Access-Control-Allow-Origin': '*' });
        res.end(buf);
      } catch (e) {
        sendJSON(res, 502, { error: e.message });
      }
    });
    return;
  }

  if (path === '/api/chatterbox/upload' && req.method === 'POST') {
    try {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        const buf = Buffer.concat(chunks);
        const r = await fetch(`${SERVICES.chatterbox}/voices/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': req.headers['content-type'] || 'multipart/form-data',
            'Content-Length': String(buf.length),
          },
          body: buf,
          signal: AbortSignal.timeout(60_000),
        });
        const data = await r.json().catch(() => ({}));
        sendJSON(res, r.status, data);
      });
      req.on('error', e => sendJSON(res, 502, { error: e.message }));
    } catch (e) {
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // Static files
  let file = path === '/' ? '/index.html' : path;
  const abs = join(__dirname, file);
  if (!abs.startsWith(__dirname)) return send(res, 403, 'Forbidden');
  try {
    const data = await readFile(abs);
    const mime = MIME[extname(abs)] || 'application/octet-stream';
    return send(res, 200, data, { 'Content-Type': mime });
  } catch {
    return send(res, 404, 'Not found');
  }
});

server.listen(PORT, () => {
  console.log(`▸ Jarvis admin UI listening on http://localhost:${PORT}`);
});
