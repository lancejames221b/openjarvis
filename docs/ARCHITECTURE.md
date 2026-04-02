
## Dispatch Routing (CRITICAL — read before changing)

### Streaming (current)
Voice request → SSE stream to gateway → tokens stream back → TTS pipeline → audio plays  
Response channel: same SSE connection. Works reliably.

### /hooks/agent webhook (DO NOT USE for voice)
POST to `/hooks/agent` with `sessionKey=discord-channel` → gateway processes it → response routes to **Discord**, not /speak  
Result: voice tasks disappear silently. This was the Feb 17 2026 outage.

### Correct async pattern (if needed in future)
1. Route to a DEDICATED voice session key (not the Discord channel session)  
2. OR have the gateway model explicitly call `exec curl /speak` as a tool
3. OR use SSE streaming (current approach) — it works, don't change it without proof-of-concept

## Self-Mute TTS Queue (mute-queue.js)

When `MUTE_QUEUE_ENABLED=true`, three intercept points capture TTS text instead of synthesizing:

1. **`flushToPipeline()`** — streaming AI responses (in-flight tasks). Checked before `ttsPipeline.add()`.
2. **`setSpeakCallback()`** — `/speak` webhook calls from sub-agents, cron, etc.
3. **`audioQueue.clear()`** — on mute activation, any already-queued audio is dropped.

On unmute, `voiceStateUpdate` fires the debrief sequence:
- `muteQueueDeactivate()` → `getSummary()` → `synthesizeSpeech()` → `audioQueue.add()`
- `getContextBlock()` injected into `conversations` map so the AI can answer follow-ups
- `markBotResponse(followUpLikely: true)` extends the conversation window (wake bypass)

Module: `src/mute-queue.js` — pure in-memory queue with TTL pruning and priority-aware eviction.

## Self-Optimization Rules (OpenClaw safe)
- **Config patches only** — never edit openclaw.json directly; always `gateway config.patch`  
- **`allowRequestSessionKey`** — keep `false` unless you know the routing implications  
- **Brain.js has 3 identical `const voiceMessage` lines** — always `grep -n` before editing  
- **`node --check src/index.js` before every commit** — non-negotiable  
- **Test one curl manually** before wiring a new dispatch path into production  
