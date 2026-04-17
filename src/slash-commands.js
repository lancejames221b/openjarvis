/**
 * Slash Commands — /visual, /spawn, /stop
 *
 * Registers and handles Discord slash commands for the voice bot.
 */

import { SlashCommandBuilder, REST, Routes } from 'discord.js';
import { isVisualModeEnabled, setVisualMode, getVisualTargetChannel, setVisualTargetChannel } from './visual-mode.js';
import { setFocusByName } from './focus-state.js';
import { handleSpawnCommand, handleStopCommand } from './slash/spawn.js';
import { parseCredCommand, handleCredCommand } from './slash/cred.js';
import logger from './logger.js';

const SPAWN_CMD = new SlashCommandBuilder()
  .setName('spawn')
  .setDescription('Spawn a dedicated cursor-agent session in a new thread')
  .addStringOption(opt =>
    opt.setName('prompt').setDescription('Task or prompt for the agent').setRequired(true));

const STOP_CMD = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop the active agent in this thread');

const CRED_CMD = new SlashCommandBuilder()
  .setName('cred')
  .setDescription('Store a credential securely (message auto-deleted)')
  .addStringOption(opt =>
    opt.setName('name').setDescription('Credential name / label').setRequired(true))
  .addStringOption(opt =>
    opt.setName('value').setDescription('Credential value (key, token, password)').setRequired(true));

const VISUAL_CMD = new SlashCommandBuilder()
  .setName('visual')
  .setDescription('Toggle visual mode — responses go to text instead of voice')
  .addSubcommand(sub =>
    sub.setName('on').setDescription('Enable visual mode'))
  .addSubcommand(sub =>
    sub.setName('off').setDescription('Disable visual mode (back to voice)'))
  .addSubcommand(sub =>
    sub.setName('status').setDescription('Check current visual mode state'))
  .addSubcommand(sub =>
    sub.setName('channel')
      .setDescription('Set the target channel for visual output')
      .addStringOption(opt =>
        opt.setName('name').setDescription('Channel name (e.g. gibson, pr-reviews)').setRequired(true)));

/**
 * Register slash commands with Discord API
 */
export async function registerSlashCommands(client) {
  const rest = new REST({ version: '10' }).setToken(client.token);
  try {
    const guildId = client.guilds.cache.first()?.id;
    if (!guildId) {
      logger.warn('[slash] No guild found, skipping command registration');
      return;
    }
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guildId),
      { body: [VISUAL_CMD.toJSON(), SPAWN_CMD.toJSON(), STOP_CMD.toJSON(), CRED_CMD.toJSON()] }
    );
    logger.info('[slash] Registered /visual, /spawn, /stop, /cred commands');
  } catch (err) {
    logger.error(`[slash] Failed to register commands: ${err.message}`);
  }
}

/**
 * Handle incoming slash command interactions
 */
export async function handleSlashCommand(interaction, allowedUsers) {
  if (!interaction.isChatInputCommand()) return false;

  if (interaction.commandName === 'spawn') {
    if (!allowedUsers.includes(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    await handleSpawnCommand(interaction);
    return true;
  }

  if (interaction.commandName === 'stop') {
    if (!allowedUsers.includes(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    await handleStopCommand(interaction);
    return true;
  }

  if (interaction.commandName === 'cred') {
    if (!allowedUsers.includes(interaction.user.id)) {
      await interaction.reply({ content: '🚫 Not authorized.', ephemeral: true });
      return true;
    }
    const name = interaction.options.getString('name');
    const value = interaction.options.getString('value');
    // Defer ephemerally — slash command interactions auto-delete the invocation
    await interaction.deferReply({ ephemeral: true });
    // Build a fake parsed object matching handleCredCommand's expectation
    const parsed = { isCredCommand: true, subcommand: 'store', name, value };
    // For slash commands the interaction itself is ephemeral, so no message to delete.
    // Pass a fake message-like object that no-ops on delete().
    const fakeMessage = {
      id: interaction.id,
      channel: { send: (content) => interaction.followUp({ content, ephemeral: true }) },
      reply: (content) => interaction.followUp({ content, ephemeral: true }),
      delete: async () => {},
    };
    await handleCredCommand(fakeMessage, parsed);
    return true;
  }

  if (interaction.commandName !== 'visual') return false;

  // Auth check — only allowed users
  if (!allowedUsers.includes(interaction.user.id)) {
    await interaction.reply({ content: '🚫 Not authorized.', ephemeral: true });
    return true;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'on') {
    setVisualMode(true);
    await interaction.reply({ content: '🖥️ **Visual mode ON** — at-desk mode. Text output, always listening, auto-open on Mac.', ephemeral: false });
    return true;
  }

  if (sub === 'off') {
    setVisualMode(false);
    setVisualTargetChannel(null);
    await interaction.reply({ content: '🔊 **Visual mode OFF** — back to voice output. Sleep timers re-armed.', ephemeral: false });
    return true;
  }

  if (sub === 'status') {
    const enabled = isVisualModeEnabled();
    const target = getVisualTargetChannel();
    const status = enabled
      ? `🖥️ **Visual mode is ON** (at-desk)${target ? ` → <#${target}>` : ' (default channel)'} — always listening, auto-open on Mac`
      : '🔊 **Visual mode is OFF** — voice output active, normal sleep timers';
    await interaction.reply({ content: status, ephemeral: true });
    return true;
  }

  if (sub === 'channel') {
    const name = interaction.options.getString('name');
    const result = setFocusByName(name);
    if (result) {
      setVisualMode(true);
      setVisualTargetChannel(result.channelId);
      await interaction.reply({ content: `🖥️ **Visual mode ON** → <#${result.channelId}> (${result.channelName})`, ephemeral: false });
    } else {
      await interaction.reply({ content: `❌ Channel "${name}" not found in registry.`, ephemeral: true });
    }
    return true;
  }

  return false;
}
