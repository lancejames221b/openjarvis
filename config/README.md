# config/

Static configuration files for jarvis-voice. These are version-controlled defaults
that don't change at runtime (unlike `data/` which holds live state).

## Files

| File | Purpose |
|------|---------|
| *(none yet)* | Future home for static channel registry, shortcut handler registry, etc. |

## vs. data/

- `config/` — static defaults, committed, rarely change
- `data/` — runtime state, committed for persistence across restarts
  - `data/shortcuts.json` — voice-defined shortcuts (added via voice command)
  - `data/focus-state.json` — current channel focus
  - `data/persona-state.json` — active persona
  - `data/task-ledger.json` — voice task tracking
  - `data/thread-registry.json` — Discord thread routing

## vs. prompts/

- `prompts/` — LLM system prompt fragments (voice-main.txt, ack-system.txt, etc.)
- `config/` — structured config (JSON), not natural language prompts
