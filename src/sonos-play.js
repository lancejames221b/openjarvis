/**
 * Sonos Play — route the already-generated TTS wav to a Sonos speaker via UPnP.
 *
 * Session-scoped wav naming: each wav is written to
 *   /tmp/jarvis-sonos/by-channel/<channelId>/<threadId>/<ISO-ts>-<taskId>-<role>.wav
 * so every Sonos URL is unique (no URL-level caching), and per-channel traceability
 * survives service restarts. A rolling manifest at /tmp/jarvis-sonos/latest-manifest.json
 * records the most-recent wav per channel.
 *
 * Every Play is preceded by Stop + RemoveAllTracksFromQueue to prevent a prior
 * radio stream or queue from resuming after our announcement ends.
 *
 * playWavOnSonos() awaits real playback completion by polling
 * GetTransportInfo for STOPPED state — not an estimated duration — so the
 * downstream post-speak attention window starts at real wav end.
 */

import { existsSync, copyFileSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { basename, join } from 'path';
import logger from './logger.js';

// ── Config ────────────────────────────────────────────────────────────

const BEDROOM_IP = process.env.SONOS_BEDROOM_IP || 'SONOS_BEDROOM_IP';
const KITCHEN_IP = process.env.SONOS_KITCHEN_IP || 'SONOS_KITCHEN_IP';
const LAN_HOST   = process.env.JARVIS_LAN_HOST  || 'JARVIS_LAN_HOST';
const HTTP_PORT  = parseInt(process.env.SONOS_HTTP_PORT || '8768');
const SERVE_DIR  = '/tmp/jarvis-sonos';
const MANIFEST   = join(SERVE_DIR, 'latest-manifest.json');
const PURGE_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// ── HTTP server (idempotent) ──────────────────────────────────────────

// Resolves when the python3 http.server has actually bound to HTTP_PORT.
// Before: _httpStarted was set synchronously before spawn returned, so the
// first playWavOnSonos after boot could call setTransportUri against an
// unbound port → Sonos silently failed to fetch the wav.
let _httpReadyPromise = null;

export function startHttpServer() {
  if (_httpReadyPromise) return _httpReadyPromise;
  try { mkdirSync(SERVE_DIR, { recursive: true }); } catch {}
  _httpReadyPromise = (async () => {
    const { spawn } = await import('child_process');
    const child = spawn('python3', ['-m', 'http.server', String(HTTP_PORT), '--bind', '0.0.0.0', '--directory', SERVE_DIR], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    // TCP readiness probe — retry up to 10× at 100 ms.
    const { createConnection } = await import('net');
    for (let i = 0; i < 20; i++) {
      const ok = await new Promise((resolve) => {
        const sock = createConnection({ host: '127.0.0.1', port: HTTP_PORT }, () => {
          sock.end();
          resolve(true);
        });
        sock.on('error', () => resolve(false));
        sock.setTimeout(200, () => { sock.destroy(); resolve(false); });
      });
      if (ok) break;
      await new Promise(r => setTimeout(r, 100));
    }
    logger.info(`[sonos-play] HTTP server ready on 0.0.0.0:${HTTP_PORT} serving ${SERVE_DIR}`);
    purgeOldWavs();
  })();
  return _httpReadyPromise;
}

// ── Manifest ──────────────────────────────────────────────────────────

function readManifest() {
  try { return JSON.parse(readFileSync(MANIFEST, 'utf8')); } catch { return {}; }
}

function writeManifest(m) {
  try { writeFileSync(MANIFEST, JSON.stringify(m, null, 2)); } catch (err) {
    logger.warn(`[sonos-play] manifest write failed: ${err.message}`);
  }
}

function updateManifest(key, entry) {
  const m = readManifest();
  m[key] = entry;
  writeManifest(m);
}

// ── Purge ─────────────────────────────────────────────────────────────

function purgeOldWavs() {
  const root = join(SERVE_DIR, 'by-channel');
  if (!existsSync(root)) return;
  const cutoff = Date.now() - PURGE_AGE_MS;
  let purged = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try {
        if (statSync(p).mtimeMs < cutoff) {
          unlinkSync(p);
          purged++;
        }
      } catch {}
    }
  };
  walk(root);
  if (purged > 0) logger.info(`[sonos-play] purged ${purged} wav(s) older than 24h`);
}

// ── UPnP (SOAP over HTTP) ─────────────────────────────────────────────

async function soapPost(ip, service, action, body) {
  const url = `http://${ip}:1400/MediaRenderer/${service}/Control`;
  const soapAction = `"urn:schemas-upnp-org:service:${service}:1#${action}"`;
  const envelope =
    `<?xml version="1.0"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body>${body}</s:Body></s:Envelope>`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', 'SOAPAction': soapAction },
    body: envelope,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`SOAP ${action} → HTTP ${res.status}`);
  return res.text();
}

async function stopTransport(ip) {
  const body = `<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:Stop>`;
  try { await soapPost(ip, 'AVTransport', 'Stop', body); } catch {}
}

async function removeAllTracks(ip) {
  const body = `<u:RemoveAllTracksFromQueue xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:RemoveAllTracksFromQueue>`;
  try { await soapPost(ip, 'AVTransport', 'RemoveAllTracksFromQueue', body); } catch {}
}

async function setTransportUri(ip, mediaUrl) {
  const body =
    `<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">` +
    `<InstanceID>0</InstanceID>` +
    `<CurrentURI>${mediaUrl}</CurrentURI>` +
    `<CurrentURIMetaData></CurrentURIMetaData>` +
    `</u:SetAVTransportURI>`;
  await soapPost(ip, 'AVTransport', 'SetAVTransportURI', body);
}

async function play(ip) {
  const body =
    `<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">` +
    `<InstanceID>0</InstanceID><Speed>1</Speed>` +
    `</u:Play>`;
  await soapPost(ip, 'AVTransport', 'Play', body);
}

async function getTransportState(ip) {
  const body = `<u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetTransportInfo>`;
  const resp = await soapPost(ip, 'AVTransport', 'GetTransportInfo', body);
  const match = resp.match(/<CurrentTransportState>([^<]+)<\/CurrentTransportState>/);
  return match ? match[1] : 'UNKNOWN';
}

/**
 * Poll the Sonos transport state until it reaches STOPPED (or timeout).
 *
 * Two-phase: first wait for the transport to ENTER a playing-ish state
 * (PLAYING or TRANSITIONING), with a 3 s cap. Then wait for STOPPED.
 *
 * Before this fix, if Sonos was already STOPPED when we called (common when it
 * had been idle before we issued Stop/SetURI/Play), the first poll matched
 * STOPPED and we returned at ~600 ms — before real playback even started.
 * Downstream attention-window logic then opened the mic mid-sentence.
 */
async function waitForTransportStopped(ip, maxMs = 45000) {
  const start = Date.now();
  // Phase 1: wait for playback to actually start (PLAYING or TRANSITIONING).
  // Cap at 3 s — if we don't see it start by then, assume Sonos refused the
  // request silently and fall through; the old-style STOPPED poll still works.
  const phase1Cap = Math.min(3000, maxMs);
  let playbackConfirmed = false;
  while (Date.now() - start < phase1Cap) {
    try {
      const state = await getTransportState(ip);
      if (state === 'PLAYING' || state === 'TRANSITIONING') {
        playbackConfirmed = true;
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  if (!playbackConfirmed) {
    logger.warn(`[sonos-play] ${ip} never entered PLAYING/TRANSITIONING within ${phase1Cap}ms`);
  }
  // Phase 2: wait for STOPPED/PAUSED/NO_MEDIA (playback end).
  while (Date.now() - start < maxMs) {
    try {
      const state = await getTransportState(ip);
      if (state === 'STOPPED' || state === 'PAUSED_PLAYBACK' || state === 'NO_MEDIA_PRESENT') {
        return { state, waitedMs: Date.now() - start };
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return { state: 'TIMEOUT', waitedMs: Date.now() - start };
}

// ── Path helpers ──────────────────────────────────────────────────────

function isoForFilename(d = new Date()) {
  // 2026-04-23T07-42-15-123 (colon-free so it's filesystem-safe)
  return d.toISOString().replace(/[:.]/g, '-');
}

function safeSegment(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'unknown';
}

function buildServedPath(ctx) {
  const channelId = safeSegment(ctx?.channelId ?? 'system');
  const threadId  = safeSegment(ctx?.threadId  ?? 'main');
  const taskId    = safeSegment(ctx?.taskId    ?? 'ack');
  const role      = safeSegment(ctx?.role      ?? 'response');
  // Random suffix prevents collisions when two calls share the same ms.
  // Previously `${iso}-task${taskId}-${role}.wav` could collide for two
  // simultaneous ack-role flows with taskId='ack' — the second's copyFileSync
  // overwrote the first while Python was still streaming it to Sonos.
  const rand = Math.random().toString(36).slice(2, 8);
  const name = `${isoForFilename()}-task${taskId}-${role}-${rand}.wav`;
  const dir  = join(SERVE_DIR, 'by-channel', channelId, threadId);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return { dir, name, relative: `by-channel/${channelId}/${threadId}/${name}` };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Play an existing wav file on a Sonos speaker. Awaits real playback completion.
 *
 * @param {string} audioPath - absolute path to a wav/mp3 openjarvis already generated
 * @param {'up'|'down'|'all'} target
 * @param {{channelId?: string, threadId?: string, taskId?: string|number, role?: string}} [ctx]
 */
export async function playWavOnSonos(audioPath, target = 'down', ctx = {}) {
  if (!existsSync(audioPath)) {
    logger.warn(`[sonos-play] audio not found: ${audioPath}`);
    return;
  }

  await startHttpServer();

  const { dir, name, relative } = buildServedPath(ctx);
  const servedPath = join(dir, name);
  try {
    copyFileSync(audioPath, servedPath);
  } catch (err) {
    logger.warn(`[sonos-play] failed to stage ${audioPath}: ${err.message}`);
    return;
  }

  const mediaUrl = `http://${LAN_HOST}:${HTTP_PORT}/${relative}`;
  const targets = target === 'up'   ? [BEDROOM_IP]
                : target === 'down' ? [KITCHEN_IP]
                : target === 'all'  ? [BEDROOM_IP, KITCHEN_IP]
                : [KITCHEN_IP];

  // Fire UPnP per-device. Each device: Stop → clear queue → set URI → Play.
  await Promise.all(targets.map(async (ip) => {
    try {
      await stopTransport(ip);
      await removeAllTracks(ip);
      await setTransportUri(ip, mediaUrl);
      await play(ip);
      logger.info(`[sonos-play] ${ip} target=${target} url=${mediaUrl}`);
    } catch (err) {
      logger.warn(`[sonos-play] ${ip} setup failed: ${err.message}`);
    }
  }));

  // Manifest update — last played per channel/thread
  const manifestKey = `${safeSegment(ctx?.channelId ?? 'system')}/${safeSegment(ctx?.threadId ?? 'main')}`;
  updateManifest(manifestKey, {
    lastWavPath: servedPath,
    lastServedUrl: mediaUrl,
    lastPlayedAt: Date.now(),
    target,
    taskId: ctx?.taskId ?? null,
    role: ctx?.role ?? null,
  });

  // Wait for real playback completion on ALL targets. Before: only polled
  // targets[0], so for target='all' the secondary speaker could still be
  // playing when this function returned — downstream attention-window opened
  // the mic during the still-speaking audio and picked up feedback.
  try {
    const results = await Promise.all(targets.map(async (ip) => {
      const { state, waitedMs } = await waitForTransportStopped(ip);
      return { ip, state, waitedMs };
    }));
    for (const r of results) {
      logger.info(`[sonos-play] ${r.ip} reached ${r.state} after ${r.waitedMs}ms`);
    }
  } catch (err) {
    logger.warn(`[sonos-play] transport-wait failed: ${err.message}`);
  }
}
