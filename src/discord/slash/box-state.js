/**
 * box-state.js — Configurable box/tunnel registry for /shell and /dir.
 *
 * Boxes are defined via the BOXES env var: comma-separated name:ssh-alias:user triples.
 * Use "local" as the alias for the box the bot runs on. User is optional — if omitted
 * SSH falls back to whatever ~/.ssh/config defines for that alias.
 *
 *   BOXES=generic:local:generic,mac:mac:lj,gamez:gamez:yari
 *   BOXES=generic:local:generic,mac:mac:lj,gamez:gamez:yari,ewitness:ewitness-client:lance
 *
 * Default cwd per box is the bot's HOME (local) or ~ (remote). Override with BOX_<NAME>_HOME:
 *   BOX_MAC_HOME=/Users/youruser
 *   BOX_GAMEZ_HOME=/home/youruser
 *
 * The SSH target is constructed as user@alias when user is provided, else just alias.
 * This means the box system works independently of ~/.ssh/config User entries.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _DATA_DIR = join(__dirname, '..', '..', 'data');
const _STATE_FILE = join(_DATA_DIR, 'box-state.json');

const _DEFAULT_BOXES = 'generic:local,mac:mac,gamez:gamez';

function _parseBoxes() {
  const raw = process.env.BOXES || _DEFAULT_BOXES;
  const boxes = {};
  for (const entry of raw.split(',')) {
    const parts = entry.trim().split(':');
    const [name, ssh, user] = parts;
    if (!name || !ssh) continue;
    const isLocal = ssh === 'local';
    const envKey = `BOX_${name.toUpperCase()}_HOME`;
    const defaultCwd = process.env[envKey] || (isLocal ? (process.env.HOME || process.cwd()) : '~');
    // Build SSH target: user@alias if user provided, else alias only
    const sshTarget = isLocal ? null : (user ? `${user}@${ssh}` : ssh);
    boxes[name] = { label: name, ssh: sshTarget, isLocal, defaultCwd };
  }
  return boxes;
}

const BOXES = _parseBoxes();
const BOX_NAMES = Object.keys(BOXES);

let _activeBox = BOX_NAMES[0] || 'generic';

// Write initial state on load so hud-render can read it immediately
setTimeout(() => _persist(), 0);

const _cwdByBox = Object.fromEntries(
  BOX_NAMES.map(n => [n, BOXES[n].defaultCwd])
);

/** Returns active box descriptor: { name, label, ssh, isLocal } */
export function getBox() {
  return { name: _activeBox, ...BOXES[_activeBox] };
}

/** Get descriptor for a named box without changing active box. Returns null if not found. */
export function getBoxByName(name) {
  if (!BOXES[name]) return null;
  return { name, ...BOXES[name] };
}

/** Switch active box. Returns true if valid name, false otherwise. */
export function setBox(name) {
  if (!BOXES[name]) return false;
  _activeBox = name;
  return true;
}

/** List all boxes with active flag. */
export function listBoxes() {
  return BOX_NAMES.map(name => ({
    name,
    label: BOXES[name].label,
    ssh: BOXES[name].ssh,
    isLocal: BOXES[name].isLocal,
    active: name === _activeBox,
  }));
}

/** Get working directory for active box. */
export function getCwd() {
  return _cwdByBox[_activeBox] || '~';
}

/** Set working directory for active box. */
export function setCwd(path) {
  _cwdByBox[_activeBox] = path;
  _persist();
}

/** Write current box + cwd to data/box-state.json so external tools (hud-render, tmux) can read it. */
function _persist() {
  try {
    if (!existsSync(_DATA_DIR)) mkdirSync(_DATA_DIR, { recursive: true });
    writeFileSync(_STATE_FILE, JSON.stringify({
      activeBox: _activeBox,
      cwd: _cwdByBox[_activeBox] || '~',
      ssh: BOXES[_activeBox]?.ssh || null,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch { /* non-fatal */ }
}

export function persistBoxState() { _persist(); }

export { BOX_NAMES };
