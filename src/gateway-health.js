/**
 * gateway-health.js — Gateway health monitoring and startup cleanup.
 *
 * Extracted from src/index.js. Manages:
 * - Gateway HTTP health check with adaptive polling
 * - Stale TTS /tmp audio cleanup on startup
 * - Model trigger table loader
 */

import { promises as fsPromises, readFileSync } from 'fs';
import logger from './logger.js';

const GATEWAY_URL = process.env.JARVIS_GATEWAY_URL || 'http://127.0.0.1:22100';
const GATEWAY_TOKEN = process.env.JARVIS_GATEWAY_TOKEN;

// ── Gateway Health Check ─────────────────────────────────────────────

let _gatewayHealthy = false;
let _healthCheckInterval = null;

export function isGatewayHealthy() {
  return _gatewayHealthy;
}

export async function checkGatewayHealth() {
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${GATEWAY_TOKEN}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`Gateway ${res.status}`);
    }
    if (!_gatewayHealthy) logger.info('🟢 Gateway is healthy');
    _gatewayHealthy = true;
    return true;
  } catch (err) {
    _gatewayHealthy = false;
    logger.warn(`🔴 Gateway health check failed: ${err.message}`);
    return false;
  }
}

// ── Startup Cleanup ──────────────────────────────────────────────────
// Remove stale TTS audio files from /tmp left by previous crashed/interrupted runs.
export async function cleanupStaleTmpAudio() {
  try {
    const files = (await fsPromises.readdir('/tmp')).filter(f =>
      (f.endsWith('.wav') || f.endsWith('.mp3')) && f.startsWith('jarvis-')
    );
    let removed = 0;
    for (const f of files) {
      try {
        const age = Date.now() - (await fsPromises.stat(`/tmp/${f}`)).mtimeMs;
        if (age > 60_000) { await fsPromises.unlink(`/tmp/${f}`); removed++; }
      } catch {}
    }
    if (removed > 0) logger.info(`🧹 Cleaned up ${removed} stale audio file(s) from /tmp`);
  } catch {}
}

export async function startGatewayHealthCheck() {
  await cleanupStaleTmpAudio();
  logger.info('🏥 Running initial gateway health check...');
  const healthy = await checkGatewayHealth();
  if (healthy) {
    logger.info('✅ Gateway reachable on startup');
  } else {
    logger.warn('⚠️  Gateway unreachable on startup - will retry every 10s');
  }
  // Adaptive polling: 10s when unhealthy, 60s when healthy
  const scheduleHealthPoll = (intervalMs) => {
    if (_healthCheckInterval) clearInterval(_healthCheckInterval);
    _healthCheckInterval = setInterval(async () => {
      const wasHealthy = _gatewayHealthy;
      const ok = await checkGatewayHealth();
      if (ok && !wasHealthy) scheduleHealthPoll(60_000);
      if (!ok && wasHealthy) scheduleHealthPoll(10_000);
    }, intervalMs);
  };
  scheduleHealthPoll(_gatewayHealthy ? 15_000 : 10_000);
}

// ── Per-Task Voice Model Trigger Table ───────────────────────────────
const _MODELS_CFG_PATH = new URL('../config/models.json', import.meta.url).pathname;

export function _loadModelTriggers() {
  try { return JSON.parse(readFileSync(_MODELS_CFG_PATH, 'utf-8')).triggers || []; } catch { return []; }
}
