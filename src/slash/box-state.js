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

const _cwdByBox = Object.fromEntries(
  BOX_NAMES.map(n => [n, BOXES[n].defaultCwd])
);

/** Returns active box descriptor: { name, label, ssh, isLocal } */
export function getBox() {
  return { name: _activeBox, ...BOXES[_activeBox] };
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
}

export { BOX_NAMES };
