/**
 * /shell and /dir — owner-only shell execution and working directory management.
 *
 * /dir              — show current working directory (on active box)
 * /dir <path>       — change working directory (on active box)
 * /shell <command>  — run a shell command in the current working directory (on active box)
 *
 * The active box is set via /box. On generic (local) commands run via exec().
 * On mac/games they run via SSH using the SSH config alias.
 *
 * Auth: ALLOWED_USERS[0] only (the bot owner).
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { getBox, getCwd, setCwd, listBoxes } from './box-state.js';
import { isSessionChannel } from './session.js';
import logger from '../logger.js';

const execAsync = promisify(exec);

const SHELL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 1_900;

function _truncate(s) {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT - 40) + `\n…(truncated ${s.length - MAX_OUTPUT + 40} chars)`;
}

/**
 * Run a command either locally or on the active remote box via SSH.
 * Returns { stdout, stderr } like execAsync.
 */
async function _run(command) {
  const box = getBox();
  const cwd = getCwd();

  if (box.isLocal) {
    return execAsync(command, { cwd, timeout: SHELL_TIMEOUT_MS, shell: '/bin/bash' });
  }

  // Remote: ssh <alias> "cd <cwd> && <command>"
  // JSON.stringify handles double-quote escaping inside the SSH argument.
  const fullCmd = `cd ${JSON.stringify(cwd)} && ${command}`;
  return execAsync(
    `ssh -o ConnectTimeout=15 -o BatchMode=yes ${box.ssh} ${JSON.stringify(fullCmd)}`,
    { timeout: SHELL_TIMEOUT_MS + 15_000, shell: '/bin/bash' }
  );
}

/**
 * Check whether a path exists on the active box.
 * Returns true/false.
 */
async function _dirExists(path) {
  const box = getBox();
  if (box.isLocal) return existsSync(path);
  try {
    const { stdout } = await execAsync(
      `ssh -o ConnectTimeout=10 -o BatchMode=yes ${box.ssh} ${JSON.stringify(`test -d ${JSON.stringify(path)} && echo ok`)}`,
      { timeout: 12_000, shell: '/bin/bash' }
    );
    return stdout.trim() === 'ok';
  } catch {
    return false;
  }
}

export async function handleDirCommand(interaction, allowedUsers) {
  if (interaction.user.id !== allowedUsers[0]) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true });
    return;
  }

  const box = getBox();
  const path = interaction.options.getString('path');

  if (!path) {
    const target = box.isLocal ? 'local' : box.ssh;
    const sessionActive = isSessionChannel(interaction.channelId);
    const boxes = listBoxes();
    const boxLine = boxes.map(b =>
      `${b.active ? '▶' : '  '} **${b.name}** (${b.isLocal ? 'local' : b.ssh})`
    ).join('\n');
    await interaction.reply({
      content: [
        `**Box:** \`${box.name}\` — ${target}`,
        `**Cwd:** \`${getCwd()}\``,
        sessionActive ? `**Session:** active in this thread` : null,
        `\n**All boxes:**\n${boxLine}`,
      ].filter(Boolean).join('\n'),
      ephemeral: false,
    });
    return;
  }

  // For local: resolve relative paths. For remote: absolute only (or leave as-is and SSH validates).
  const target = box.isLocal ? resolve(getCwd(), path) : path;

  await interaction.deferReply({ ephemeral: false });

  if (!await _dirExists(target)) {
    await interaction.editReply(`Directory not found on **${box.label}**: \`${target}\``);
    return;
  }

  setCwd(target);
  logger.info(`[shell] /dir changed to ${target} on ${box.name}`);
  await interaction.editReply(`**${box.label}** — working directory set to \`${target}\``);
}

export async function handleShellCommand(interaction, allowedUsers) {
  if (interaction.user.id !== allowedUsers[0]) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true });
    return;
  }

  const command = interaction.options.getString('command');
  if (!command) {
    await interaction.reply({ content: 'Command is required.', ephemeral: true });
    return;
  }

  const box = getBox();
  await interaction.deferReply({ ephemeral: false });
  logger.info(`[shell] executing on ${box.name} in ${getCwd()}: ${command}`);

  try {
    const { stdout, stderr } = await _run(command);
    const out = (stdout + stderr).trim() || '(no output)';
    const display = _truncate(out);
    await interaction.editReply(`\`\`\`\n[${box.name}] $ ${command}\n${display}\n\`\`\``);
  } catch (err) {
    const out = ((err.stdout || '') + (err.stderr || '') + (err.message || '')).trim();
    const display = _truncate(out) || err.message;
    await interaction.editReply(`\`\`\`\n[${box.name}] $ ${command}\n[exit ${err.code ?? '?'}] ${display}\n\`\`\``);
  }
}
