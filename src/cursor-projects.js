/**
 * Cursor Project Registry — maps project names/aliases to Cursor remote URIs.
 *
 * When visual mode (at-desk) is active and the user says "bring up the code"
 * or "open X in Cursor", this resolves the project to a Cursor-compatible
 * URI and opens it on the Mac.
 *
 * Cursor CLI: /usr/local/bin/cursor (or /opt/homebrew/bin/cursor)
 * Remote open: cursor --folder-uri 'vscode-remote://ssh-remote+HOST/path'
 * Local open:  cursor /path/to/folder
 */

import logger from './logger.js';

// ── Project Registry ──────────────────────────────────────────────────
// Each entry: { aliases: string[], host: string|null, path: string, description: string }
// host=null means local Mac path. host='generic' means SSH remote 'generic', etc.
const PROJECTS = [
  // ── eWitness ──
  {
    aliases: ['ewitness', 'ew', 'ewitness-stack', 'ew-stack'],
    host: 'lance-dev',
    path: '/root/ewitness/ewitness-stack',
    description: 'eWitness full stack',
  },
  {
    aliases: ['ew-api', 'ewitness-api', 'api'],
    host: 'lance-dev',
    path: '/root/ewitness/ewitness-stack',
    description: 'eWitness API',
  },
  {
    aliases: ['ew-ui', 'ewitness-ui', 'frontend', 'ui'],
    host: 'ewitness-client',
    path: '/home/refactor-staging',
    description: 'eWitness UI (refactor-staging)',
  },
  {
    aliases: ['ew-alerting', 'alerting', 'ewitness-alerting'],
    host: null,
    path: '/Users/lj/Development/ewitness-alerting',
    description: 'eWitness alerting (local)',
  },
  {
    aliases: ['ew-archiver', 'archiver'],
    host: 'generic-linux',
    path: '/home/generic/dev/ew-archiver',
    description: 'eWitness archiver',
  },
  {
    aliases: ['ew-postman', 'postman'],
    host: 'generic-linux',
    path: '/home/generic/dev/ew-postman-collection',
    description: 'eWitness Postman collection',
  },
  {
    aliases: ['media-processor', 'media'],
    host: 'lance-dev',
    path: '/root/media-processor',
    description: 'Media processor service',
  },

  // ── DStorm / Gibson ──
  {
    aliases: ['dstorm', 'gibson', 'scraper', 'scrapers'],
    host: 'lance-dev',
    path: '/home/lj/ewitness-stack/DStorm',
    description: 'DStorm scrapers',
  },
  {
    aliases: ['gibson-flask', 'gibson-api', 'flask-app'],
    host: 'chris-dev',
    path: '/root/flask_app',
    description: 'Gibson Flask API',
  },
  {
    aliases: ['token-grabbers', 'tokens'],
    host: 'chris-dev',
    path: '/root/token_grabbers',
    description: 'Token grabber analysis',
  },

  // ── Jarvis / OpenClaw ──
  {
    aliases: ['jarvis', 'jarvis-voice', 'voice-bot', 'voice'],
    host: 'generic-linux',
    path: '/home/generic/dev/jarvis-voice-dev',
    description: 'Jarvis voice bot (dev)',
  },
  {
    aliases: ['openclaw', 'claw', 'clawdbot'],
    host: 'generic-linux',
    path: '/home/generic/dev',
    description: 'OpenClaw workspace',
  },
  {
    aliases: ['haivemind', 'memory', 'hivemind'],
    host: 'lance-dev',
    path: '/home/lj/Dev/haivemind/haivemind-mcp-server',
    description: 'hAIveMind MCP server',
  },

  // ── Reverse Engineering ──
  {
    aliases: ['re', 'reverse-engineering', 'malware', 'reverse'],
    host: 'generic-linux',
    path: '/media/generic/8f6026e4-4fcd-4f37-8815-807fdcb8a404/DEV/ReverseEngineering',
    description: 'Reverse engineering workspace',
  },
  {
    aliases: ['shiny'],
    host: null,
    path: '/Volumes/SeXternal/Dev/ReverseEngineering/SHINY',
    description: 'SHINY RE project (local)',
  },
  {
    aliases: ['cactus'],
    host: null,
    path: '/Volumes/SeXternal/Dev/ReverseEngineering/cactus',
    description: 'Cactus ransomware analysis (local)',
  },
  {
    aliases: ['akira'],
    host: null,
    path: '/Volumes/SeXternal/Dev/ReverseEngineering/Akira',
    description: 'Akira ransomware analysis (local)',
  },

  // ── Other ──
  {
    aliases: ['mason', 'pii-mason', 'project-mason'],
    host: 'generic-linux',
    path: '/media/generic/8f6026e4-4fcd-4f37-8815-807fdcb8a404/DEV/PII Project Mason',
    description: 'PII Project Mason',
  },
  {
    aliases: ['osaint', 'osint-tool'],
    host: 'lance-dev',
    path: '/home/lj/OSAINT',
    description: 'OSAINT tool',
  },
  {
    aliases: ['aictf', 'ai-ctf'],
    host: 'lance-dev',
    path: '/home/lj/Dev/AICTF',
    description: 'AI CTF project',
  },
  {
    aliases: ['krebs', 'krebs-analysis'],
    host: 'lance-dev',
    path: '/root/krebs',
    description: 'Krebs analysis workspace',
  },
  {
    aliases: ['red-team', 'redteam'],
    host: 'lance-dev',
    path: '/root/red_team',
    description: 'Red team tools',
  },
];

/**
 * Resolve a project name/alias to a Cursor-openable URI.
 * @param {string} query - Project name or alias (fuzzy-matched)
 * @returns {{ project: object, uri: string, cmd: string } | null}
 */
export function resolveProject(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();

  // Exact alias match first
  for (const project of PROJECTS) {
    if (project.aliases.some(a => a === q)) {
      return buildResult(project);
    }
  }

  // Partial match (alias starts with or contains query)
  for (const project of PROJECTS) {
    if (project.aliases.some(a => a.includes(q) || q.includes(a))) {
      return buildResult(project);
    }
  }

  // Description match
  for (const project of PROJECTS) {
    if (project.description.toLowerCase().includes(q)) {
      return buildResult(project);
    }
  }

  return null;
}

function buildResult(project) {
  let uri, cmd;
  if (project.host) {
    // Remote — use vscode-remote URI
    uri = `vscode-remote://ssh-remote+${project.host}${project.path}`;
    cmd = `cursor --folder-uri '${uri}'`;
  } else {
    // Local — open directly
    uri = project.path;
    cmd = `cursor '${project.path}'`;
  }
  return { project, uri, cmd };
}

/**
 * Get all registered projects for listing.
 * @returns {Array<{ aliases: string[], host: string|null, path: string, description: string }>}
 */
export function listProjects() {
  return PROJECTS;
}

/**
 * Add a project at runtime (e.g., from voice command: "register project X at path Y")
 */
export function addProject(aliases, host, path, description) {
  PROJECTS.push({ aliases, host, path, description });
  logger.info(`[cursor-projects] Registered project: ${aliases[0]} → ${host || 'local'}:${path}`);
}
