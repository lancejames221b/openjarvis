/**
 * /register-channel — create a Discord text channel under a category and
 * write a basic entry into channel-registry.json. Pure-slash counterpart to
 * the natural-language `tryChannelDispatch()` intent in channel-dispatch.js.
 *
 * Use this when you want the explicit form instead of the spoken form.
 * For Kanban-linked project channels, see /new-kanban-channel instead.
 */

import { ChannelType } from 'discord.js';
import logger from '../../logger.js';
import { resolveCategory, createAndRegisterChannel } from '../channel-dispatch.js';

export async function handleRegisterChannelCommand(interaction) {
  const rawName = interaction.options.getString('name');
  const categoryOpt = interaction.options.getChannel('category', false);
  const categoryNameStr = interaction.options.getString('category-name', false);

  if (!rawName) {
    await interaction.reply({ content: '❌ name is required', ephemeral: true });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: '❌ no guild context', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    await interaction.editReply('❌ DISCORD_TOKEN not configured.');
    return;
  }

  // Slugify the channel name (allow user to say "Demos" → "demos")
  const name = rawName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  if (!name) {
    await interaction.editReply(`❌ Could not slugify name "${rawName}".`);
    return;
  }

  // Resolve category: either explicit channel option (must be type 4) or by name.
  let categoryId, categoryName;
  if (categoryOpt) {
    if (categoryOpt.type !== ChannelType.GuildCategory) {
      await interaction.editReply(`❌ \`${categoryOpt.name}\` is not a category.`);
      return;
    }
    categoryId = categoryOpt.id;
    categoryName = categoryOpt.name;
  } else if (categoryNameStr) {
    let cat;
    try {
      cat = await resolveCategory(guild.id, categoryNameStr, token);
    } catch (err) {
      logger.error(`[register-channel] resolveCategory failed: ${err.message}`);
      await interaction.editReply(`❌ Failed to list guild categories: ${err.message}`);
      return;
    }
    if (!cat) {
      await interaction.editReply(`❌ No category matching "${categoryNameStr}" found in this guild.`);
      return;
    }
    categoryId = cat.id;
    categoryName = cat.name;
  } else {
    await interaction.editReply('❌ Provide either `category` (picker) or `category-name` (string).');
    return;
  }

  try {
    const created = await createAndRegisterChannel({
      guildId: guild.id,
      name,
      categoryId,
      categoryName,
      token,
    });
    await interaction.editReply(
      `✅ Created <#${created.channelId}> under **${categoryName}** and wrote channel-registry entry.`,
    );
  } catch (err) {
    logger.error(`[register-channel] failed: ${err.message}`);
    await interaction.editReply(`❌ Failed to create channel: ${err.message}`);
  }
}
