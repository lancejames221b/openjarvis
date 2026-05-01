/**
 * /new-kanban-channel — create a Discord channel and register it as a
 * Kanban-linked project channel.
 *
 * Pattern follows /init create (src/slash-commands.js): create the channel,
 * upsert the channel-registry entry, then bootstrap the Kanban workspace by
 * invoking the kanban CLI (which auto-registers on first use).
 */

import { ChannelType } from 'discord.js';
import { execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'fs';
import { dirname } from 'path';
import logger from '../../logger.js';

const REGISTRY_PATH =
  process.env.CHANNEL_REGISTRY_PATH ||
  process.env.JARVIS_CHANNEL_REGISTRY ||
  `${process.env.HOME || '/tmp'}/dev/contexts/channel-registry.json`;

const KANBAN_NODE_BIN = process.env.KANBAN_NODE_BIN || '/usr/bin/node';
const KANBAN_BIN = process.env.KANBAN_BIN || `${process.env.HOME || ''}/.local/bin/kanban`;
const KANBAN_INIT_TIMEOUT_MS = 30_000;

// Discord channel name rules: lowercase letters, digits, dashes, underscores;
// 2..100 chars. We enforce a stricter "no spaces, hyphens preferred" form.
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;

function validateChannelName(name) {
  if (!name) return 'channel name is required';
  if (!CHANNEL_NAME_RE.test(name)) {
    return 'channel name must be lowercase letters, digits, hyphens, or underscores (no spaces)';
  }
  return null;
}

function validateProjectPath(p) {
  if (!p) return 'project-path is required';
  if (!p.startsWith('/')) return 'project-path must be an absolute path';
  if (!existsSync(p)) return `project-path does not exist: ${p}`;
  try {
    if (!statSync(p).isDirectory()) return `project-path is not a directory: ${p}`;
  } catch (err) {
    return `cannot stat project-path: ${err.message}`;
  }
  return null;
}

function loadRegistry() {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function saveRegistryAtomic(reg) {
  const tmp = `${REGISTRY_PATH}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, REGISTRY_PATH);
}

function addRegistryEntry(channelId, { name, projectPath }) {
  const reg = loadRegistry();
  reg[channelId] = {
    ...(reg[channelId] || {}),
    name,
    path: projectPath,
    directory: projectPath,
    kanbanEnabled: true,
    kanbanPath: projectPath,
  };
  saveRegistryAtomic(reg);
  return reg[channelId];
}

function initializeKanbanWorkspace(projectPath) {
  return new Promise(resolve => {
    execFile(
      KANBAN_NODE_BIN,
      [KANBAN_BIN, 'task', 'list', '--project-path', projectPath],
      { timeout: KANBAN_INIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            error: err.message,
            stderr: (stderr || '').toString().slice(0, 400),
          });
          return;
        }
        resolve({ ok: true, stdout: (stdout || '').toString().slice(0, 400) });
      },
    );
  });
}

export async function handleNewKanbanChannelCommand(interaction) {
  const name = interaction.options.getString('name');
  const projectPath = interaction.options.getString('project-path');
  const category = interaction.options.getChannel('category', false);

  const nameErr = validateChannelName(name);
  if (nameErr) {
    await interaction.reply({ content: `❌ ${nameErr}`, ephemeral: true });
    return;
  }
  const pathErr = validateProjectPath(projectPath);
  if (pathErr) {
    await interaction.reply({ content: `❌ ${pathErr}`, ephemeral: true });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: '❌ no guild context', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  let newChannel;
  try {
    newChannel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: category?.id || null,
      topic: `Kanban-linked project: ${projectPath}`,
    });
  } catch (err) {
    logger.error(`[new-kanban-channel] channel create failed: ${err.message}`);
    await interaction.editReply(`❌ Failed to create channel: ${err.message}`);
    return;
  }

  try {
    if (!existsSync(dirname(REGISTRY_PATH))) {
      await interaction.editReply(
        `⚠️ Created <#${newChannel.id}> but registry directory does not exist: \`${dirname(REGISTRY_PATH)}\``,
      );
      return;
    }
    addRegistryEntry(newChannel.id, { name, projectPath });
  } catch (err) {
    logger.error(`[new-kanban-channel] registry write failed: ${err.message}`);
    await interaction.editReply(
      `⚠️ Created <#${newChannel.id}> but registry write failed: ${err.message}`,
    );
    return;
  }

  const init = await initializeKanbanWorkspace(projectPath);

  const lines = [
    init.ok
      ? `✅ Created <#${newChannel.id}> as a Kanban channel. Workspace initialized at \`${projectPath}\`.`
      : `⚠️ Created <#${newChannel.id}> as a Kanban channel, but \`kanban\` init failed: ${init.error}`,
  ];
  if (!init.ok && init.stderr) lines.push('```\n' + init.stderr + '\n```');

  await interaction.editReply(lines.join('\n'));
}
