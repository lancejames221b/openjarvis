import { getWorktreeEntry, cleanupWorktree, listActiveWorktrees } from './worktree-manager.js';
import logger from '../logger.js';

export async function handleWtStatusCommand(interaction) {
  const channelId = interaction.channelId;
  const channel = interaction.channel;
  const parentId = channel?.isThread?.() ? (channel.parentId ?? channelId) : channelId;
  const threadId = channel?.isThread?.() ? channelId : null;

  const entries = listActiveWorktrees().filter(e => e.channelId === parentId);
  if (entries.length === 0) {
    await interaction.reply({ content: 'No active worktrees for this channel.', ephemeral: true });
    return;
  }

  const lines = entries.map(e => {
    const marker = e.threadId === threadId ? '→' : ' ';
    const age = Math.round((Date.now() - e.createdAt) / 60_000);
    return `${marker} \`${e.branch}\`  at  \`${e.path}\`  (${age}m ago)`;
  });
  await interaction.reply({
    content: `**Active worktrees for this channel:**\n${lines.join('\n')}`,
    ephemeral: true,
  });
}

export async function handleWtCleanCommand(interaction) {
  const channelId = interaction.channelId;
  const channel = interaction.channel;
  const parentId = channel?.isThread?.() ? (channel.parentId ?? channelId) : channelId;
  const threadId = channel?.isThread?.() ? channelId : null;
  const force = interaction.options.getBoolean('force') ?? false;

  if (!threadId) {
    await interaction.reply({
      content: 'Run `/wt-clean` from inside a spawn thread to remove its worktree.',
      ephemeral: true,
    });
    return;
  }

  const entry = getWorktreeEntry(parentId, threadId);
  if (!entry) {
    await interaction.reply({ content: 'No worktree tracked for this thread.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    await cleanupWorktree(parentId, threadId, { force });
  } catch (err) {
    logger.warn(`[wt-clean] cleanup failed: ${err.message}`);
    await interaction.editReply(`Cleanup failed: ${err.message}`);
    return;
  }

  const stillTracked = getWorktreeEntry(parentId, threadId);
  if (stillTracked) {
    await interaction.editReply(
      'Worktree has uncommitted changes — preserved. Use `/wt-clean force:true` to discard and remove.',
    );
  } else {
    await interaction.editReply(
      `Worktree removed. Branch \`${entry.branch}\` is kept — delete manually when done reviewing.`,
    );
  }
}
