---
name: haivemind-remember
description: Store and recall information in hAIveMind using natural-language requests. Use when the user says things like remember this, save this, don't forget, recall, what do you remember, or asks to retrieve prior decisions, context, or notes.
tier: FRIDAY
triggers:
  - "remember this"
  - "save this"
  - "don't forget"
  - "note that"
  - "remember that"
  - "what do you remember about"
  - "recall"
  - "what did I tell you about"
  - "do you remember"
---

# haivemind-remember — Natural Language Memory

Lets you store and recall anything by just saying it. No commands, no syntax. Just talk to Jarvis like he has a memory — because now he does.

## Examples

> "Jarvis, remember that the staging server password is rotating on Friday."  
> "Note that Andrew prefers email over Slack for status updates."  
> "Don't forget — client prefers morning calls before 10am."  
> "What do you remember about the Gibson project?"  
> "Recall what I said about the deployment process."

## How It Works

Uses the hAIveMind MCP server — a vector database that stores memories as searchable embeddings. Memories persist across sessions, restarts, and compactions.

**Storing:**
```
mcporter call haivemind.store_memory \
  content="[what was said]" \
  category="[appropriate category]"
```

**Retrieving:**
```
mcporter call haivemind.search_memories \
  query="[what they're asking about]" \
  limit=10
```

## Categories

Jarvis automatically categorizes based on content:
- `global` — general notes, preferences, decisions
- `rules` — standing instructions ("always CC John on client emails")
- `operations` — deployments, schedules, processes
- `infrastructure` — servers, services, credentials (handle carefully)
- `development` — code decisions, PR notes, bug context

## Memory Format

Always stored with timestamp and context:
```
[ISO timestamp] [topic]: [content]
```

Memories are retrieved by semantic similarity — you don't need to remember exact phrasing to recall them.

## Setup

Requires hAIveMind MCP server configured in OpenClaw.

See `SETUP.md` for installation instructions.
