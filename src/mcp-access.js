/**
 * mcp-access.js — Universal mcporter integration layer
 *
 * Single entry point for all MCP tool calls. Detects OAuth re-auth URLs
 * and routes them to Discord via a registered notify callback instead of
 * silently dropping them. Works for any current or future mcporter server.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import logger from './logger.js';

const execAsync = promisify(exec);
const MCPORTER = process.env.MCPORTER_PATH || 'mcporter';
const MCP_TIMEOUT_MS = parseInt(process.env.MCP_TIMEOUT_MS ?? '30000');
const AUTH_URL_RE = /Authorization URL:\s*(https:\/\/\S+)/;

let _authNotify = null;

/**
 * Register a callback invoked when any mcporter call requires OAuth re-auth.
 * @param {(server: string, tool: string, url: string) => void} fn
 */
export function setMcpAuthNotify(fn) {
  _authNotify = fn;
}

/**
 * Invoke any mcporter tool. Returns trimmed stdout string, or null on auth failure.
 * Throws on non-auth errors.
 *
 * @param {string} server  e.g. 'google-workspace', 'haivemind', 'slack', 'linear'
 * @param {string} tool    e.g. 'get_events', 'store_memory', 'conversations_history'
 * @param {object} args    key-value pairs — values are string-coerced and JSON-quoted
 */
export async function mcpCall(server, tool, args = {}) {
  const argStr = Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)
    .join(' ');
  const cmd = `${MCPORTER} call ${server}.${tool}${argStr ? ' ' + argStr : ''}`;

  let stdout = '', stderr = '';
  try {
    ({ stdout, stderr } = await execAsync(cmd, {
      timeout: MCP_TIMEOUT_MS,
      cwd: process.env.HOME || '/tmp',
    }));
  } catch (err) {
    stdout = err.stdout || '';
    stderr = (err.stderr || '') + (err.message || '');
    const m = (stdout + stderr).match(AUTH_URL_RE);
    if (m) { _handleAuth(m[1], server, tool); return null; }
    throw err;
  }

  const combined = stdout + stderr;
  const m = combined.match(AUTH_URL_RE);
  if (m) { _handleAuth(m[1], server, tool); return null; }

  return stdout.trim();
}

function _handleAuth(url, server, tool) {
  logger.warn(`[mcp] auth required: ${server}.${tool} → ${url}`);
  _authNotify?.(server, tool, url);
}
