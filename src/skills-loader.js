/**
 * skills-loader — auto-inject SKILL.md files into the voice system prompt.
 *
 * Scans SKILLS_DIR (env, default ~/.claude/skills) for skill folders.
 * Skills with `voice: false` in their YAML frontmatter are excluded.
 * Result is cached for CACHE_TTL_MS to avoid per-request disk reads.
 *
 * Usage:
 *   import { getSkillsBlock } from './skills-loader.js';
 *   const block = getSkillsBlock(); // '' if no skills or dir missing
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import logger from './logger.js';

const SKILLS_DIR = process.env.SKILLS_DIR
  ? resolve(process.env.SKILLS_DIR)
  : join(homedir(), '.claude', 'skills');

const CACHE_TTL_MS = 30_000;   // re-scan every 30s so new skills are picked up without restart
const MAX_TOTAL_CHARS = 40_000; // hard cap to avoid bloating the system prompt

let _cache = null;
let _cacheTime = 0;

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Returns { meta: {}, body: string }
 */
function _parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { meta, body: match[2].trim() };
}

/** Load and return all voice-eligible skills as a single injected block. */
function _buildBlock() {
  if (!existsSync(SKILLS_DIR)) return '';

  let dirs;
  try {
    dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(SKILLS_DIR, d.name, 'SKILL.md')))
      .map(d => d.name)
      .sort();
  } catch {
    return '';
  }

  const sections = [];
  let totalChars = 0;

  for (const name of dirs) {
    let raw;
    try {
      raw = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }

    const { meta, body } = _parseFrontmatter(raw);

    // Opt-out: voice: false skips this skill
    if (meta.voice === 'false') continue;

    if (totalChars + body.length > MAX_TOTAL_CHARS) {
      logger.warn(`[skills-loader] Skipping remaining skills — hit ${MAX_TOTAL_CHARS} char cap`);
      break;
    }

    sections.push(body);
    totalChars += body.length;
  }

  if (sections.length === 0) return '';

  logger.debug(`[skills-loader] Loaded ${sections.length} skills (${totalChars} chars) from ${SKILLS_DIR}`);
  return '\n\n## Available Skills\n\n' + sections.join('\n\n---\n\n');
}

/**
 * Return the cached skills block, refreshing if the TTL has expired.
 * Returns '' if the skills directory is missing or empty.
 */
export function getSkillsBlock() {
  const now = Date.now();
  if (_cache === null || now - _cacheTime > CACHE_TTL_MS) {
    _cache = _buildBlock();
    _cacheTime = now;
  }
  return _cache;
}

/** Force a cache refresh (e.g. after installing a new skill). */
export function reloadSkills() {
  _cache = null;
  _cacheTime = 0;
  return getSkillsBlock();
}
