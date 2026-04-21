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
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const _execAsync = promisify(exec);

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
import { handleDirCommand, handleShellCommand } from './slash/shell.js';
import { handleSkillCommand, listSkills } from './slash/skill.js';
import { getBox, setBox, listBoxes, getCwd, persistBoxState, BOX_NAMES } from './slash/box-state.js';
import { isOwner as isChannelOwner, grantAccess, revokeAccess, listAccess } from './channel-access.js';
import { handleSessionCommand, startSessionDirect, buildResumeCommand } from './slash/session.js';
import { findProjectMapByName } from './slash/project-map.js';
import logger from './logger.js';

const SPAWN_CMD = new SlashCommandBuilder()
  .setName('spawn')
  .setDescription('Spawn a dedicated cursor-agent session in a new thread')
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
      { body: [VISUAL_CMD.toJSON(), VERBOSE_CMD.toJSON(), MODEL_CMD.toJSON(), SPAWN_CMD.toJSON(), STOP_CMD.toJSON(), CRED_CMD.toJSON(), BOX_CMD.toJSON(), DIR_CMD.toJSON(), SHELL_CMD.toJSON(), ACCESS_CMD.toJSON(), SKILL_CMD.toJSON(), TMUX_CMD.toJSON(), SESSION_CMD.toJSON(), RESUME_CMD.toJSON(), PLAN_CMD.toJSON(), EFFORT_CMD.toJSON()] }
    );
    logger.info('[slash] Registered /visual, /verbose, /model, /spawn, /stop, /cred, /box, /dir, /shell, /access, /skill, /tmux, /session, /resume, /plan, /effort commands');
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
    if (!isChannelOwner(interaction.user.id)) {
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
      setVoiceModel('claude');
      await interaction.reply({ content: '**Plan mode OFF** — back to default model.' });
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
