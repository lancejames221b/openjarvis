# Kanban Channel Integration — Scale Report

**Date:** 2026-05-02
**Status:** Pre-deploy. All tests pass on gamez (dev). Not yet deployed to generic (live).
**Commits:** `1e5cf56` (skill), `5afba8e` (dispatch + registry helpers + slash command + tests)

---

## 1. What Was Built

### `skills/kanban/SKILL.md` — voice/Discord skill spec
The skill file declares the voice and Discord triggers Jarvis listens for ("create a task", "show the board", "kanban status", "what's in progress", "trash task", etc.) and documents the full CLI surface used to fulfill them: `kanban task list|create|start|trash|link` invoked as `/usr/bin/node $HOME/.local/bin/kanban task …` with `--project-path` always passed explicitly. The skill defines voice output style (one-or-two-sentence spoken summary plus a formatted board posted to Discord), the Discord output format (code-block board grouped by column with task IDs), and the user-intent → CLI-args mapping. A companion `skills/kanban/SETUP.md` documents install, path resolution on dev vs. live, and a smoke-test sequence (`task list → task create → task list --column backlog → task trash`).

### Channel-registry extensions — `src/state/focus-state.js:97-111`
Two helpers were added to the focus-state module: `isKanbanChannel(channelId)` returns `true` only when the registry entry has the new `kanbanEnabled: true` flag, and `getKanbanPath(channelId)` resolves the project path the CLI should target — preferring the new `kanbanPath` field, falling back to the existing `path` field, returning `null` if neither is set. Both helpers are thread-aware via the existing `_registryEntry()` lookup, which strips `:thread:<id>` suffixes so threads inherit their parent channel's Kanban configuration. Schema additions to a registry entry: `{ kanbanEnabled: boolean, kanbanPath: string }`.

### `/new-kanban-channel` slash command — `src/discord/slash/new-kanban-channel.js`
A new slash command that takes `name`, `project-path`, and an optional `category`, then in sequence: (1) creates a Discord text channel under the chosen category with the project path baked into the channel topic, (2) atomic-writes a registry entry to `$CHANNEL_REGISTRY_PATH` (or `~/dev/contexts/channel-registry.json`) marking the channel `kanbanEnabled: true` with `kanbanPath` set, and (3) bootstraps the Kanban workspace by shelling out to `kanban task list --project-path <path>` (which auto-registers the workspace on first call). The command validates that `project-path` is absolute, exists, and is a directory before creating anything; if registry write fails after channel creation, the user is told the channel exists but registry needs manual fix-up rather than rolling back. The command is built (`NEW_KANBAN_CHANNEL_CMD`, `slash-commands.js:175-183`), registered with Discord (`slash-commands.js:347`), and routed (`slash-commands.js:641-651`).

### `src/kanban-dispatch.js` — natural-language dispatch chain
`tryKanbanDispatch(transcript, channelId, options)` runs **before** the brain in `dispatchCommand()`. It guards with `isKanbanChannel(channelId)` — non-Kanban channels return `{handled: false}` immediately and pay zero cost. In a Kanban channel it pattern-matches the cleaned transcript against six intent regexes (create, list, list-backlog, list-in-progress, start, trash) tolerating an optional `jarvis,` wake prefix and trailing period. Matched intents shell out via `execFile` to `${KANBAN_BIN}` (default `~/.local/bin/kanban`) using the project path from `getKanbanPath()`. CLI JSON output is parsed and reformatted: `list` produces a four-column code-block board for Discord plus a one-line voice summary; `create`/`start`/`trash` produce an emoji-prefixed confirmation and a brief spoken acknowledgement. CLI failure or `ok:false` JSON is converted to a user-visible error message but still returns `handled: true` so the brain doesn't double-handle it. The dispatcher is hooked into `src/discord/command-dispatch.js:307-327` (just after stop-word, before the LLM shortcut fast-path) gated on `channelId` being present; any thrown error is logged and falls through to the normal brain dispatch. The result type `{type: 'kanban', speech, discordText, silent}` is rendered in `src/index.js:4710-4727` — TTS speaks `speech` (if present and not silent), then posts `discordText` to the focus channel via the Discord REST API.

### Test coverage — `src/__tests__/feature-kanban-dispatch.test.js` (25 tests)
> Naming note: the file is `feature-kanban-dispatch.test.js`, not `feature-kanban-integration.test.js` as the task referenced. Coverage matches what was scoped.

The suite mocks `state/focus-state.js` (so `isKanbanChannel` / `getKanbanPath` are toggleable per test) and injects a fake `exec` to assert the exact CLI argv. Coverage groups:
- **Non-Kanban channel:** create, list, and unrelated transcripts all return `handled:false` and never invoke the CLI.
- **Create:** `"create a task: …"`, `"new task: …"`, `"create task: …"` all match; verifies argv contains `task create --title <…> --prompt <…> --project-path <…>`; verifies voice summary string.
- **List:** `"show the board"`, `"kanban status"`, `"board status"`, `"list tasks"` all match; verifies output contains all four column labels wrapped in a Discord code block.
- **Column-filtered list:** `"show backlog"` / `"what's in backlog"` add `--column backlog`; `"what's in progress"` / `"active tasks"` add `--column in_progress`.
- **Start / trash:** asserts task-id capture and correct argv; trash also matches `"done with task <id>"`.
- **Negative cases:** unrelated input, empty transcript, `"create a task"` without colon/title all return `handled:false`.
- **CLI failure:** thrown exec errors and `ok:false` JSON both yield `handled:true` with a surfaced error message.

A second test file (`src/__tests__/command-dispatch.test.js`, +66 lines in commit `5afba8e`) verifies the hook into `dispatchCommand`: that `tryKanbanDispatch` is called when `channelId` is present, that `handled:true` returns a `type: 'kanban'` dispatch result with `speech` and `discordText` populated, and that thrown errors are caught and fall through.

---

## 2. Wired End-to-End Right Now

- [x] Skill file exists at `skills/kanban/SKILL.md` and would be picked up by `/sync-skills`.
- [x] Registry helpers `isKanbanChannel` and `getKanbanPath` exported from `src/state/focus-state.js:97` and `:107`.
- [x] Slash command `/new-kanban-channel` defined (`slash-commands.js:175`), registered with Discord (`slash-commands.js:347`), routed (`slash-commands.js:641`).
- [x] `tryKanbanDispatch` hooked into `src/discord/command-dispatch.js:314` between stop-word handling and the LLM shortcut fast-path.
- [x] `type: 'kanban'` dispatch result handled in `src/index.js:4710` — TTS for voice summary, Discord REST post for board text.
- [x] Tests passing: **27 test files / 710 tests passed** (`npm test --run`). Kanban suite is 25 of those.

---

## 3. What Still Needs to Happen Before Live Deploy

1. **Kanban CLI on generic.** Verify `/usr/bin/node /home/lance/.local/bin/kanban` (or whatever path resolves on generic) exists. The skill SETUP.md and `kanban-dispatch.js` both default to `${HOME}/.local/bin/kanban`, so on generic that resolves to `/home/lance/.local/bin/kanban`. Run `ssh generic "which kanban; ls -la ~/.local/bin/kanban; node ~/.local/bin/kanban --version"`. If absent, install with `npm install -g @cline/kanban` on generic before deploy. The dispatcher honors `KANBAN_BIN` and `KANBAN_NODE_BIN` env overrides — set them in the systemd unit if the path differs from the default.

2. **Channel registry path on generic.** The `/new-kanban-channel` slash command and `_registryEntry()` both read `CHANNEL_REGISTRY_PATH` (with `JARVIS_CHANNEL_REGISTRY` as a fallback). On gamez this defaults to `~/dev/contexts/channel-registry.json`. Confirm the same path exists on generic (with the same channel entries already there) or set the env var in the `jarvis-voice.service` unit. If the directory doesn't exist on generic, the slash command's parent-dir guard will short-circuit with a warning rather than crash, but no entry will be written.

3. **Discord slash command registration.** `/new-kanban-channel` is registered every time `jarvis-voice` boots via `registerSlashCommands()` (`slash-commands.js:337-353`), which writes to `applicationGuildCommands`. After deploy and `systemctl --user restart jarvis-voice`, the command should appear in Discord's command picker within a few seconds. No separate `deploy-commands` script is needed in this codebase.

4. **Skill sync.** Run `/sync-skills` in a Discord channel after deploy so the kanban SKILL.md is loaded into Jarvis's active skill index. The skill is in `skills/kanban/` — already matches the directory layout the existing skills use.

5. **Smoke test on live.**
   - `/new-kanban-channel name:test-kanban project-path:/home/lance/dev/jarvis-voice` — confirm channel created, registry entry written (`ssh generic "cat ~/dev/contexts/channel-registry.json | jq '.[\"<id>\"]'"`), and the workspace bootstrap reply lands without an error block.
   - In the new channel, type `show the board` — expect a code-block board (probably empty) with the four columns and a brief voice summary.
   - In the new channel, type `create a task: smoke test kanban dispatch` — expect `✅ Task created: …`. Then `show the board` again to confirm the task is in backlog.
   - `journalctl --user -u jarvis-voice --since '2 minutes ago'` — confirm no `error|fail|exception` entries from `[kanban-dispatch]` or `[new-kanban-channel]`.

---

## 4. Known Gaps / Follow-on Tickets

- **`/spawn` → Kanban task auto-creation.** When `/spawn` is run inside a Kanban-enabled channel, no task is created — the agent thread is detached from the board. Follow-up: make `runVoiceSpawn` / `handleSpawnCommand` check `isKanbanChannel(parentId)`, call `kanban task create` with the spawn prompt, capture the task ID, and stash it in the thread's session metadata so the thread maps 1:1 to a task.
- **Task completion detection.** Nothing currently moves a task from `in_progress` → `review` when the agent finishes. Options to spec: time-based (no activity for N minutes), thread-archive event, explicit "done" trigger from the agent, or wired to the existing handoff/completion signal in `thread-orchestrator.js`. Needs a small state machine in the dispatch path.
- **Multi-project board view.** `/kanban-status` (or a `task list --all` flavor) that walks every `kanbanEnabled` registry entry and prints a one-section-per-project rollup. Useful for "what's everyone working on" without channel-hopping. Probably best as a slash command rather than a natural-language verb to keep the dispatch path narrow.
- **Per-channel project-path override.** Today `--project-path` always resolves from the registry. Consider letting `tryKanbanDispatch` accept an inline `--project <name>` token in the transcript so a user in `#general` can ask about another project's board without the channel needing `kanbanEnabled`.
- **Trash confirmation for bulk operations.** The skill documents `kanban task trash --column backlog` (bulk) but the dispatcher only matches `trash task <id>`. Bulk-trash is intentionally not exposed via natural language — could be a `/kanban trash-column` slash command if needed.

---

## Verification Evidence

```
$ npm test -- --run
Test Files  27 passed (27)
     Tests  710 passed (710)
  Duration  1.21s
```

`feature-kanban-dispatch.test.js` — 25 tests passing.
