/**
 * Slash Commands — /visual, /spawn, /stop
 *
 * Registers and handles Discord slash commands for the voice bot.
 */

import { SlashCommandBuilder, REST, Routes } from 'discord.js';
import { isVisualModeEnabled, setVisualMode, getVisualTargetChannel, setVisualTargetChannel } from './visual-mode.js';
import { isVerboseModeEnabled, setVerboseMode, enableVerboseForThread, disableVerboseForThread, clearThreadVerboseOverride } from './verbose-mode.js';
import { getVoiceModel, setVoiceModel } from './brain.js';
import { getChannelModel, setChannelModel, clearChannelModel } from './channel-models.js';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const _execAsync = promisify(exec);

const __slashDirname = dirname(fileURLToPath(import.meta.url));
const _ENV_FILE = `${__slashDirname}/../.env`;
const _DEFAULT_VOICE_MODEL = process.env.VOICE_MODEL || 'sonnet';
// Base + effort-suffixed variants. `claude` omitted (alias to sonnet, redundant).
const KNOWN_MODELS = [
  'sonnet', 'sonnet-high', 'sonnet-max',
  'opus', 'opus-high', 'opus-max', 'opus-plan',
  'haiku', 'haiku-low',
];

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
import { handleDirCommand, handleShellCommand } from './slash/shell.js';
import { handleSkillCommand, listSkills } from './slash/skill.js';
import { getBox, setBox, listBoxes, getCwd, persistBoxState, BOX_NAMES } from './slash/box-state.js';
import { isOwner as isChannelOwner, grantAccess, revokeAccess, listAccess } from './channel-access.js';
import { handleSessionCommand, startSessionDirect, buildResumeCommand } from './slash/session.js';
import { findProjectMapByName } from './slash/project-map.js';
import logger from './logger.js';

const SPAWN_CMD = new SlashCommandBuilder()
  .setName('spawn')
  .setDescription('Spawn a dedicated agent session in a new thread')
  .addStringOption(opt =>
    opt.setName('prompt').setDescription('Task or prompt for the agent').setRequired(true))
  .addAttachmentOption(opt =>
    opt.setName('file').setDescription('File or image to include with the prompt').setRequired(false))
  .addStringOption(opt =>
    opt.setName('model')
      .setDescription('Model override (default: auto-selected by prompt keywords)')
      .setRequired(false)
      .addChoices(
        { name: 'claude (default)', value: 'claude' },
        { name: 'sonnet', value: 'sonnet' },
        { name: 'opus (deep/heavy tasks)', value: 'opus' },
        { name: 'haiku (fast/light)', value: 'haiku' },
      ));

const STOP_CMD = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop the active agent in this thread');

const DIR_CMD = new SlashCommandBuilder()
  .setName('dir')
  .setDescription('Show or change the working directory for shell commands (owner only)')
  .addStringOption(opt =>
    opt.setName('path').setDescription('Directory to change to (omit to show current)').setRequired(false));

const SHELL_CMD = new SlashCommandBuilder()
  .setName('shell')
  .setDescription('Run a shell command in the current working directory (owner only)')
  .addStringOption(opt =>
    opt.setName('command').setDescription('Shell command to execute').setRequired(true));

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
          .setDescription('Model + effort (e.g. opus-high, sonnet-max)')
          .setRequired(true)
          .addChoices(
            { name: 'sonnet (default)', value: 'sonnet' },
            { name: 'sonnet-high', value: 'sonnet-high' },
            { name: 'sonnet-max', value: 'sonnet-max' },
            { name: 'opus', value: 'opus' },
            { name: 'opus-high', value: 'opus-high' },
            { name: 'opus-max', value: 'opus-max' },
            { name: 'opus-plan (deep reasoning)', value: 'opus-plan' },
            { name: 'haiku (fast)', value: 'haiku' },
            { name: 'haiku-low (fastest)', value: 'haiku-low' },
          ))
      .addBooleanOption(opt =>
        opt.setName('global').setDescription('Change global default instead of pinning to this thread/channel')))
  .addSubcommand(sub => sub.setName('clear').setDescription('Clear per-thread/channel pin and fall back to global'))
  .addSubcommand(sub => sub.setName('status').setDescription('Show current active model'));

const VERBOSE_CMD = new SlashCommandBuilder()
  .setName('verbose')
  .setDescription('Stream text channel responses to a live thread to watch activity in real-time')
  .addSubcommand(sub =>
    sub.setName('on').setDescription('Enable verbose mode')
      .addBooleanOption(opt =>
        opt.setName('global').setDescription('Change global default instead of this thread')))
  .addSubcommand(sub =>
    sub.setName('off').setDescription('Disable verbose mode')
      .addBooleanOption(opt =>
        opt.setName('global').setDescription('Change global default instead of this thread')))
  .addSubcommand(sub => sub.setName('clear').setDescription('Remove thread override (fall back to global)'))
  .addSubcommand(sub => sub.setName('status').setDescription('Check current verbose mode state'));

const MCP_CMD = new SlashCommandBuilder()
  .setName('mcp')
  .setDescription('Toggle full MCP capability per channel/thread (tools: notion, gcal, slack, etc.)')
  .addSubcommand(sub => sub.setName('on').setDescription('Enable full MCP for this channel/thread (~2s init per turn, full tool access)'))
  .addSubcommand(sub => sub.setName('off').setDescription('Back to fast mode (empty MCP, intent pre-fetch only)'))
  .addSubcommand(sub => sub.setName('clear').setDescription('Remove override; fall back to channel/default'))
  .addSubcommand(sub => sub.setName('status').setDescription('Show effective MCP mode + scope'));

const SYNC_SKILLS_CMD = new SlashCommandBuilder()
  .setName('sync-skills')
  .setDescription('Rsync allowlisted skills from gamez to generic (owner only)');

const ASK_CMD = new SlashCommandBuilder()
  .setName('ask')
  .setDescription('Toggle ask-only mode (read/think/discuss, no edits or shell) for this thread/channel')
  .addSubcommand(sub => sub.setName('on').setDescription('Enable ask-only mode'))
  .addSubcommand(sub => sub.setName('off').setDescription('Disable ask-only mode'))
  .addSubcommand(sub => sub.setName('status').setDescription('Show ask-mode state for this channel/thread'));

const INIT_CMD = new SlashCommandBuilder()
  .setName('init')
  .setDescription('Initialize or refresh Jarvis metadata (topic + registry)')
  .addSubcommand(sub =>
    sub.setName('this')
      .setDescription('Write jarvis metadata block into the current channel\'s topic')
      .addStringOption(opt => opt.setName('dir').setDescription('Working directory (default: $HOME/Dev/<channel-name>)').setRequired(false))
      .addStringOption(opt => opt.setName('model').setDescription('Default model for this channel (default: sonnet)').setRequired(false))
      .addStringOption(opt => opt.setName('summary').setDescription('What this channel is for').setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('create')
      .setDescription('Create a new channel and pre-initialize it')
      .addStringOption(opt => opt.setName('name').setDescription('Channel name (lowercase-with-dashes)').setRequired(true))
      .addStringOption(opt => opt.setName('dir').setDescription('Working directory (default: $HOME/Dev/<name>)').setRequired(false))
      .addStringOption(opt => opt.setName('model').setDescription('Model for this channel').setRequired(false))
      .addStringOption(opt => opt.setName('summary').setDescription('What this channel is for').setRequired(false))
      .addChannelOption(opt => opt.setName('category').setDescription('Parent category').setRequired(false)))
  .addSubcommand(sub => sub.setName('status').setDescription('Show jarvis metadata for this channel'))
  .addSubcommand(sub =>
    sub.setName('all').setDescription('Initialize metadata for EVERY channel (uses LLM to infer summaries if empty)')
      .addBooleanOption(opt => opt.setName('force').setDescription('Rewrite even channels that already have metadata').setRequired(false))
      .addBooleanOption(opt => opt.setName('summarize').setDescription('Use LLM to summarize recent messages for channels without summary').setRequired(false)));

const ACCESS_CMD = new SlashCommandBuilder()
  .setName('access')
  .setDescription('Manage channel-scoped access grants (owner only)')
  .addSubcommand(sub =>
    sub.setName('grant')
      .setDescription('Grant a user access to this channel')
      .addUserOption(opt =>
        opt.setName('user').setDescription('User to grant access to').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('revoke')
      .setDescription('Revoke a user\'s access from this channel')
      .addUserOption(opt =>
        opt.setName('user').setDescription('User to revoke access from').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('list').setDescription('List all channel access grants'));

const SKILL_CMD = new SlashCommandBuilder()
  .setName('skill')
  .setDescription('Invoke a Claude Code skill as an agent task in a thread (owner only)')
  .addStringOption(opt =>
    opt.setName('name').setDescription('Skill name (e.g. load, review, investigate)').setRequired(true).setAutocomplete(true))
  .addStringOption(opt =>
    opt.setName('args').setDescription('Arguments or context for the skill').setRequired(false));

const BOX_CMD = new SlashCommandBuilder()
  .setName('box')
  .setDescription('Switch the active shell/dir target box (owner only)')
  .addSubcommand(sub => sub.setName('status').setDescription('Show active box and working directory'))
  .addSubcommand(sub => sub.setName('list').setDescription('List all configured boxes'))
  .addSubcommand(sub =>
    sub.setName('set')
      .setDescription('Switch to a box (from BOXES env var)')
      .addStringOption(opt =>
        opt.setName('name')
          .setDescription('Box name (autocomplete from BOXES env var)')
          .setRequired(true)
          .setAutocomplete(true)));

const TMUX_CMD = new SlashCommandBuilder()
  .setName('tmux')
  .setDescription('Manage the Jarvis tmux HUD terminal session (owner only)')
  .addSubcommand(sub => sub.setName('on').setDescription('Start the jarvis-hud tmux session on this server'))
  .addSubcommand(sub => sub.setName('off').setDescription('Kill the jarvis-hud tmux session'))
  .addSubcommand(sub => sub.setName('status').setDescription('Check if the jarvis-hud tmux session is running'));

const SESSION_CMD = new SlashCommandBuilder()
  .setName('session')
  .setDescription('Spawn a live tmux shell session in this channel (owner only, requires SESSION_SHELL_ENABLED=true)')
  .addSubcommand(sub => sub.setName('start')
    .setDescription('Start a new shell session')
    .addStringOption(o => o.setName('command')
      .setDescription('Command to run (default: claude --dangerously-skip-permissions)')
      .setRequired(false))
    .addStringOption(o => o.setName('box')
      .setDescription('Box to run on (default: active box)')
      .setRequired(false)
      .addChoices(...BOX_NAMES.map(n => ({ name: n, value: n })))))
  .addSubcommand(sub => sub.setName('stop')
    .setDescription('Kill the session in this channel'))
  .addSubcommand(sub => sub.setName('list')
    .setDescription('List all active sessions'))
  .addSubcommand(sub => sub.setName('send')
    .setDescription('Send keys to the session (or just type in the channel)')
    .addStringOption(o => o.setName('text').setDescription('Text or !special key (e.g. !ctrl-c)').setRequired(true)))
  .addSubcommand(sub => sub.setName('attach')
    .setDescription('Reattach to a detached jv-* tmux session (screen -r style)')
    .addStringOption(o => o.setName('name').setDescription('Session name from /session list').setRequired(true))
    .addStringOption(o => o.setName('box').setDescription('Box the session is on').setRequired(false)
      .addChoices(...BOX_NAMES.map(n => ({ name: n, value: n })))))
  .addSubcommand(sub => sub.setName('resume')
    .setDescription('Scrape a prior thread transcript and resume Claude with that context')
    .addChannelOption(o => o.setName('thread').setDescription('Thread to resume from').setRequired(true))
    .addStringOption(o => o.setName('command')
      .setDescription('Command to run (default: claude --dangerously-skip-permissions)').setRequired(false))
    .addStringOption(o => o.setName('box').setDescription('Box to run on').setRequired(false)
      .addChoices(...BOX_NAMES.map(n => ({ name: n, value: n })))));

const RESUME_CMD = new SlashCommandBuilder()
  .setName('resume')
  .setDescription('Resume a Claude Code session (owner only, requires SESSION_SHELL_ENABLED=true)')
  .addStringOption(o => o.setName('name')
    .setDescription('Project name from project-map (e.g. openjarvis)').setRequired(false))
  .addStringOption(o => o.setName('id')
    .setDescription('Claude Code session UUID to resume exactly').setRequired(false))
  .addStringOption(o => o.setName('box')
    .setDescription('Box to run on (default: active box)').setRequired(false)
    .addChoices(...BOX_NAMES.map(n => ({ name: n, value: n }))));

const EFFORT_CMD = new SlashCommandBuilder()
  .setName('effort')
  .setDescription('Set thinking effort for the current model (owner only)')
  .addStringOption(o => o.setName('level')
    .setDescription('Effort level')
    .setRequired(true)
    .addChoices(
      { name: 'none (fastest, no thinking)', value: 'none' },
      { name: 'low', value: 'low' },
      { name: 'medium', value: 'medium' },
      { name: 'high', value: 'high' },
      { name: 'xhigh', value: 'xhigh' },
      { name: 'max', value: 'max' },
    ));

const PLAN_CMD = new SlashCommandBuilder()
  .setName('plan')
  .setDescription('Switch to plan mode — Opus with max effort for deep reasoning (owner only)')
  .addSubcommand(sub => sub.setName('on').setDescription('Enable plan mode (Opus, max effort)'))
  .addSubcommand(sub => sub.setName('off').setDescription('Disable plan mode (back to default model)'))
  .addSubcommand(sub => sub.setName('status').setDescription('Show current plan mode state'));

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
      { body: [VISUAL_CMD.toJSON(), VERBOSE_CMD.toJSON(), MODEL_CMD.toJSON(), ASK_CMD.toJSON(), MCP_CMD.toJSON(), SYNC_SKILLS_CMD.toJSON(), INIT_CMD.toJSON(), SPAWN_CMD.toJSON(), STOP_CMD.toJSON(), CRED_CMD.toJSON(), BOX_CMD.toJSON(), DIR_CMD.toJSON(), SHELL_CMD.toJSON(), ACCESS_CMD.toJSON(), SKILL_CMD.toJSON(), TMUX_CMD.toJSON(), SESSION_CMD.toJSON(), RESUME_CMD.toJSON(), PLAN_CMD.toJSON(), EFFORT_CMD.toJSON()] }
    );
    logger.info('[slash] Registered /visual, /verbose, /model, /ask, /mcp, /sync-skills, /init, /spawn, /stop, /cred, /box, /dir, /shell, /access, /skill, /tmux, /session, /resume, /plan, /effort commands');
  } catch (err) {
    logger.error(`[slash] Failed to register commands: ${err.message}`);
  }
}

/**
 * Handle incoming slash command interactions
 */
/** Handle autocomplete interactions (e.g. /skill name field). */
export async function handleAutocomplete(interaction) {
  if (!interaction.isAutocomplete()) return false;
  if (interaction.commandName === 'skill') {
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = listSkills()
      .filter(s => s.startsWith(focused) || s.includes(focused))
      .slice(0, 25)
      .map(s => ({ name: s, value: s }));
    await interaction.respond(choices);
    return true;
  }
  if (interaction.commandName === 'box' && interaction.options.getSubcommand(false) === 'set') {
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = BOX_NAMES
      .filter(n => n.startsWith(focused) || n.includes(focused))
      .slice(0, 25)
      .map(n => ({ name: n, value: n }));
    await interaction.respond(choices);
    return true;
  }
  return false;
}

export async function handleSlashCommand(interaction, allowedUsers) {
  if (!interaction.isChatInputCommand()) return false;

  if (interaction.commandName === 'skill') {
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    await handleSkillCommand(interaction);
    return true;
  }

  if (interaction.commandName === 'spawn') {
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    await handleSpawnCommand(interaction);
    return true;
  }

  if (interaction.commandName === 'stop') {
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    await handleStopCommand(interaction);
    return true;
  }

  if (interaction.commandName === 'cred') {
    if (!isChannelOwner(interaction.user.id)) {
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
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    const sub = interaction.options.getSubcommand();
    const ch = interaction.channel;
    const isThread = !!ch?.isThread?.();
    const scopeId = isThread ? ch.id : ch?.id;
    const parentId = isThread ? (ch.parentId || ch.id) : ch?.id;
    const scopeLabel = isThread ? `thread` : `channel`;
    const global = interaction.options.getBoolean?.('global') === true;

    if (sub === 'list') {
      const threadPin = scopeId ? getChannelModel(scopeId) : null;
      const parentPin = parentId ? getChannelModel(parentId) : null;
      const effective = threadPin || parentPin || getVoiceModel();
      const lines = KNOWN_MODELS.map(m => `${m === effective ? '▶' : '·'} **${m}**`).join('\n');
      const scope = threadPin ? `pinned to ${scopeLabel}` : parentPin ? 'pinned to parent channel' : 'global';
      await interaction.reply({ content: `**Available models** (effective: \`${effective}\` — ${scope}):\n${lines}`, ephemeral: true });
    } else if (sub === 'set') {
      const name = interaction.options.getString('name');
      if (!KNOWN_MODELS.includes(name)) {
        await interaction.reply({ content: `Unknown model \`${name}\`. Choose: ${KNOWN_MODELS.join(', ')}`, ephemeral: true });
        return true;
      }
      if (global) {
        setVoiceModel(name);
        _persistModel(name);
        await interaction.reply({ content: `🌐 **Global** model switched to **${name}**`, ephemeral: false });
      } else if (scopeId) {
        setChannelModel(scopeId, name);
        await interaction.reply({ content: `🔄 Model for this ${scopeLabel} pinned to **${name}**`, ephemeral: false });
      } else {
        await interaction.reply({ content: 'No channel context — use `--global` to change the global model.', ephemeral: true });
      }
    } else if (sub === 'clear') {
      if (scopeId) {
        clearChannelModel(scopeId);
        await interaction.reply({ content: `Model override cleared for this ${scopeLabel}. Falling back to channel/global.`, ephemeral: false });
      }
    } else if (sub === 'status') {
      const threadPin = scopeId ? getChannelModel(scopeId) : null;
      const parentPin = parentId && parentId !== scopeId ? getChannelModel(parentId) : null;
      const gm = getVoiceModel();
      const effective = threadPin || parentPin || gm;
      const parts = [`**effective:** \`${effective}\``];
      if (threadPin) parts.push(`thread pin: \`${threadPin}\``);
      if (parentPin) parts.push(`channel pin: \`${parentPin}\``);
      parts.push(`global: \`${gm}\``);
      await interaction.reply({ content: parts.join(' | '), ephemeral: true });
    }
    return true;
  }

  if (interaction.commandName === 'verbose') {
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    const sub = interaction.options.getSubcommand();
    const ch = interaction.channel;
    const isThread = !!ch?.isThread?.();
    const global = interaction.options.getBoolean?.('global') === true;

    if (sub === 'on') {
      if (global || !isThread) {
        setVerboseMode(true);
        await interaction.reply({ content: global ? '🌐 **Global** verbose ON.' : '📡 **Verbose mode ON** — channel-level.', ephemeral: false });
      } else {
        enableVerboseForThread(ch.id);
        await interaction.reply({ content: '📡 Verbose **ON** for this thread only.', ephemeral: false });
      }
    } else if (sub === 'off') {
      if (global || !isThread) {
        setVerboseMode(false);
        await interaction.reply({ content: global ? '🌐 **Global** verbose OFF.' : '🔇 Verbose OFF — channel-level.', ephemeral: false });
      } else {
        disableVerboseForThread(ch.id);
        await interaction.reply({ content: '🔇 Verbose **OFF** for this thread only.', ephemeral: false });
      }
    } else if (sub === 'clear') {
      if (isThread) {
        clearThreadVerboseOverride(ch.id);
        await interaction.reply({ content: 'Thread verbose override cleared — falling back to global.', ephemeral: false });
      }
    } else if (sub === 'status') {
      const effective = isVerboseModeEnabled(ch?.id);
      await interaction.reply({
        content: effective
          ? `📡 Verbose is **ON** ${isThread ? '(for this thread)' : '(globally)'}.`
          : `🔇 Verbose is **OFF** ${isThread ? '(for this thread)' : '(globally)'}.`,
        ephemeral: true,
      });
    }
    return true;
  }

  if (interaction.commandName === 'ask') {
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    const { setAskMode, isAskModeEnabled } = await import('./channel-ask-mode.js');
    const sub = interaction.options.getSubcommand();
    const ch = interaction.channel;
    const isThread = !!ch?.isThread?.();
    const scopeId = isThread ? ch.id : ch?.id;
    const parentId = isThread ? (ch.parentId || ch.id) : ch?.id;

    if (sub === 'on') {
      setAskMode(scopeId, true);
      await interaction.reply({ content: `🔒 Ask-only mode **ON** for this ${isThread ? 'thread' : 'channel'}. Read/think/discuss only — no edits, no shell.`, ephemeral: false });
    } else if (sub === 'off') {
      setAskMode(scopeId, false);
      await interaction.reply({ content: `🔓 Ask-only mode **OFF** for this ${isThread ? 'thread' : 'channel'}. Full tool access.`, ephemeral: false });
    } else if (sub === 'status') {
      const onScope = isAskModeEnabled(scopeId);
      const onParent = isAskModeEnabled(parentId);
      const effective = onScope || onParent;
      const parts = [`**effective:** ${effective ? '🔒 ON' : '🔓 OFF'}`];
      if (isThread) parts.push(onScope ? 'thread: ON' : 'thread: OFF');
      parts.push(onParent ? 'channel: ON' : 'channel: OFF');
      await interaction.reply({ content: parts.join(' | '), ephemeral: true });
    }
    return true;
  }

  if (interaction.commandName === 'sync-skills') {
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    const { handleSyncSkillsCommand } = await import('./slash/sync-skills.js');
    await handleSyncSkillsCommand(interaction);
    return true;
  }

  if (interaction.commandName === 'mcp') {
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    const { setMcpMode, getMcpMode, clearMcpMode } = await import('./channel-mcp-mode.js');
    const sub = interaction.options.getSubcommand();
    const ch = interaction.channel;
    const isThread = !!ch?.isThread?.();
    const scopeId = ch?.id;
    const parentId = isThread ? (ch.parentId || ch.id) : ch?.id;

    if (sub === 'on') {
      setMcpMode(scopeId, 'full');
      await interaction.reply({ content: `🔧 Full MCP **ON** for this ${isThread ? 'thread' : 'channel'}. Curated tools (notion, gcal, slack, trello, linear, hAIveMind, google-maps) loaded per spawn. ~2-3s init cost per voice turn.`, ephemeral: false });
    } else if (sub === 'off') {
      setMcpMode(scopeId, 'off');
      await interaction.reply({ content: `🔧 Full MCP **OFF** for this ${isThread ? 'thread' : 'channel'}. Fast path (intent pre-fetch only).`, ephemeral: false });
    } else if (sub === 'clear') {
      clearMcpMode(scopeId);
      await interaction.reply({ content: `🔧 MCP override cleared — falling back to parent/default.`, ephemeral: false });
    } else if (sub === 'status') {
      const scopeMode = getMcpMode(scopeId);
      const parentMode = getMcpMode(parentId);
      const effective = scopeMode ?? parentMode ?? 'off (default)';
      const describe = v => Array.isArray(v) ? `subset[${v.join(',')}]` : (v ?? '—');
      const parts = [`**effective:** ${describe(effective)}`];
      if (isThread) parts.push(`thread: ${describe(scopeMode)}`);
      parts.push(`channel: ${describe(parentMode)}`);
      await interaction.reply({ content: parts.join(' | '), ephemeral: true });
    }
    return true;
  }

  if (interaction.commandName === 'init') {
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    const { setChannelMeta, getChannelMeta, loadRegistry } = await import('./channel-topic.js');
    const sub = interaction.options.getSubcommand();
    const ch = interaction.channel;

    if (sub === 'status') {
      const parent = ch?.isThread?.() ? (await ch.parent?.fetch?.().catch(() => null) || ch.parent) : ch;
      if (!parent || !parent.topic !== undefined && parent.topic === null && parent.topic === undefined && !parent.setTopic) {
        await interaction.reply({ content: 'Cannot read topic from this channel type.', ephemeral: true });
        return true;
      }
      const meta = getChannelMeta(parent);
      const reg = loadRegistry()[parent.id] || {};
      const rows = [
        `**channel:** #${parent.name} (${parent.id})`,
        `**topic meta:** ${Object.keys(meta).length ? '`' + JSON.stringify(meta) + '`' : '_(none)_'}`,
        `**registry:** ${Object.keys(reg).length ? '`' + JSON.stringify(reg) + '`' : '_(none)_'}`,
      ];
      await interaction.reply({ content: rows.join('\n'), ephemeral: true });
      return true;
    }

    if (sub === 'this') {
      await interaction.deferReply({ ephemeral: false });
      const parent = ch?.isThread?.() ? (await ch.parent?.fetch?.().catch(() => null) || ch.parent) : ch;
      if (!parent || !parent.setTopic) {
        await interaction.editReply('This channel type does not support topics.');
        return true;
      }
      const dir = interaction.options.getString('dir')
        || (loadRegistry()[parent.id]?.directory)
        || `${process.env.HOME}/Dev/${(parent.name || '').replace(/[^a-z0-9-]/gi, '-')}`;
      const model = interaction.options.getString('model')
        || loadRegistry()[parent.id]?.model
        || 'claude-sonnet-4-6';
      const summary = interaction.options.getString('summary')
        || loadRegistry()[parent.id]?.summary
        || '';

      try {
        const meta = { dir, model };
        if (summary) meta.summary = summary;
        await setChannelMeta(parent, meta);
        // Also reflect in the registry with a directory key (registry uses 'directory' not 'dir')
        const { loadRegistry: _lr, saveRegistry } = await import('./channel-topic.js');
        const reg = _lr();
        reg[parent.id] = { ...(reg[parent.id] || {}), name: parent.name, directory: dir, model };
        if (summary) reg[parent.id].summary = summary;
        saveRegistry(reg);

        const reply = [
          `✅ Initialized **#${parent.name}**`,
          `**dir:** \`${dir}\``,
          `**model:** \`${model}\``,
          summary ? `**summary:** ${summary}` : null,
        ].filter(Boolean).join('\n');
        await interaction.editReply(reply);
      } catch (err) {
        await interaction.editReply(`/init failed: ${err.message}`);
      }
      return true;
    }

    if (sub === 'create') {
      await interaction.deferReply({ ephemeral: false });
      try {
        const guild = interaction.guild;
        if (!guild) throw new Error('no guild context');
        const name = interaction.options.getString('name');
        const category = interaction.options.getChannel('category');
        const summary = interaction.options.getString('summary') || '';
        const dir = interaction.options.getString('dir') || `$HOME/Dev/${name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
        const model = interaction.options.getString('model') || 'claude-sonnet-4-6';

        const { ChannelType } = await import('discord.js');
        const newChannel = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: category?.id || null,
          topic: '', // will be set by setChannelMeta
        });

        const meta = { dir, model };
        if (summary) meta.summary = summary;
        await setChannelMeta(newChannel, meta);

        const { loadRegistry: _lr, saveRegistry } = await import('./channel-topic.js');
        const reg = _lr();
        reg[newChannel.id] = { ...(reg[newChannel.id] || {}), name: newChannel.name, directory: dir, model };
        if (summary) reg[newChannel.id].summary = summary;
        saveRegistry(reg);

        await interaction.editReply([
          `✅ Created **<#${newChannel.id}>**`,
          `**dir:** \`${dir}\``,
          `**model:** \`${model}\``,
          summary ? `**summary:** ${summary}` : null,
        ].filter(Boolean).join('\n'));
      } catch (err) {
        await interaction.editReply(`/init create failed: ${err.message}`);
      }
      return true;
    }

    if (sub === 'all') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const guild = interaction.guild;
        if (!guild) throw new Error('no guild context');
        const force = interaction.options.getBoolean?.('force') === true;
        const doSummarize = interaction.options.getBoolean?.('summarize') === true;

        const channels = await guild.channels.fetch();
        const reg0 = loadRegistry();
        const candidates = [];
        for (const c of channels.values()) {
          if (!c || !c.setTopic) continue;
          // text/announcement channels only
          if (c.type !== 0 && c.type !== 5) continue;
          const entry = reg0[c.id] || {};
          const alreadyInitialized = entry.directory && entry.model && (c.topic || '').includes('[jarvis]');
          if (alreadyInitialized && !force) continue;
          candidates.push(c);
        }

        await interaction.editReply(`Scanning ${candidates.length} channel(s)... this may take a minute.`);

        let touched = 0;
        let summarized = 0;
        for (const c of candidates) {
          try {
            const name = c.name;
            const entry = loadRegistry()[c.id] || {};
            const dir = entry.directory || `$HOME/Dev/${(name || '').replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
            const model = entry.model || 'claude-sonnet-4-6';
            let summary = entry.summary || '';

            if (!summary && doSummarize) {
              try {
                const msgs = await c.messages.fetch({ limit: 10 }).catch(() => null);
                const text = msgs && msgs.size > 0
                  ? [...msgs.values()].reverse()
                      .map(m => `${m.author?.username || '?'}: ${(m.content || '').slice(0, 200)}`)
                      .join('\n')
                  : '';
                if (text) {
                  const { default: fetch } = await import('node-fetch');
                  const gwUrl = process.env.JARVIS_GATEWAY_URL || 'http://127.0.0.1:22100';
                  const gwToken = process.env.JARVIS_GATEWAY_TOKEN || '';
                  const prompt = `In ONE short sentence (under 20 words), summarize what this Discord channel "#${name}" is for, based on recent messages. No preamble, just the sentence.\n\n${text.slice(0, 3000)}`;
                  const res = await fetch(`${gwUrl}/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gwToken}` },
                    body: JSON.stringify({
                      model: 'haiku',
                      messages: [{ role: 'user', content: prompt }],
                      stream: false,
                    }),
                    signal: AbortSignal.timeout(20000),
                  }).catch(() => null);
                  if (res && res.ok) {
                    const data = await res.json();
                    const out = data?.choices?.[0]?.message?.content?.trim();
                    if (out) {
                      summary = out.replace(/^["']|["']$/g, '').slice(0, 180);
                      summarized++;
                    }
                  }
                }
              } catch {}
            }

            const meta = { dir, model };
            if (summary) meta.summary = summary;
            await setChannelMeta(c, meta);

            // Mirror to registry
            const reg = loadRegistry();
            reg[c.id] = { ...(reg[c.id] || {}), name: c.name, directory: dir, model };
            if (summary) reg[c.id].summary = summary;
            const { saveRegistry } = await import('./channel-topic.js');
            saveRegistry(reg);

            touched++;
            await new Promise(r => setTimeout(r, 700)); // rate-limit gentle
          } catch (err) {
            logger.warn(`[init all] ${c.name}: ${err.message}`);
          }
        }
        await interaction.followUp({ content: `✅ Initialized **${touched}** channel(s)${doSummarize ? ` (${summarized} summarized via LLM)` : ''}.`, ephemeral: true });
      } catch (err) {
        await interaction.editReply(`/init all failed: ${err.message}`);
      }
      return true;
    }

    return true;
  }

  if (interaction.commandName === 'box') {
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') {
      const box = getBox();
      await interaction.reply({ content: `Active box: **${box.name}** — ${box.label} | cwd: \`${getCwd()}\``, ephemeral: true });
    } else if (sub === 'list') {
      const lines = listBoxes().map(b => `${b.active ? '▶' : '·'} **${b.name}** — ${b.label}${b.ssh ? ` (ssh: \`${b.ssh}\`)` : ''}`).join('\n');
      await interaction.reply({ content: `**Boxes:**\n${lines}`, ephemeral: true });
    } else if (sub === 'set') {
      const name = interaction.options.getString('name');
      if (!setBox(name)) {
        await interaction.reply({ content: `Unknown box \`${name}\`. Options: ${BOX_NAMES.join(', ')}`, ephemeral: true });
      } else {
        persistBoxState();
        const box = getBox();
        await interaction.reply({ content: `Switched to **${box.name}** — ${box.label}`, ephemeral: false });
      }
    }
    return true;
  }

  if (interaction.commandName === 'dir') {
    await handleDirCommand(interaction, allowedUsers);
    return true;
  }

  if (interaction.commandName === 'shell') {
    await handleShellCommand(interaction, allowedUsers);
    return true;
  }

  if (interaction.commandName === 'access') {
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'grant') {
      const target = interaction.options.getUser('user');
      const added = grantAccess(target.id, interaction.channelId);
      await interaction.reply({
        content: added
          ? `Granted <@${target.id}> access to <#${interaction.channelId}>.`
          : `<@${target.id}> already has access to <#${interaction.channelId}>.`,
        ephemeral: true,
      });
    } else if (sub === 'revoke') {
      const target = interaction.options.getUser('user');
      const removed = revokeAccess(target.id, interaction.channelId);
      await interaction.reply({
        content: removed
          ? `Revoked <@${target.id}> access from <#${interaction.channelId}>.`
          : `<@${target.id}> had no access to <#${interaction.channelId}>.`,
        ephemeral: true,
      });
    } else if (sub === 'list') {
      const grants = listAccess();
      if (grants.length === 0) {
        await interaction.reply({ content: 'No channel access grants configured.', ephemeral: true });
      } else {
        const lines = grants.map(g => `<#${g.channelId}>: ${g.userIds.map(u => `<@${u}>`).join(', ')}`).join('\n');
        await interaction.reply({ content: `**Channel access grants:**\n${lines}`, ephemeral: true });
      }
    }
    return true;
  }

  if (interaction.commandName === 'tmux') {
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    const sub = interaction.options.getSubcommand();
    const __d = dirname(fileURLToPath(import.meta.url));
    const hudScript = join(__d, '..', 'scripts', 'hud-tmux.sh');

    if (sub === 'status') {
      try {
        await _execAsync('tmux has-session -t jarvis-hud');
        await interaction.reply({ content: '`jarvis-hud` tmux session is **running**.\nAttach: `ssh generic -t tmux attach -t jarvis-hud`', ephemeral: true });
      } catch {
        await interaction.reply({ content: '`jarvis-hud` tmux session is **not running**.', ephemeral: true });
      }
    } else if (sub === 'on') {
      await interaction.deferReply({ ephemeral: false });
      try {
        // Kill stale session if any, then launch detached
        await _execAsync('tmux kill-session -t jarvis-hud 2>/dev/null || true');
        await _execAsync(`bash ${hudScript} &`, { timeout: 5000 }).catch(() => {});
        // Give it a moment to start
        await new Promise(r => setTimeout(r, 1500));
        await _execAsync('tmux has-session -t jarvis-hud');
        const box = getBox();
        await interaction.editReply(`**jarvis-hud** tmux session started on **${box.name}** box.\nAttach: \`ssh generic -t tmux attach -t jarvis-hud\``);
      } catch (err) {
        await interaction.editReply(`Failed to start tmux session: ${err.message}`);
      }
    } else if (sub === 'off') {
      try {
        await _execAsync('tmux kill-session -t jarvis-hud');
        await interaction.reply({ content: '`jarvis-hud` tmux session **killed**.', ephemeral: false });
      } catch {
        await interaction.reply({ content: '`jarvis-hud` was not running.', ephemeral: true });
      }
    }
    return true;
  }

  if (interaction.commandName === 'session') {
    await handleSessionCommand(interaction);
    return true;
  }

  if (interaction.commandName === 'resume') {
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    await interaction.deferReply({ ephemeral: false });
    const nameOpt = interaction.options.getString('name');
    const idOpt   = interaction.options.getString('id');
    const boxOpt  = interaction.options.getString('box');

    let channelId = interaction.channelId;
    let boxName   = boxOpt || null;
    let cwd       = null;
    let label     = 'resume';

    if (nameOpt) {
      const entry = findProjectMapByName(nameOpt);
      if (!entry) {
        await interaction.editReply(`Unknown project: \`${nameOpt}\`. Use \`/session start\` to set one up.`);
        return true;
      }
      channelId = entry.channelId;
      boxName   = boxOpt || entry.box;
      cwd       = entry.cwd;
      label     = entry.name;
    } else {
      const box = boxOpt ? null : getBox();
      boxName   = boxOpt || box?.name;
      cwd       = getCwd();
    }

    const command = buildResumeCommand(idOpt || null);
    try {
      const status = await startSessionDirect({ channelId, command, boxName, cwd, label });
      await interaction.editReply(status);
    } catch (err) {
      await interaction.editReply(`Failed: \`${err.message}\``);
    }
    return true;
  }

  if (interaction.commandName === 'effort') {
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    const level = interaction.options.getString('level');
    const current = getVoiceModel();
    const baseModel = current.replace(/-(?:low|medium|high|xhigh|max)$/, '').replace(/-plan$/, '') || 'claude';
    const newModel = level === 'none' ? baseModel : `${baseModel}-${level}`;
    setVoiceModel(newModel);
    const desc = level === 'none' ? 'no thinking (fastest)' : `--effort ${level}`;
    await interaction.reply({ content: `Effort set to **${level}** — ${desc}. Model: \`${newModel}\`` });
    return true;
  }

  if (interaction.commandName === 'plan') {
    if (!isChannelOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return true;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'on') {
      setVoiceModel('opus-plan');
      await interaction.reply({ content: '**Plan mode ON** — Opus with max effort. Deep reasoning active. Use `/plan off` to return to default.' });
    } else if (sub === 'off') {
      setVoiceModel(_DEFAULT_VOICE_MODEL);
      await interaction.reply({ content: `**Plan mode OFF** — back to default (\`${_DEFAULT_VOICE_MODEL}\`).` });
    } else if (sub === 'status') {
      const m = getVoiceModel();
      const active = m === 'opus-plan';
      await interaction.reply({ content: `Plan mode: **${active ? 'ON' : 'OFF'}** (current model: \`${m}\`)` });
    }
    return true;
  }

  if (interaction.commandName !== 'visual') return false;

  // Auth check — only allowed users
  if (!isChannelOwner(interaction.user.id)) {
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
