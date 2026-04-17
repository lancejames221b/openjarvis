/**
 * Project Registry — maps project names/aliases to IDE remote URIs.
 *
 * When visual mode (at-desk) is active and the user says "bring up the code"
 * or "open X in Cursor", this resolves the project to a Cursor-compatible
 * URI and opens it on the Mac.
 *
 * Configure your own projects in config/projects.json (see config/projects.example.json).
 * Format: [{ "aliases": ["name", "alias"], "host": "ssh-host-or-null", "path": "/abs/path", "description": "..." }]
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_PATH = process.env.PROJECTS_JSON_PATH || join(__dirname, '..', 'config', 'projects.json');

function loadProjects() {
  try {
    return JSON.parse(readFileSync(PROJECTS_PATH, "utf8"));
  } catch {
    return [];
  }
}

const PROJECTS = loadProjects();

/**
 * Resolve a project name/alias to a Cursor-openable URI.
 * @param {string} query - Project name or alias (fuzzy-matched)
 * @returns {{ project: object, uri: string, cmd: string } | null}
 */
export function resolveProject(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();

  for (const project of PROJECTS) {
    if (project.aliases.some(a => a === q)) return buildResult(project);
  }
  for (const project of PROJECTS) {
    if (project.aliases.some(a => a.includes(q) || q.includes(a))) return buildResult(project);
  }
  for (const project of PROJECTS) {
    if (project.description?.toLowerCase().includes(q)) return buildResult(project);
  }
  return null;
}

function buildResult(project) {
  let uri, cmd;
  if (project.host) {
    uri = `vscode-remote://ssh-remote+${project.host}${project.path}`;
    cmd = `cursor --folder-uri '${uri}'`;
  } else {
    uri = project.path;
    cmd = `cursor '${project.path}'`;
  }
  return { project, uri, cmd };
}

export function listProjects() {
  return PROJECTS;
}

export function addProject(aliases, host, path, description) {
  PROJECTS.push({ aliases, host, path, description });
  logger.info(`[cursor-projects] Registered project: ${aliases[0]} → ${host || 'local'}:${path}`);
}
