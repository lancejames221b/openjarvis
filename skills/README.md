# Jarvis Skills Library

Skills are OpenClaw capabilities you install on top of the voice bot. Each one adds a new power to Jarvis — comms, briefings, home control, memory.

Install them by copying the skill folder to your OpenClaw skills directory. Jarvis will prompt you to configure anything that's missing.

---

## Skills by Tier

### REACTOR (included — no extra install)

These patterns are baked into the voice bot. No copy needed.

| Skill | What it does | Trigger |
|-------|-------------|---------|
| [jarvis-voice-briefing](jarvis-voice-briefing/) | Voice TL;DR + full report to Discord | automatic |
| [voice-audio-mode](voice-audio-mode/) | Switch between voice-optimized and full-detail mode | "on the go", "back at my desk" |
| [voice-handoff](voice-handoff/) | Hand off mid-task context from text to voice | "hand off to voice" |

---

### FRIDAY (+30 min setup)

Daily intelligence. Your day, briefed. Your messages, checked. Your home, controlled.

| Skill | What it does | Deps | Trigger |
|-------|-------------|------|---------|
| [pulse](pulse/) | Morning briefing: calendar, weather, email, Slack, PRs | Google Workspace MCP | "brief me", "good morning Jarvis" |
| [comms-check](comms-check/) | iMessage + Signal + calls since last check | Mac node, Signal daemon | "comms check", "check my texts" |
| [roku-control](roku-control/) | Voice TV control (pause, play, launch apps) | Roku on local network | "pause the TV", "play X on Plex" |
| [haivemind-remember](haivemind-remember/) | Natural language memory (store + recall anything) | hAIveMind MCP | "remember this", "what do you remember about" |
| [where-is](where-is/) | Item location memory | hAIveMind MCP | "I put X in Y", "where is my X" |

---

### JARVIS (+60 min setup)

Everything. Full capability.

| Skill | What it does | Deps | Trigger |
|-------|-------------|------|---------|
| [plex-media](plex-media/) | Download movies/TV to Plex on demand | qBittorrent, Plex, indexer | "get me X", "download X", "add X to Plex" |
| [jarvis-evolve](jarvis-evolve/) | Self-evolution: Jarvis recommends, packages, and shares skills | `gh` CLI for PRs | "make this a skill", "share this", automatic |

---

## Installing Skills

### Find your OpenClaw skills directory

```bash
openclaw skills list 2>/dev/null | head -5
# Common paths: ~/.openclaw/skills/  or  ~/dev/skills/
```

### Install a tier

```bash
SKILLS_DIR=~/.openclaw/skills   # adjust to your path

# FRIDAY tier
cp -r skills/pulse skills/comms-check skills/roku-control \
      skills/haivemind-remember skills/where-is \
      $SKILLS_DIR/

# Add JARVIS tier
cp -r skills/plex-media $SKILLS_DIR/
```

### Or let Jarvis install them

Say **"install Jarvis"** in OpenClaw. The install skill will ask which tier you want and copy the right skills automatically.

---

## Configuring Skills

Each skill folder has a `SETUP.md` explaining what it needs. Most skills need one of:

- **Mac node** — pair your Mac with OpenClaw so Jarvis can read iMessages/call history
- **hAIveMind** — vector memory database MCP server (free, self-hosted)
- **Google Workspace MCP** — for calendar and email
- **Slack MCP** — for Slack highlights in briefings
- **Signal daemon** — signal-cli running locally for Signal messages

Jarvis will ask for anything it's missing. Just answer the questions.

---

## Building Your Own Skills

Skills are markdown files with a YAML header. The format:

```yaml
---
name: my-skill
description: What this skill does and when to use it.
model: sonnet-high        # optional — override the model
triggers:
  - "phrase that activates this"
  - "another trigger phrase"
---

# my-skill — What It Does

Instructions for the AI on how to execute this skill.
```

Drop the folder in your OpenClaw skills directory. OpenClaw loads it automatically.

See [OpenClaw docs](https://docs.openclaw.ai/skills) for the full skill authoring guide.

---

## Contributing Skills

Have a skill that would make Jarvis more useful for others? PRs welcome.

Requirements:
- No personal info, hardcoded IPs, or account-specific data
- Placeholders for any required config (`YOUR_MAC_NODE_NAME`, etc.)
- `SETUP.md` explaining what the user needs to configure
- Tested on at least one clean OpenClaw install

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the PR process.
