---
name: dev-agent
description: Launch a safe Claude Code subagent development session for a repo. Use when the user wants to start building a feature, write code, or kick off a coding task. Opens an isolated branch with safety guardrails — agents commit freely but cannot push, open PRs, or touch main.
tier: JARVIS
triggers:
  - "start building"
  - "open a dev session"
  - "work on"
  - "code up"
  - "build a feature"
  - "start a coding session"
  - "spin up a dev session"
  - "start coding"
  - "let's build"
  - "I need to work on"
  - "build me"
  - "start a subagent session"
  - "dev session for"
---

# dev-agent — Safe Subagent Development Sessions

Launches an isolated Claude Code session for a repo, with safety guardrails baked in. Agents can commit freely to feature branches but cannot push, open PRs, or touch main/master.

## Examples

> "Jarvis, start building a new Jarvis skill for controlling my thermostat."
> "Open a dev session for openjarvis."
> "Let's build a Discord slash command handler."
> "Spin up a subagent session to add WebSocket support to haivemind."

## What It Does

1. Parses the **repo name** and **task description** from the voice command
2. Calls `dev-session <repo> "task description"` — a script that:
   - Resolves the repo path under `~/Dev/`
   - Creates a feature branch (`dev/<task-slug>`)
   - Scaffolds a plan file at `docs/superpowers/plans/<task-slug>-plan.md`
   - Writes safety constraints to `.claude/CLAUDE.md`
   - Opens a new qterminal with Claude Code ready to work
3. Responds with confirmation of what was launched

## Safety Model

| Action | Allowed |
|--------|---------|
| Write/edit files | ✅ |
| Commit to feature branch | ✅ |
| Run tests | ✅ |
| Push to remote | ❌ never |
| Open PRs | ❌ never |
| Merge to main/master | ❌ never |

## Parsing Rules

Extract two things from the voice command:

| User says | repo | task |
|-----------|------|------|
| "build a thermostat skill for openjarvis" | openjarvis | thermostat skill |
| "dev session for haivemind WebSocket support" | haivemind | websocket support |
| "open a dev session" (no repo) | ask user | ask user |
| "start coding the billing module in claudeflare" | claudeflare | billing module |

If repo is ambiguous or missing, ask: **"Which repo — openjarvis, haivemind, claudeflare, or another?"**

If task is missing, ask: **"What do you want to build?"**

## Confirmation Response

After calling dev-session, respond:

> "Opening a dev session for [repo]. Working on [task] in a new feature branch. Safety guardrails are on — I'll commit freely but won't push or open any PRs."

## Script

```bash
dev-session <repo-name> "task description"
```

See `SETUP.md` for installation and repo path configuration.
