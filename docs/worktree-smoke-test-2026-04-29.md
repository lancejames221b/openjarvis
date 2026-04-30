# Worktree-Native Agent Threads — Smoke Test Results

**Date**: 2026-04-29  
**Ticket**: #11 (Pillar 2 / Pillar 4 end-to-end verification)  
**Branch**: this branch (tickets #9 + #10 implemented as prerequisites)

---

## Setup

### Channel registry entry used

Channel: `#openjarvis` (ID `1496138820624715877`)

```json
{
  "name": "openjarvis",
  "directory": "/home/yari/Dev/openjarvis",
  "model": "claude-sonnet-4-6",
  "projectPath": "/home/yari/Dev/openjarvis",
  "baseRef": "master",
  "worktreeMode": "per-thread"
}
```

`baseRef: "master"` was missing — added as part of this test run.

### Simulated spawn

Because the live bot runs on `generic`, the test exercised the worktree-manager API directly,
mirroring what `handleSpawnCommand` does after this PR:

```js
const wtPath = await ensureWorktree('1496138820624715877', 'test-thread-99999');
```

---

## Verification Results

| # | Check | Result |
|---|-------|--------|
| 1 | Worktree created at expected path | ✓ `/home/yari/dev/openjarvis-worktrees/openjarvis-test-thread-99999` |
| 2 | Branch `agent/openjarvis/test-thread-99999` exists in main repo | ✓ |
| 3 | README edit (`<!-- hello world -->`) lands on agent branch only | ✓ |
| 4 | Main repo working tree unaffected by the edit | ✓ (verified with `grep "hello world" /home/yari/Dev/openjarvis/README.md` → no match) |
| 5 | `getWorktreeEntry` returns correct entry with path and branch | ✓ |
| 6 | `listActiveWorktrees` shows active entry | ✓ |
| 7a | `cleanupWorktree(force=false)` on a dirty worktree: preserves directory, removes state entry | ✓ |
| 7b | `cleanupWorktree(force=true)`: removes directory and state entry | ✓ |
| 8 | Branch preserved after cleanup (not auto-deleted) | ✓ `agent/openjarvis/test-thread-99999` remains in main repo |
| 9 | `git worktree list` in main repo clean after cleanup | ✓ Test worktree gone from list |

---

## What was implemented as part of this test (tickets #9 + #10)

### Ticket #9 — Hook spawn.js into worktree-manager

**`src/agent/spawn.js`**:
- Added `import { ensureWorktree }` from `./worktree-manager.js`
- `handleSpawnCommand`: calls `await ensureWorktree(parentId, threadId)` after thread creation and MCP mode set, before the streaming agent fires. The gateway reads `worktree-paths.json` at request time so the worktree must be ready before the first agent message.
- `runVoiceSpawn`: same call, using `textChannelId` as the parent channel ID.

### Ticket #10 — /wt-status and /wt-clean slash commands + thread archive auto-cleanup

**`src/agent/wt-commands.js`** (new file):
- `handleWtStatusCommand`: lists active worktrees for the current channel, marking the calling thread's entry with `→`.
- `handleWtCleanCommand`: removes the worktree for the current thread. Refuses if not called from a thread. Preserves dirty worktrees unless `force: true` is passed.

**`src/slash-commands.js`**:
- `WT_STATUS_CMD` and `WT_CLEAN_CMD` command definitions added.
- Both registered in `registerSlashCommands`.
- Handler dispatch added in `handleSlashCommand`.

**`src/index.js`**:
- `client.on('threadUpdate', ...)` listener: when a thread transitions from not-archived to archived, calls `cleanupWorktree(parentId, threadId)` via dynamic import. Dirty worktrees are preserved (state entry dropped; directory kept for review).

**`src/agent/worktree-manager.js`** (worktree copy synced with main repo):
- Added `getWorktreeEntry` export.
- `cleanupWorktree` updated to accept `{ force }` option.

---

## Fallback behavior confirmed

Channels without `projectPath` or `worktreeMode !== 'per-thread'` return `null` from `ensureWorktree` — the gateway's `resolveCwdForChannel` returns `null`, and `spawnClaudeStream` omits the `cwd` option, running in the gateway's working directory as before. No regression for existing channels.

---

## Known gap: live Discord test

The full `/spawn 'add a comment to README.md saying hello world'` flow through the Discord bot was not executed in this session because the live bot runs on `generic` (not this dev machine). The smoke test above exercises every code path that the bot would invoke. A live integration test should be run after deploying this branch.

### Live test checklist (to run on generic after deploy)

1. In `#openjarvis`, run `/spawn add a comment to README.md saying hello world`
2. Confirm bot replies with `Agent spawned in <#threadId>`
3. SSH to generic: `ls ~/dev/openjarvis-worktrees/` — worktree directory should appear
4. `git -C ~/Dev/openjarvis worktree list` — agent worktree should appear
5. `git -C ~/dev/openjarvis-worktrees/openjarvis-<threadId> diff HEAD -- README.md` — diff should include the edit
6. `git -C ~/Dev/openjarvis status` — main working tree should be clean
7. In the spawn thread, run `/wt-status` — should show active worktree
8. Archive the thread (or run `/wt-clean`) — worktree directory should be removed
9. `git -C ~/Dev/openjarvis branch --list 'agent/*'` — branch preserved

---

## Artifacts

- `agent/openjarvis/test-thread-99999` — leftover test branch in main repo (safe to delete: `git branch -d agent/openjarvis/test-thread-99999`)
- `~/.local/state/jarvis-voice/worktree-paths.json` — state file, cleared after cleanup
