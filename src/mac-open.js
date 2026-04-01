/**
 * mac-open.js — Direct SSH open on Lance's MacBook Pro
 * 
 * Bypasses LLM entirely. One SSH call, done.
 * Mirrors the mac-open skill but as a direct Node.js function.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import logger from './logger.js';

const execAsync = promisify(exec);

const MAC_SSH_HOST = process.env.MAC_SSH_HOST || 'MAC_SSH_HOST';
const MAC_SSH_KEY = process.env.MAC_SSH_KEY || `${process.env.HOME}/.ssh/id_rsa`;
const MAC_OPEN_TIMEOUT_MS = parseInt(process.env.MAC_OPEN_TIMEOUT_MS || '5000');

/**
 * Open a URL or file on Lance's Mac via SSH.
 * @param {string} url - URL or file path to open
 * @returns {Promise<boolean>} true on success, false on failure (never throws)
 */
export async function openOnMac(url) {
  if (!url) {
    logger.warn('⚡ mac-open: no URL provided');
    return false;
  }

  // Sanitize — prevent shell injection
  const safeUrl = url.replace(/'/g, "'\\''");

  const cmd = `ssh -o IdentitiesOnly=yes -i "${MAC_SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=3 ${MAC_SSH_HOST} 'open "${safeUrl}"'`;

  try {
    await execAsync(cmd, { timeout: MAC_OPEN_TIMEOUT_MS });
    logger.info({ url }, '⚡ mac-open: opened successfully');
    return true;
  } catch (err) {
    logger.warn({ url, err: err.message }, '⚡ mac-open: SSH open failed');
    return false;
  }
}
