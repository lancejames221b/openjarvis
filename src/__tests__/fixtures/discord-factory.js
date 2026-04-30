// discord-factory.js — builds discord.js-shaped stub objects for use in unit tests.
// All methods are vi.fn() so tests can assert calls and override return values.

import { vi } from 'vitest';

let _msgId = 1000;
let _chanId = 2000;
let _guildId = 3000;
let _userId = 4000;

function nextId(counter) { return String(counter++); }

/**
 * makeMessage(text, opts)
 * Returns a discord.js Message-shaped stub.
 * opts can override any top-level field (id, author, channel, guild, reply, react).
 */
export function makeMessage(text = '', opts = {}) {
  const channelBase = {
    id: String(_chanId++),
    isThread: vi.fn(() => false),
    send: vi.fn(),
    sendTyping: vi.fn(),
  };
  return {
    id: String(_msgId++),
    content: text,
    author: { id: String(_userId++), username: 'testuser', bot: false },
    channel: channelBase,
    guild: { id: String(_guildId++) },
    reply: vi.fn(),
    react: vi.fn(),
    ...opts,
  };
}

/**
 * makeThreadMessage(text, opts)
 * Like makeMessage but channel.isThread() returns true and parentId/name are set.
 */
export function makeThreadMessage(text = '', opts = {}) {
  const channelBase = {
    id: String(_chanId++),
    parentId: String(_chanId++),
    name: 'test-thread',
    isThread: vi.fn(() => true),
    send: vi.fn(),
    sendTyping: vi.fn(),
  };
  return {
    id: String(_msgId++),
    content: text,
    author: { id: String(_userId++), username: 'testuser', bot: false },
    channel: channelBase,
    guild: { id: String(_guildId++) },
    reply: vi.fn(),
    react: vi.fn(),
    ...opts,
  };
}

/**
 * makeThread(opts)
 * Returns a Channel object shaped as a Discord thread.
 */
export function makeThread(opts = {}) {
  return {
    id: String(_chanId++),
    parentId: String(_chanId++),
    name: 'test-thread',
    isThread: vi.fn(() => true),
    send: vi.fn(),
    setName: vi.fn(),
    ...opts,
  };
}

/**
 * makeInteraction(commandName, opts)
 * Returns a ChatInputCommandInteraction-shaped stub.
 */
export function makeInteraction(commandName = 'test', opts = {}) {
  return {
    commandName,
    user: { id: String(_userId++), username: 'testuser' },
    channelId: String(_chanId++),
    guildId: String(_guildId++),
    reply: vi.fn(),
    deferReply: vi.fn(),
    editReply: vi.fn(),
    options: {
      getString: vi.fn(() => null),
      getBoolean: vi.fn(() => null),
    },
    ...opts,
  };
}

/**
 * makeGuild(opts)
 * Returns a minimal Guild stub. channels.create resolves to a thread stub.
 */
export function makeGuild(opts = {}) {
  return {
    id: String(_guildId++),
    name: 'Test Guild',
    channels: {
      create: vi.fn(() => Promise.resolve(makeThread())),
    },
    ...opts,
  };
}
