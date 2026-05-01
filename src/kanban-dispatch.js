/**
 * Kanban dispatch — natural-language Kanban CLI router.
 *
 * When a message arrives in a Kanban-enabled channel (registry entry has
 * `kanbanEnabled: true`), this module checks the transcript for natural
 * Kanban intents (create task, show board, start/trash, etc.) and shells
 * out to the local `kanban` CLI to fulfill them. Returns the formatted
 * output for Discord plus a short voice summary, or `{ handled: false }`
 * when no pattern matches so the caller falls through to the brain.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from './logger.js';
import { isKanbanChannel, getKanbanPath } from './focus-state.js';

const execFileAsync = promisify(execFile);

const KANBAN_BIN = '/home/yari/.local/bin/kanban';
const NODE_BIN = 'node';

const COLUMN_LABELS = {
  backlog: 'Backlog',
  in_progress: 'In Progress',
  review: 'Review',
  trash: 'Trash',
};
const COLUMN_ORDER = ['backlog', 'in_progress', 'review', 'trash'];

// Optional leading wake-word + punctuation; trailing period is tolerated.
const LEAD = /^(?:jarvis\s*[,.]?\s*)?/i;
const TAIL = /\s*\.?\s*$/;

const PATTERNS = [
  {
    action: 'create',
    re: new RegExp(LEAD.source + /(?:create\s+(?:a\s+)?task|new\s+task)\s*[:\-]\s*(.+?)/.source + TAIL.source, 'i'),
  },
  {
    action: 'list-backlog',
    re: new RegExp(LEAD.source + /(?:show\s+backlog|what'?s\s+in\s+backlog)/.source + TAIL.source, 'i'),
  },
  {
    action: 'list-in-progress',
    re: new RegExp(LEAD.source + /(?:what'?s\s+in\s+progress|active\s+tasks?)/.source + TAIL.source, 'i'),
  },
  {
    action: 'list',
    re: new RegExp(LEAD.source + /(?:show\s+(?:the\s+)?board|kanban\s+status|board\s+status|list\s+tasks?)/.source + TAIL.source, 'i'),
  },
  {
    action: 'start',
    re: new RegExp(LEAD.source + /start\s+task\s+(.+?)/.source + TAIL.source, 'i'),
  },
  {
    action: 'trash',
    re: new RegExp(LEAD.source + /(?:trash\s+task|done\s+with\s+task)\s+(.+?)/.source + TAIL.source, 'i'),
  },
];

function _matchPattern(transcript) {
  const text = String(transcript || '').trim();
  if (!text) return null;
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) return { action: p.action, capture: m[1]?.trim() || null };
  }
  return null;
}

function _firstLine(s, max = 80) {
  if (!s) return '';
  const line = String(s).split('\n')[0].trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function _truncate(s, max = 60) {
  if (!s) return '';
  const t = String(s);
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function _formatBoard(parsed) {
  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  const buckets = { backlog: [], in_progress: [], review: [], trash: [] };
  for (const t of tasks) {
    const col = (t && t.column) || 'backlog';
    if (buckets[col]) buckets[col].push(t);
  }
  const lines = [];
  for (const col of COLUMN_ORDER) {
    lines.push(`${COLUMN_LABELS[col]} (${buckets[col].length})`);
    if (buckets[col].length === 0) {
      lines.push('  (empty)');
    } else {
      for (const t of buckets[col]) {
        const title = t.title || _firstLine(t.prompt, 60) || '(no title)';
        lines.push(`  [${t.id}] ${_truncate(title, 60)}`);
      }
    }
    lines.push('');
  }
  return '```\n' + lines.join('\n').trimEnd() + '\n```';
}

async function _runCli(args, projectPath, exec) {
  const fullArgs = [KANBAN_BIN, ...args, '--project-path', projectPath];
  try {
    const { stdout } = await exec(NODE_BIN, fullArgs);
    return { ok: true, stdout: stdout || '' };
  } catch (err) {
    const stderr = err?.stderr || err?.message || '';
    const stdout = err?.stdout || '';
    return { ok: false, stdout, stderr };
  }
}

function _parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Try to handle a transcript as a Kanban CLI command.
 *
 * @param {string} transcript - the cleaned message/transcript
 * @param {string} channelId - Discord channel (or thread) id
 * @param {object} [options]
 * @param {Function} [options.exec] - async (bin, args) → { stdout, stderr }
 *                                    Override for tests; defaults to execFileAsync
 * @returns {Promise<{handled: boolean, result?: string, voice?: string}>}
 */
export async function tryKanbanDispatch(transcript, channelId, options = {}) {
  if (!isKanbanChannel(channelId)) return { handled: false };

  const matched = _matchPattern(transcript);
  if (!matched) return { handled: false };

  const projectPath = getKanbanPath(channelId);
  if (!projectPath) {
    logger.warn(`[kanban-dispatch] Kanban channel ${channelId} has no kanbanPath/path`);
    return { handled: true, result: 'Kanban channel has no project path configured.', voice: 'No project path set.' };
  }

  const exec = options.exec || execFileAsync;

  switch (matched.action) {
    case 'create': {
      const title = matched.capture;
      const r = await _runCli(['task', 'create', '--title', title, '--prompt', title], projectPath, exec);
      if (!r.ok) return { handled: true, result: `Kanban CLI failed: ${r.stderr || 'unknown error'}`, voice: 'Kanban command failed.' };
      const parsed = _parseJson(r.stdout);
      if (!parsed || parsed.ok === false) {
        const msg = parsed?.error || r.stdout || 'unknown error';
        return { handled: true, result: `Kanban error: ${msg}`, voice: 'Kanban command failed.' };
      }
      const id = parsed.task?.id || parsed.id || '?';
      return {
        handled: true,
        result: `✅ Task created: ${title} [${id}]`,
        voice: `Created task: ${title}`,
      };
    }

    case 'list':
    case 'list-backlog':
    case 'list-in-progress': {
      const args = ['task', 'list'];
      if (matched.action === 'list-backlog') args.push('--column', 'backlog');
      else if (matched.action === 'list-in-progress') args.push('--column', 'in_progress');

      const r = await _runCli(args, projectPath, exec);
      if (!r.ok) return { handled: true, result: `Kanban CLI failed: ${r.stderr || 'unknown error'}`, voice: 'Kanban command failed.' };
      const parsed = _parseJson(r.stdout);
      if (!parsed || parsed.ok === false) {
        const msg = parsed?.error || r.stdout || 'unknown error';
        return { handled: true, result: `Kanban error: ${msg}`, voice: 'Kanban command failed.' };
      }
      const formatted = _formatBoard(parsed);
      const count = Array.isArray(parsed.tasks) ? parsed.tasks.length : 0;
      return { handled: true, result: formatted, voice: `${count} task${count === 1 ? '' : 's'}.` };
    }

    case 'start': {
      const id = matched.capture;
      const r = await _runCli(['task', 'start', '--task-id', id], projectPath, exec);
      if (!r.ok) return { handled: true, result: `Kanban CLI failed: ${r.stderr || 'unknown error'}`, voice: 'Kanban command failed.' };
      const parsed = _parseJson(r.stdout);
      if (!parsed || parsed.ok === false) {
        const msg = parsed?.error || r.stdout || 'unknown error';
        return { handled: true, result: `Kanban error: ${msg}`, voice: 'Kanban command failed.' };
      }
      const title = parsed.task?.title || _firstLine(parsed.task?.prompt, 60) || id;
      return { handled: true, result: `▶️ Started task: ${title}`, voice: `Started task: ${title}` };
    }

    case 'trash': {
      const id = matched.capture;
      const r = await _runCli(['task', 'trash', '--task-id', id], projectPath, exec);
      if (!r.ok) return { handled: true, result: `Kanban CLI failed: ${r.stderr || 'unknown error'}`, voice: 'Kanban command failed.' };
      const parsed = _parseJson(r.stdout);
      if (!parsed || parsed.ok === false) {
        const msg = parsed?.error || r.stdout || 'unknown error';
        return { handled: true, result: `Kanban error: ${msg}`, voice: 'Kanban command failed.' };
      }
      return { handled: true, result: `🗑️ Trashed task ${id}`, voice: `Trashed task ${id}` };
    }

    default:
      return { handled: false };
  }
}
