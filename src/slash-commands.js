/**
 * Slash Commands — /visual, /spawn, /stop
 *
 * Registers and handles Discord slash commands for the voice bot.
 */

import { SlashCommandBuilder, REST, Routes } from 'discord.js';
import { isVisualModeEnabled, setVisualMode, getVisualTargetChannel, setVisualTargetChannel } from './visual-mode.js';
import { isVerboseModeEnabled, setVerboseMode } from './verbose-mode.js';
import { getVoiceModel, setVoiceModel } from './brain.js';
import { readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __slashDirname = dirname(fileURLToPath(import.meta.url));
const _ENV_FILE = `${__slashDirname}/../.env`;
const KNOWN_MODELS = ['claude', 'sonnet', 'opus', 'haiku'];

function _persistModel(alias) {
  try {
    let env = readFileSync(_ENV_FILE, 'utf-8');
    const line = `VOICE_MODEL=${alias}`;
    env = env.match(/^VOICE_MODEL=.*/m) ? env.replace(/^VOICE_MODEL=.*/m, line) : env + `\n${line}`;
    writeFileSync(_ENV_FILE, env, 'utf-8');
  } catch { /* non-fatal */ }
}
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

const MODEL_CMD = new SlashCommandBuilder()
  .setName('model')
  .setDescription('Switch the active voice model')
  .addSubcommand(sub => sub.setName('list').setDescription('Show available model aliases'))
  .addSubcommand(sub =>
    sub.setName('set')
      .setDescription('Switch to a model alias')
      .addStringOption(opt =>
        opt.setName('name')
          .setDescription('Model alias: claude, sonnet, opus, haiku')
          .setRequired(true)
          .addChoices(
            { name: 'claude (sonnet, default)', value: 'claude' },
            { name: 'sonnet', value: 'sonnet' },
            { name: 'opus (heavy tasks)', value: 'opus' },
            { name: 'haiku (fast/light)', value: 'haiku' },
          )))
  .addSubcommand(sub => sub.setName('status').setDescription('Show current active model'));

const VERBOSE_CMD = new SlashCommandBuilder()
  .setName('verbose')
  .setDescription('Stream text channel responses to a live thread to watch activity in real-time')
  .addSubcommand(sub => sub.setName('on').setDescription('Enable verbose mode'))
  .addSubcommand(sub => sub.setName('off').setDescription('Disable verbose mode'))
  .addSubcommand(sub => sub.setName('status').setDescription('Check current verbose mode state'));

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
      { body: [VISUAL_CMD.toJSON(), VERBOSE_CMD.toJSON(), MODEL_CMD.toJSON(), SPAWN_CMD.toJSON(), STOP_CMD.toJSON(), CRED_CMD.toJSON()] }
    );
    logger.info('[slash] Registered /visual, /verbose, /model, /spawn, /stop, /cred commands');
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

  if (interaction.commandName === 'model') {
    if (!allowedUsers.includes(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const current = getVoiceModel();
      const lines = KNOWN_MODELS.map(m => `${m === current ? '▶' : '·'} **${m}**`).join('\n');
      await interaction.reply({ content: `**Available models:**\n${lines}`, ephemeral: true });
    } else if (sub === 'set') {
      const name = interaction.options.getString('name');
      if (!KNOWN_MODELS.includes(name)) {
        await interaction.reply({ content: `Unknown model \`${name}\`. Choose: ${KNOWN_MODELS.join(', ')}`, ephemeral: true });
        return true;
      }
      setVoiceModel(name);
      _persistModel(name);
      await interaction.reply({ content: `🔄 Voice model switched to **${name}**`, ephemeral: false });
    } else if (sub === 'status') {
      await interaction.reply({ content: `Active model: **${getVoiceModel()}**`, ephemeral: true });
    }
    return true;
  }

  if (interaction.commandName === 'verbose') {
    if (!allowedUsers.includes(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'on') {
      setVerboseMode(true);
      await interaction.reply({ content: '📡 **Verbose mode ON** — text channel responses stream live to a thread.', ephemeral: false });
    } else if (sub === 'off') {
      setVerboseMode(false);
      await interaction.reply({ content: '🔇 **Verbose mode OFF** — normal replies.', ephemeral: false });
    } else if (sub === 'status') {
      const on = isVerboseModeEnabled();
      await interaction.reply({ content: on ? '📡 **Verbose mode is ON** — text responses stream to threads.' : '🔇 **Verbose mode is OFF**', ephemeral: true });
    }
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
