/**
 * channel-access.js — Owner + channel-scoped permission model.
 *
 * The bot owner (ALLOWED_USERS[0] / OWNER_USER_ID) has full access everywhere.
 * Other users can be granted access to specific channels only; the grant is
 * scoped to this system's data/channel-access.json and does not propagate to
 * other bot instances or systems.
 *
 * Grants: { channelId: Set<userId> }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACCESS_FILE = join(__dirname, '..', 'data', 'channel-access.json');

// The one true owner — explicit env var or first ALLOWED_USERS entry.
const OWNER_USER_ID = process.env.OWNER_USER_ID ||
  (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean)[0] || '';

// In-memory grants: Map<channelId, Set<userId>>
let _grants = new Map();

function _load() {
  try {
    if (!existsSync(ACCESS_FILE)) return;
    const raw = JSON.parse(readFileSync(ACCESS_FILE, 'utf-8'));
    _grants = new Map(Object.entries(raw).map(([ch, users]) => [ch, new Set(users)]));
    logger.info(`[channel-access] Loaded ${_grants.size} channel grant(s)`);
  } catch (err) {
    logger.warn(`[channel-access] Failed to load: ${err.message}`);
  }
}

function _save() {
  try {
    mkdirSync(join(__dirname, '..', 'data'), { recursive: true });
    const obj = Object.fromEntries([..._grants.entries()].map(([ch, users]) => [ch, [...users]]));
    writeFileSync(ACCESS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`[channel-access] Failed to save: ${err.message}`);
  }
}

_load();

/** True only for the bot owner. */
export function isOwner(userId) {
  return !!OWNER_USER_ID && userId === OWNER_USER_ID;
}

/** True if userId is the owner OR has been granted access to channelId. */
export function canAccessChannel(userId, channelId) {
  if (isOwner(userId)) return true;
  return _grants.get(channelId)?.has(userId) ?? false;
}

/** Grant userId access to channelId. Returns true if newly added. */
export function grantAccess(userId, channelId) {
  if (!_grants.has(channelId)) _grants.set(channelId, new Set());
  const set = _grants.get(channelId);
  if (set.has(userId)) return false;
  set.add(userId);
  _save();
  logger.info(`[channel-access] Granted ${userId} access to channel ${channelId}`);
  return true;
}

/** Revoke userId access from channelId. Returns true if removed. */
export function revokeAccess(userId, channelId) {
  const set = _grants.get(channelId);
  if (!set?.has(userId)) return false;
  set.delete(userId);
  if (set.size === 0) _grants.delete(channelId);
  _save();
  logger.info(`[channel-access] Revoked ${userId} access to channel ${channelId}`);
  return true;
}

/** Returns all grants as an array of { channelId, userIds } for display. */
export function listAccess() {
  return [..._grants.entries()].map(([channelId, users]) => ({ channelId, userIds: [...users] }));
}

export { OWNER_USER_ID };
