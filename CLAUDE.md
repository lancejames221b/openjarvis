# OpenJarvis

OpenJarvis is a Discord-native AI assistant that bridges voice I/O, Claude CLI agents, webhook alerts, and persistent memory. A user speaks or types in a Discord channel; Jarvis transcribes, routes to an AI agent session, and replies in text or voice.

**Repo**: `~/Dev/openjarvis` (gamez dev), `~/dev/jarvis-voice/` on generic (live)
**Package name**: `jarvis-voice` (rename to `openjarvis` is planned — see plan below)
**Stack**: Node.js ES modules + discord.js v14 + Claude CLI + Python haivemind submodule

---

## Subsystems

### jarvis-voice (`src/index.js`, `src/stt.js`, `src/tts.js`, `src/wakeword.js`, …)

Voice I/O layer. Handles:
- Wake-word detection (`wakeword.js`) → Whisper STT (`stt.js`) → intent classification → brain dispatch
- TTS response via Piper / Chatterbox / Qwen3 (`tts.js`, `tts-pipeline.js`)
- Discord event handling: mentions, slash commands, thread events, message routing
- Slash commands dispatched through `src/command-dispatch.js` and `src/slash-commands.js`
- `/spawn` creates a Discord thread as an isolated agent session (`src/spawn.js`)

`src/index.js` is 269 KB — the entire Discord setup, voice receiver, mention handling, slash dispatch, and bot bootstrap live here. Refactor into `src/{voice,discord,brain,agent,alerts,state}/` is planned.

Systemd unit (on generic): `jarvis-voice.service` (`systemctl --user`)

### jarvis-gateway (`scripts/jarvis-gateway.js`, port 22100)

The agentic brain adapter — an HTTP/SSE server that `jarvis-voice` calls to run Claude CLI subprocesses.

- `spawnClaudeStream(prompt, model, chatId, channelKey, effort)` — spawns `claude -p [--resume <chatId>]`
- Maintains a `chatId` (Claude conversation UUID) per `channelKey` in `~/.local/state/jarvis-voice/jarvis-sessions.json`. Persists across restarts.
- Routes per-channel: Claude profile (`channel-accounts.json`), ask-mode (`channel-ask-mode.json`), MCP mode (`channel-mcp-mode.json`)
- Session rotation: after N turns or T seconds, old chatId is summarized to haivemind, then replaced
- `JARVIS_GATEWAY_PORT` env var (default 22100)

Systemd unit: `jarvis-gateway.service`

### jarvis-alerts (`src/alert-webhook.js`, port 3335 Tailscale-bound)

Webhook receiver for external alert sources (Grafana, scripts, etc.). Queues incoming alerts (`src/alert-queue.js`), tracks task state (`src/task-ledger.js`), and surfaces alerts to voice/Discord via HUD. Scheduled jobs managed by `src/task-scheduler.js`.

Port is Tailscale-only: `app.listen(WEBHOOK_PORT, TAILSCALE_IP, …)`.

### kanban-dispatch (`src/kanban-dispatch.js`, `src/state/focus-state.js`)

Channel-bound Kanban CLI router. When a Discord channel's registry entry has `kanbanEnabled: true`, natural-language Kanban verbs ("create a task: …", "show the board", "start task <id>", "trash task <id>", "what's in progress") are intercepted before the brain via `tryKanbanDispatch()` (hooked in `src/discord/command-dispatch.js`). The dispatcher shells out to `${HOME}/.local/bin/kanban task …` with `--project-path` resolved from the registry entry's `kanbanPath` (or `path`). Result type `{ type: 'kanban', speech, discordText }` is rendered in `src/index.js` — TTS speaks the brief summary, full board posts to the focus channel.

Channel-registry helpers in `src/state/focus-state.js`: `isKanbanChannel(channelId)` (thread-aware) and `getKanbanPath(channelId)`. Schema fields on a registry entry: `kanbanEnabled: boolean`, `kanbanPath: string`.

Slash command `/new-kanban-channel name:<…> project-path:<abs-path>` (`src/discord/slash/new-kanban-channel.js`) creates a Discord channel, atomic-writes a `kanbanEnabled: true` registry entry, and bootstraps the workspace by invoking `kanban task list` once.

Skill: `skills/kanban/SKILL.md` — full operations reference. Setup: `skills/kanban/SETUP.md`.

### haivemind (`haivemind/` submodule)

Python-based collective memory system. Provides ChromaDB vector storage + Redis caching + MCP server interface. Used by jarvis-gateway to store/retrieve per-channel conversation summaries and cross-agent knowledge. Has its own `haivemind/Claude.md`.

---

## Discord Channel → Thread → Agent Threading Model

### Session key format

Every agent conversation is keyed by a **channelKey**:

```
agent:main:discord:channel:<channelId>
agent:main:discord:channel:<channelId>:thread:<threadId>
```

A top-level channel message uses the channel form; a thread message uses the `:thread:` form.

### How a thread becomes an agent session

1. User runs `/spawn <task>` (or voice-spawn fires via `src/spawn.js:runVoiceSpawn`)
2. `spawn.js` creates a Discord thread in the parent channel
3. The thread's ID becomes part of the channelKey: `…:channel:<parentId>:thread:<threadId>`
4. Gateway calls `getOrCreateChatId(channelKey)` — returns an existing Claude `chatId` or starts a new session
5. Each subsequent message in the thread resumes: `claude -p --resume <chatId>`
6. Thread lifetime = session lifetime; the Discord thread is the visible history

### How `:thread:` suffixes are stripped — `resolveProfile()`

`scripts/jarvis-gateway.js:78-88`:

```js
function resolveProfile(channelKey) {
  let profileName = channelAccounts.channels?.[channelKey]; // exact match
  if (!profileName) {
    const parentKey = channelKey.replace(/:thread:\d+$/, ""); // strip thread suffix
    if (parentKey !== channelKey) profileName = channelAccounts.channels?.[parentKey];
  }
  profileName = profileName || "default";
  return channelAccounts.profiles?.[profileName] ?? channelAccounts.profiles?.default ?? null;
}
```

The same `:thread:` suffix stripping is applied in `_channelIsInAskMode()` (line 209) and `_channelMcpMode()` (line 233) so that per-channel ask-mode and MCP-mode settings are inherited by threads inside that channel.

**Fix landed in commit `faa16cc`**: thread sessions now correctly inherit the parent channel's haivemind memories, focus tag, and Claude profile. Before that fix, `:thread:` suffixes in session keys caused a lookup miss and threads got the default profile.

---

## Channel Registry — Per-Channel Context Routing

**File**: `~/dev/contexts/channel-registry.json` (~14 entries)

Maps a Discord channel ID to project context:

```json
{
  "<channelId>": {
    "name": "ewitness-dev",
    "path": "~/Dev/ewitness",
    "model": "claude-sonnet-4-6"
  }
}
```

`src/focus-state.js:_loadRegistry()` reads this file. When a message arrives in a channel, the registry entry provides:
- `path` — the project root Claude is run from (currently the gateway's cwd, not per-session; worktree isolation is planned)
- `model` — default model for that channel
- `name` — used in focus tags injected into Claude's context

Channel accounts (which Claude `--config-path` to use per channel) are separate: `channel-accounts.json` loaded by the gateway. MCP mode overrides: `channel-mcp-mode.json`. Both support the same `:thread:` suffix-stripping fallback.

---

## State Files (live, on generic via SSHFS at `~/mnt/generic/`)

| File | Purpose |
|---|---|
| `.local/state/jarvis-voice/jarvis-sessions.json` | channelKey → Claude chatId UUID |
| `.local/state/jarvis-voice/channel-models.json` | Per-channel model overrides |
| `.local/state/jarvis-voice/channel-accounts.json` | Per-channel Claude config-path (profile) |
| `.local/state/jarvis-voice/channel-ask-mode.json` | Per-channel ask-mode flag |
| `.local/state/jarvis-voice/channel-mcp-mode.json` | Per-channel MCP mode (`full`/`off`/subset) |
| `.local/state/jarvis-voice/handoff-pins.json` | Handoff thread pin registry |

---

## Deploy Workflow

Code is authored and tested on gamez (`~/Dev/openjarvis`), then deployed to generic (`~/dev/jarvis-voice/` on generic) where the live services run. The SSHFS mount at `~/mnt/generic/` (on gamez) must be active for deploy and rollback operations.

### Deploy with `scripts/deploy.sh`

```bash
# Full deploy to live (default target = generic)
scripts/deploy.sh

# Explicit target
scripts/deploy.sh generic

# Dry-run — shows what would change, no restart, no writes
scripts/deploy.sh dev
```

The script does:
1. Verifies the SSHFS mount at `$JARVIS_LIVE_MOUNT` (default `~/mnt/generic/dev/jarvis-voice`) is active (exits with error if not)
2. Backs up the current live `src/`, `scripts/`, and `package.json` to `../jarvis-voice.bak/` (one generation kept)
3. Rsyncs `src/`, `scripts/`, and `package.json` from dev to the SSHFS-mounted live path
4. SSHes to generic and restarts both services: `systemctl --user restart jarvis-gateway jarvis-voice`
5. Waits 3 seconds, checks `is-active` for both units, tails 60 lines of combined logs to confirm clean startup

### Systemd services (on generic, `--user`)

| Unit | Purpose |
|---|---|
| `jarvis-voice.service` | Voice I/O + Discord event handling + bot bootstrap |
| `jarvis-gateway.service` | Claude CLI HTTP/SSE adapter (port 22100) |

Both run as `--user` units under the `generic` user account.

```bash
# Check status
ssh generic "systemctl --user status jarvis-voice jarvis-gateway"

# Restart individually
ssh generic "systemctl --user restart jarvis-gateway"
ssh generic "systemctl --user restart jarvis-voice"

# Follow live logs for one service
ssh generic "journalctl --user -u jarvis-voice -f"
ssh generic "journalctl --user -u jarvis-gateway -f"

# Tail both together (recent 100 lines)
ssh generic "journalctl --user -u jarvis-voice -u jarvis-gateway --since '5 minutes ago' --no-pager -n 100"

# Since last boot
ssh generic "journalctl --user -u jarvis-voice -u jarvis-gateway -b --no-pager | tail -80"
```

### Rolling back a bad deploy

`scripts/deploy.sh` saves the previous live state to `../jarvis-voice.bak/` before every deploy. To roll back:

```bash
# Restore via SSHFS
LIVE=~/mnt/generic/dev/jarvis-voice
BAK=~/mnt/generic/dev/jarvis-voice.bak
rsync -avz --delete "$BAK/src/"     "$LIVE/src/"
rsync -avz --delete "$BAK/scripts/" "$LIVE/scripts/"
cp "$BAK/package.json" "$LIVE/package.json"

# Restart after rollback
ssh generic "systemctl --user restart jarvis-gateway jarvis-voice"

# Confirm
ssh generic "systemctl --user is-active jarvis-voice jarvis-gateway"
ssh generic "journalctl --user -u jarvis-voice -u jarvis-gateway --since '20 seconds ago' --no-pager -n 40"
```

Only one backup generation is kept — a subsequent deploy will overwrite `jarvis-voice.bak/`.

---

## Key Source Files

| File | Role |
|---|---|
| `src/index.js` (269 KB) | Bot bootstrap, Discord events, voice receiver, slash dispatch — monolith, refactor planned |
| `scripts/jarvis-gateway.js` (1096 lines) | Claude CLI adapter, session management, per-channel routing |
| `src/spawn.js` | `/spawn` and voice-spawn: creates threads, streams agent output |
| `src/brain.js` | Intent dispatch, response handling |
| `src/focus-state.js` | Channel registry loader, focus tag management |
| `src/alert-webhook.js` (61 KB) | Webhook receiver + alert queue |
| `src/session-manager.js` | Session lifecycle helpers |
| `src/thread-router.js` + `src/thread-orchestrator.js` | Thread-level routing and multi-step orchestration |
| `src/channel-mcp-mode.js` | MCP mode state per channel/thread |
| `haivemind/` | Python memory submodule — see `haivemind/Claude.md` |

---

## Planned Work

See plan: `~/.claude/plans/voice-can-you-figure-noble-patterson.md`

Key open items:
- Rename `package.json` `name` from `jarvis-voice` → `openjarvis`; bump to v2.0.0
- Add `projectPath` / `worktreeMode` to channel-registry and build `src/worktree-manager.js` so each Discord thread gets an isolated git worktree (currently all sessions share the gateway's cwd)
- Refactor `src/index.js` into `src/{voice,discord,brain,agent,alerts,state}/`
