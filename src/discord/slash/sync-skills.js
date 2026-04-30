/**
 * /sync-skills — rsync allowlisted skills from gamez to generic.
 *
 * Shells to ~/.local/bin/sync-skills-to-generic on the gateway host.
 * Returns the summary output to Discord (ephemeral).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '../../logger.js';

const execFileAsync = promisify(execFile);

const SYNC_BIN = process.env.JARVIS_SYNC_SKILLS_BIN
  || `${process.env.HOME}/.local/bin/sync-skills-to-generic`;

export async function handleSyncSkillsCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    // No arguments — the script reads the allowlist from a fixed path.
    const { stdout, stderr } = await execFileAsync(SYNC_BIN, [], {
      timeout: 60_000,
      maxBuffer: 1 * 1024 * 1024,
    });
    const combined = (stdout + stderr).trim();
    const summary = combined.length > 1800
      ? combined.substring(combined.length - 1800)  // keep the tail (summary line)
      : combined;
    await interaction.editReply({
      content: `\`\`\`\n${summary || '(no output)'}\n\`\`\``,
    });
  } catch (err) {
    logger.error(`[/sync-skills] failed: ${err.message}`);
    await interaction.editReply({
      content: `sync-skills failed: \`${err.message}\``,
    });
  }
}
