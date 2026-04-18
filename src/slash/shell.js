/**
 * /shell and /dir — owner-only shell execution and working directory management.
 *
 * /dir              — show current working directory
 * /dir <path>       — change working directory
 * /shell <command>  — run a shell command in the current working directory
 *
 * Auth: ALLOWED_USERS[0] only (the bot owner). No other users, even if in ALLOWED_USERS.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { resolve } from 'path';
import logger from '../logger.js';

const execAsync = promisify(exec);

const SHELL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 1_900;

// Working directory — defaults to the bot process cwd, persists across commands in the session.
let _cwd = process.cwd();

function _truncate(s) {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT - 40) + `\n…(truncated ${s.length - MAX_OUTPUT + 40} chars)`;
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string[]} allowedUsers
 */
export async function handleDirCommand(interaction, allowedUsers) {
  if (interaction.user.id !== allowedUsers[0]) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true });
    return;
  }

  const path = interaction.options.getString('path');

  if (!path) {
    await interaction.reply({ content: `\`${_cwd}\``, ephemeral: false });
    return;
  }

  const target = resolve(_cwd, path);
  if (!existsSync(target)) {
    await interaction.reply({ content: `Directory not found: \`${target}\``, ephemeral: true });
    return;
  }

  _cwd = target;
  logger.info(`[shell] /dir changed to ${_cwd}`);
  await interaction.reply({ content: `Working directory set to \`${_cwd}\``, ephemeral: false });
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string[]} allowedUsers
 */
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

  await interaction.deferReply({ ephemeral: false });
  logger.info(`[shell] executing in ${_cwd}: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: _cwd,
      timeout: SHELL_TIMEOUT_MS,
      shell: '/bin/bash',
    });

    const out = (stdout + stderr).trim() || '(no output)';
    const display = _truncate(out);
    await interaction.editReply(`\`\`\`\n$ ${command}\n${display}\n\`\`\``);
  } catch (err) {
    const out = ((err.stdout || '') + (err.stderr || '') + (err.message || '')).trim();
    const display = _truncate(out) || err.message;
    await interaction.editReply(`\`\`\`\n$ ${command}\n[exit ${err.code ?? '?'}] ${display}\n\`\`\``);
  }
}
