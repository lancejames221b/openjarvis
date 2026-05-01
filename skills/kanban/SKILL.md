---
name: kanban
description: Manage the Kanban task board — create, start, list, and trash tasks from Discord or voice. Wraps the kanban CLI to give Jarvis full board access without opening a browser.
tier: DEV
triggers:
  - "create a task"
  - "new task"
  - "show the board"
  - "kanban status"
  - "board status"
  - "start task"
  - "trash task"
  - "list tasks"
  - "what tasks do we have"
  - "add to kanban"
  - "make a kanban task"
  - "list backlog"
  - "what's in progress"
  - "show me the kanban"
  - "what's on the board"
  - "complete the task"
  - "finish the task"
---

# kanban — Task Board Management

Full Kanban board control from voice or Discord. Jarvis can create tasks, move them through columns, link dependencies, and give you a spoken or formatted board summary.

## CLI Reference

All operations use:
```
/usr/bin/node /home/yari/.local/bin/kanban task <subcommand> [options]
```

Abbreviated as `kanban task` below. When a `--project-path` is not specified, the CLI defaults to the current working directory workspace. Always pass `--project-path ~/Dev/openjarvis` for the OpenJarvis project unless the user specifies otherwise.

## Operations

### List tasks

```bash
# All tasks across all columns
kanban task list --project-path ~/Dev/openjarvis

# Filtered by column
kanban task list --project-path ~/Dev/openjarvis --column backlog
kanban task list --project-path ~/Dev/openjarvis --column in_progress
kanban task list --project-path ~/Dev/openjarvis --column review
```

Columns: `backlog` | `in_progress` | `review` | `trash`

### Create a task

```bash
kanban task create \
  --title "Short descriptive title" \
  --prompt "Detailed description of what the agent should do" \
  --project-path ~/Dev/openjarvis
```

Extract `title` and `prompt` from what the user says. If the user gives only a title, use it as both title and a brief prompt.

Optional flags:
- `--base-ref <branch>` — branch to base the worktree on
- `--agent-id <id>` — agent override: `cline` | `claude` | `codex` | `droid` | `gemini` | `opencode` | `default`
- `--start-in-plan-mode` — open task in plan mode (good for complex tasks)

### Start a task

```bash
kanban task start --task-id <id> --project-path ~/Dev/openjarvis
```

Moves the task to `in_progress` and launches an agent session. Get the task ID from `kanban task list`.

### Trash a task

```bash
# Trash a single task
kanban task trash --task-id <id> --project-path ~/Dev/openjarvis

# Bulk-trash an entire column
kanban task trash --column backlog --project-path ~/Dev/openjarvis
```

### Link tasks (dependencies)

```bash
kanban task link \
  --task-id <waiting-task-id> \
  --linked-task-id <prerequisite-task-id> \
  --project-path ~/Dev/openjarvis
```

`--task-id` waits on `--linked-task-id`. When the prerequisite finishes review and moves to trash, the waiting task becomes ready to start.

## Voice Output Format

Keep it brief — one or two sentences spoken aloud, with the full board posted to Discord.

**Board summary:**
> "You have 3 backlog tasks, 1 in progress: feature-session-management. Shall I start one?"

**After creating a task:**
> "Created task: refactor-spawn-handler. It's in backlog. Want me to start it now?"

**After starting a task:**
> "Started feature-session-management. It's now in progress."

**After trashing a task:**
> "Trashed fix-gateway-reconnect. Board updated."

**Empty board:**
> "The board is clear — no active tasks."

## Discord Output Format

Post a formatted board view as a code block. Show only non-empty columns.

```
📋 KANBAN BOARD — openjarvis

📥 Backlog (2)
  • [abc123] refactor-spawn-handler
  • [def456] add-per-channel-tts-config

🔄 In Progress (1)
  • [ghi789] feature-session-management

👀 Review (0)
  (empty)
```

For task creation confirmations, post a compact single-line embed:
```
✅ Task created: refactor-spawn-handler [abc123] — backlog
```

## Parsing User Intent

| User says | Action |
|-----------|--------|
| "create a task to refactor spawn handler" | `task create --title "refactor spawn handler" --prompt "..."` |
| "show the board" / "kanban status" | `task list` → format all columns |
| "what's in progress" | `task list --column in_progress` |
| "list backlog" / "what's in the backlog" | `task list --column backlog` |
| "start task abc123" | `task start --task-id abc123` |
| "trash task abc123" / "remove task abc123" | `task trash --task-id abc123` |
| "link abc123 to def456" | `task link --task-id abc123 --linked-task-id def456` |

If the user says "start a task" without specifying an ID, list backlog tasks first and ask which one to start.

## Error Handling

- If `kanban` exits non-zero, read stderr and surface it: *"Kanban error: [message]. Want me to try again?"*
- If no `--project-path` is clear from context, ask: *"Which project — OpenJarvis, or somewhere else?"*
- Task IDs are short alphanumeric strings (e.g. `abc123`). If the user gives a partial ID or a title, run `task list` first to resolve it.
