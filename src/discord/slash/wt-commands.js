import { listActiveWorktrees, removeWorktree } from '../../agent/worktree-manager.js';

/**
 * /wt status — list all active tracked worktrees with their channelKey mappings.
 */
export async function handleWtStatusCommand(interaction) {
  const entries = listActiveWorktrees();

  if (!entries.length) {
    return interaction.reply({ content: 'No active worktrees.', ephemeral: true });
  }

  const lines = entries.map((e) => {
    const key = e.threadId ? `${e.channelId}:${e.threadId}` : `${e.channelId}:_channel_`;
    return `\`${key}\` → \`${e.path}\` (${e.branch})`;
  });

  return interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

/**
 * /wt clean — remove worktrees whose Discord threads no longer exist.
 *
 * @param {object} interaction - Discord interaction
 * @param {object} client - Discord.js Client (used to fetch channels)
 */
export async function handleWtCleanCommand(interaction, client) {
  const entries = listActiveWorktrees();
  const removed = [];

  for (const e of entries) {
    if (!e.threadId) continue;
    try {
      await client.channels.fetch(e.threadId);
    } catch {
      await removeWorktree(e.channelId, e.threadId);
      removed.push(`${e.channelId}:${e.threadId}`);
    }
  }

  const content = removed.length
    ? `Cleaned ${removed.length} stale worktree(s): ${removed.join(', ')}`
    : 'No stale worktrees to clean.';

  return interaction.reply({ content, ephemeral: true });
}
