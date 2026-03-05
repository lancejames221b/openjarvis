# haivemind-remember — Setup

## Requirement: hAIveMind MCP Server

This skill requires the hAIveMind MCP server running and configured in OpenClaw.

hAIveMind is a vector memory database that gives your OpenClaw agent persistent, searchable memory across sessions.

## Install hAIveMind

1. Clone and configure hAIveMind (see https://clawhub.com for available MCP packages)

2. Add to your OpenClaw config:
```json
{
  "mcp": {
    "servers": {
      "haivemind": {
        "command": "mcporter",
        "args": ["serve", "haivemind"]
      }
    }
  }
}
```

3. Verify it's working:
```bash
mcporter call haivemind.store_memory content="test memory" category="global"
mcporter call haivemind.search_memories query="test" limit=1
```

## Verify the Skill

After installing, test with:
> "Jarvis, remember that this is a test memory."
> "Jarvis, what do you remember about test memory?"

If Jarvis recalls it, you're good.
