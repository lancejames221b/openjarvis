/**
 * allowed-users.js — mutable list of Discord users the bot trusts.
 *
 * Reads data/allowed-users.json; on first run, migrates from ALLOWED_USERS
 * + JARVIS_USER_NAMES env vars so nothing breaks on existing installs.
 * Changes take effect immediately — no restart required.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const FILE = join(DATA_DIR, 'allowed-users.json');

let _cache = null;

function _load() {
  if (_cache) return _cache;
  try {
    if (existsSync(FILE)) {
      _cache = JSON.parse(readFileSync(FILE, 'utf8'));
      return _cache;
    }
  } catch {}
  // Migrate from env on first call
  const ids = (process.env.ALLOWED_USERS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const nameMap = Object.fromEntries(
    (process.env.JARVIS_USER_NAMES || '').split(',')
      .map(s => s.trim()).filter(Boolean)
      .map(p => { const [id, ...rest] = p.split(':'); return [id, rest.join(':')]; })
  );
  _cache = ids.map((id, i) => ({
    id,
    name: nameMap[id] || (i === 0 ? 'Owner' : id.slice(0, 6)),
    addedAt: new Date().toISOString(),
  }));
  return _cache;
}

function _save(users) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(users, null, 2) + '\n');
  _cache = users;
}

/** Array of {id, name, addedAt} objects. */
export function getAllowedUsers() {
  return _load();
}

/** Array of Discord user ID strings, order-preserved (index 0 = owner). */
export function getAllowedUserIds() {
  return _load().map(u => u.id);
}

/** Display name for a user ID, or null if not enrolled. */
export function getUserName(id) {
  return _load().find(u => u.id === id)?.name ?? null;
}

/** Add a new member. Returns {ok, id, name} or {ok:false, reason}. */
export function addMember(id, name) {
  if (!id || !name) return { ok: false, reason: 'id and name required' };
  const users = _load();
  if (users.find(u => u.id === id)) return { ok: false, reason: 'already_exists' };
  users.push({ id, name, addedAt: new Date().toISOString() });
  _save(users);
  logger.info(`[allowed-users] added: ${id} (${name})`);
  return { ok: true, id, name };
}

/** Remove a member by ID. Owner (index 0) cannot be removed. */
export function removeMember(id) {
  const users = _load();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return { ok: false, reason: 'not_found' };
  if (idx === 0) return { ok: false, reason: 'cannot_remove_owner' };
  users.splice(idx, 1);
  _save(users);
  logger.info(`[allowed-users] removed: ${id}`);
  return { ok: true, id };
}
