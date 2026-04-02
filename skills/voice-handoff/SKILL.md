---
name: voice-handoff
description: Hand off current context, task status, or summary to Jarvis Voice. Use when the user says hand off to voice, sending this to voice, or switches to voice mode mid-task.
tier: REACTOR
triggers:
  - "hand off to voice"
  - "sending this to voice"
  - "switch to voice"
  - "take this to voice"
  - "I'm switching to voice"
  - "continue this in voice"
---

# voice-handoff — Context Handoff to Voice

When you're mid-task in text chat and switching to voice, this skill packages the current context so Jarvis Voice can pick up exactly where you left off.

## What It Does

1. Summarizes the current task/context in 2-4 spoken sentences
2. Posts the full context to your Discord text channel (for reference)
3. Flags Jarvis Voice to expect a continuation
4. Confirms: *"Context ready. Join your voice channel and pick up from there."*

## Use Cases

- You're on your laptop reviewing a PR, switching to AirPods to continue
- You were reading a security report in chat, want a spoken briefing while commuting
- You started a research task in text, want Jarvis to continue narrating while you drive

## Implementation

When triggered:

1. **Summarize current context:**
   - What task is in progress
   - Key findings or decisions so far
   - What the next step is
   - Any pending questions or actions

2. **Post to text channel:**
   ```
   🎙️ VOICE HANDOFF — [timestamp]
   
   Context: [what was happening]
   Status: [where things stand]
   Next: [what Jarvis should do or say when voice connects]
   ```

3. **Store in hAIveMind** (if configured):
   ```
   store_memory: "VOICE_HANDOFF [timestamp]: [summary]"
   category: "operations"
   ```

4. **Spoken confirmation:**
   *"Context packaged. Join [voice channel] and say 'continue' — I'll pick up from there."*

## In Voice Mode

When the user joins voice and says "continue" or "where were we":
1. Search hAIveMind for recent VOICE_HANDOFF entry
2. Brief them on the context (2-3 sentences)
3. Ask: "Want to continue with [next step]?"

## Configuration

No required configuration. Optionally set your voice channel name in the skill so Jarvis can reference it by name in the handoff confirmation.
