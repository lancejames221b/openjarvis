# haivemind-remember — Setup

## Requirement: hAIveMind MCP Server

This skill requires the hAIveMind MCP server running and configured in OpenClaw.

hAIveMind is a vector memory database that gives your OpenClaw agent persistent, searchable memory across sessions. It's the same memory system Jarvis uses internally for context across restarts and compaction.

**Repository:** https://github.com/lancejames221b/agent-hivemind

## Install hAIveMind

```bash
# Clone the repo
git clone https://github.com/lancejames221b/agent-hivemind.git
cd agent-hivemind

# Install dependencies
pip install -r requirements.txt

# Start the server (runs on port 8900 by default)
python server.py
```

Or run as a persistent service — see the [agent-hivemind README](https://github.com/lancejames221b/agent-hivemind) for systemd/launchd instructions.

## Configure in OpenClaw

Add to your OpenClaw config:
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

## Verify it's working

```bash
mcporter call haivemind.store_memory content="test memory" category="global"
mcporter call haivemind.search_memories query="test" limit=1
```

## Verify the Skill

After installing, test with:
> "Jarvis, remember that this is a test memory."
> "Jarvis, what do you remember about test memory?"

If Jarvis recalls it, you're good.
