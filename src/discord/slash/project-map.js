/**
 * project-map.js — Persist channel → {name, box, cwd} mappings.
 * Written to data/project-map.json alongside box-state.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, '..', '..', 'data');
const MAP_FILE  = join(DATA_DIR, 'project-map.json');

function _load() {
  if (!existsSync(MAP_FILE)) return {};
  try { return JSON.parse(readFileSync(MAP_FILE, 'utf8')); } catch { return {}; }
}

function _save(map) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
}

export function setProjectMap(channelId, name, box, cwd) {
  const map = _load();
  map[channelId] = { name, box, cwd, createdAt: new Date().toISOString() };
  _save(map);
}

export function getProjectMap(channelId) {
  return _load()[channelId] || null;
}

export function deleteProjectMap(channelId) {
  const map = _load();
  if (!map[channelId]) return false;
  delete map[channelId];
  _save(map);
  return true;
}

export function findProjectMapByName(name) {
  const map = _load();
  const q = name.toLowerCase();
  for (const [channelId, v] of Object.entries(map)) {
    if (v.name && v.name.toLowerCase() === q) return { channelId, ...v };
  }
  return null;
}

export function listProjectMaps() {
  return Object.entries(_load()).map(([channelId, v]) => ({ channelId, ...v }));
}
