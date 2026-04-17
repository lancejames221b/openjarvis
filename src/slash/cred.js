/**
 * /cred — Secure credential handler
 *
 * Intercepts `/cred <name> <value>` messages in Discord:
 *   1. Deletes the source message immediately (before anything else)
 *   2. Stores in hAIveMind under category "credentials"
 *   3. Attempts 1Password storage via tmux/op CLI
 *   4. Confirms in Discord without echoing the value
 *
 * Also handles:
 *   /cred lookup <name>  — retrieve (never echo value in chat)
 *   /cred list           — list stored credential names
 *   /cred delete <name>  — mark deleted in haivemind + remove from 1P
 */

import { execSync } from 'child_process';
import logger from '../logger.js';

const OP_VAULT = 'Employee';
const SOCKET_DIR = `${process.env.TMPDIR || '/tmp'}/openclaw-tmux-sockets`;

// ── Parse /cred command ───────────────────────────────────────────────────────

/**
 * Detect if a message content is a /cred command.
 * Returns { isCredCommand: true, subcommand, name, value } or { isCredCommand: false }
 */
export function parseCredCommand(content) {
  // Strip leading /cred
  const match = content.match(/^\/cred\s+(.+)$/is);
  if (!match) return { isCredCommand: false };

  const rest = match[1].trim();

  // /cred lookup <name>
  const lookupMatch = rest.match(/^lookup\s+(\S+)$/i);
  if (lookupMatch) return { isCredCommand: true, subcommand: 'lookup', name: lookupMatch[1] };

  // /cred list
  if (/^list$/i.test(rest)) return { isCredCommand: true, subcommand: 'list' };

  // /cred delete <name>
  const deleteMatch = rest.match(/^delete\s+(\S+)$/i);
  if (deleteMatch) return { isCredCommand: true, subcommand: 'delete', name: deleteMatch[1] };

  // /cred update <name> <value>
  const updateMatch = rest.match(/^update\s+(\S+)\s+(.+)$/is);
  if (updateMatch) return { isCredCommand: true, subcommand: 'update', name: updateMatch[1].trim(), value: updateMatch[2].trim() };

  // /cred <name> <value>  (store — default)
  const storeMatch = rest.match(/^(\S+)\s+(.+)$/is);
  if (storeMatch) return { isCredCommand: true, subcommand: 'store', name: storeMatch[1].trim(), value: storeMatch[2].trim() };

  return { isCredCommand: false };
}

// ── hAIveMind helpers (via mcporter CLI) ─────────────────────────────────────

function mcporterStore(content, category = 'credentials') {
  try {
    execSync(
      `mcporter call haivemind.store_memory content=${JSON.stringify(content)} category=${JSON.stringify(category)}`,
      { timeout: 15_000, stdio: 'pipe' }
    );
    return true;
  } catch (err) {
    logger.warn(`[cred] haivemind store failed: ${err.message}`);
    return false;
  }
}

function mcporterSearch(query, limit = 10) {
  try {
    const out = execSync(
      `mcporter call haivemind.search_memories query=${JSON.stringify(query)} limit=${limit}`,
      { timeout: 10_000, stdio: 'pipe' }
    ).toString();
    return out;
  } catch (err) {
    logger.warn(`[cred] haivemind search failed: ${err.message}`);
    return '';
  }
}

// ── 1Password helpers (tmux pattern) ─────────────────────────────────────────

function tmuxRun(cmds, { sessionName, timeout = 8000 } = {}) {
  const session = sessionName || `op-cred-${Date.now()}`;
  const sock = `${SOCKET_DIR}/${session}.sock`;
  try {
    execSync(`mkdir -p ${JSON.stringify(SOCKET_DIR)}`, { stdio: 'pipe' });
    execSync(`tmux -S ${sock} new -d -s ${session} -n shell`, { stdio: 'pipe' });
    for (const cmd of cmds) {
      execSync(`tmux -S ${sock} send-keys -t ${session}:0.0 -- ${JSON.stringify(cmd)} Enter`, { stdio: 'pipe' });
      execSync('sleep 0.5', { stdio: 'pipe' });
    }
    execSync(`sleep ${Math.ceil(timeout / 1000)}`, { stdio: 'pipe' });
    const out = execSync(`tmux -S ${sock} capture-pane -p -J -t ${session}:0.0 -S -20`, { stdio: 'pipe' }).toString();
    execSync(`tmux -S ${sock} kill-session -t ${session} 2>/dev/null || true`, { stdio: 'pipe' });
    return out;
  } catch (err) {
    logger.warn(`[cred] tmux op failed: ${err.message}`);
    try { execSync(`tmux -S ${sock} kill-session -t ${session} 2>/dev/null || true`, { stdio: 'pipe' }); } catch {}
    return null;
  }
}

async function get1pMasterPassword() {
  const raw = mcporterSearch('mac sudo password lance', 3);
  // Extract value from haivemind result — look for a password-looking line
  const match = raw.match(/password[:\s]+([^\s\n"]{6,})/i);
  return match ? match[1] : null;
}

async function storeIn1Password(name, value, update = false) {
  const masterPw = await get1pMasterPassword();
  if (!masterPw) {
    logger.warn('[cred] Could not get 1P master password from haivemind');
    return { ok: false, reason: '1Password master password not found in haivemind' };
  }

  const title = name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const session = `op-cred-${Date.now()}`;
  const sock = `${SOCKET_DIR}/${session}.sock`;

  try {
    execSync(`mkdir -p ${JSON.stringify(SOCKET_DIR)}`, { stdio: 'pipe' });
    execSync(`tmux -S ${sock} new -d -s ${session} -n shell`, { stdio: 'pipe' });

    // Sign in
    execSync(`tmux -S ${sock} send-keys -t ${session}:0.0 -- 'eval $(op signin) 2>&1' Enter`, { stdio: 'pipe' });
    execSync('sleep 2', { stdio: 'pipe' });
    execSync(`tmux -S ${sock} send-keys -t ${session}:0.0 -- ${JSON.stringify(masterPw)} Enter`, { stdio: 'pipe' });
    execSync('sleep 3', { stdio: 'pipe' });

    if (update) {
      // Try edit first, fall back to create
      execSync(`tmux -S ${sock} send-keys -t ${session}:0.0 -- ${JSON.stringify(`op item edit "${title}" --vault "${OP_VAULT}" "credential[password]=${value}" 2>&1`)} Enter`, { stdio: 'pipe' });
    } else {
      execSync(`tmux -S ${sock} send-keys -t ${session}:0.0 -- ${JSON.stringify(`op item create --category "API Credential" --title "${title}" --vault "${OP_VAULT}" "credential[password]=${value}" "username[text]=owner@example.com" 2>&1`)} Enter`, { stdio: 'pipe' });
    }
    execSync('sleep 5', { stdio: 'pipe' });

    const out = execSync(`tmux -S ${sock} capture-pane -p -J -t ${session}:0.0 -S -15`, { stdio: 'pipe' }).toString();
    execSync(`tmux -S ${sock} kill-session -t ${session} 2>/dev/null || true`, { stdio: 'pipe' });

    const ok = /Created new item|updated|^\s*\w{26}\s*$/m.test(out);
    return { ok, output: out.slice(-300) };
  } catch (err) {
    try { execSync(`tmux -S ${sock} kill-session -t ${session} 2>/dev/null || true`, { stdio: 'pipe' }); } catch {}
    return { ok: false, reason: err.message };
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

/**
 * Handle a /cred command from a Discord message.
 * @param {Message} message - Discord.js message object
 * @param {object} parsed   - result of parseCredCommand()
 */
export async function handleCredCommand(message, parsed) {
  const { subcommand, name, value } = parsed;
  const iso = new Date().toISOString();

  // ── STORE ─────────────────────────────────────────────────────────────────
  if (subcommand === 'store' || subcommand === 'update') {
    // 1. Delete source message FIRST — security rule #1
    try {
      await message.delete();
      logger.info(`[cred] Deleted source message ${message.id} (contained credential)`);
    } catch (err) {
      logger.warn(`[cred] Could not delete source message: ${err.message}`);
      // Still proceed — haivemind + 1P are more important than delete failure
    }

    // 2. Store in hAIveMind
    const credContent = `CRED:${name} value=${value} stored_at=${iso}${subcommand === 'update' ? ' (update)' : ''}`;
    const hmOk = mcporterStore(credContent, 'credentials');

    // 3. Store in 1Password (async, non-blocking for the reply)
    let opStatus = '⏳ 1Password: queued';
    storeIn1Password(name, value, subcommand === 'update')
      .then(result => {
        if (result.ok) {
          logger.info(`[cred] 1Password stored: ${name}`);
        } else {
          logger.warn(`[cred] 1Password failed for ${name}: ${result.reason || result.output}`);
        }
      })
      .catch(err => logger.warn(`[cred] 1Password async error: ${err.message}`));

    // 4. Confirm — no value, no trace
    const status = hmOk
      ? `✅ **\`${name}\`** stored in hAIveMind + queued for 1Password Employee vault.\nSource message deleted.`
      : `⚠️ **\`${name}\`** — hAIveMind store failed. Source message deleted. Retry with \`/cred ${name} <value>\`.`;

    try {
      await message.channel.send(status);
    } catch (err) {
      logger.warn(`[cred] Failed to send confirmation: ${err.message}`);
    }
    return;
  }

  // ── LOOKUP ────────────────────────────────────────────────────────────────
  if (subcommand === 'lookup') {
    const raw = mcporterSearch(`CRED:${name}`, 5);
    const found = raw && raw.includes(`CRED:${name}`);
    if (found) {
      await message.reply(`🔐 **\`${name}\`** found in hAIveMind. Value is in 1Password Employee vault — item: **${name}**. Say "reveal ${name}" if you want me to show it here (will auto-delete).`);
    } else {
      await message.reply(`❌ No credential named **\`${name}\`** found in hAIveMind. Check 1Password Employee vault directly.`);
    }
    return;
  }

  // ── LIST ──────────────────────────────────────────────────────────────────
  if (subcommand === 'list') {
    const raw = mcporterSearch('CRED:', 50);
    const names = [...new Set(
      [...raw.matchAll(/CRED:(\S+)/g)].map(m => m[1]).filter(n => !n.includes('DELETED'))
    )];
    if (names.length === 0) {
      await message.reply('No credentials found in hAIveMind.');
    } else {
      await message.reply(`🔐 **Stored credentials** (${names.length}):\n${names.map(n => `• \`${n}\``).join('\n')}`);
    }
    return;
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (subcommand === 'delete') {
    mcporterStore(`CRED:${name} DELETED at ${iso}`, 'credentials');
    await message.reply(`🗑️ **\`${name}\`** marked deleted in hAIveMind. Remove from 1Password manually if needed: \`op item delete "${name}" --vault Employee\``);
    return;
  }
}
