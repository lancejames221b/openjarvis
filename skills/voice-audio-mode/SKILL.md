---
name: voice-audio-mode
description: Manage voice mode and audio mode for response style. Voice mode triggers shorter, conversational replies. Audio mode triggers TTS audio file responses. Use when the user says voice mode on/off, audio mode on/off, on the go, on mobile, on my AirPods, back at desk, mobile mode, desk mode, or text mode.
tier: REACTOR
triggers:
  - "voice mode on"
  - "voice mode off"
  - "audio mode on"
  - "audio mode off"
  - "on the go"
  - "I'm on the go"
  - "on mobile"
  - "on my AirPods"
  - "back at my desk"
  - "back at desk"
  - "mobile mode"
  - "desk mode"
  - "text mode"
---

# voice-audio-mode — Response Style Toggle

Switches Jarvis between voice-optimized and full-detail response modes based on your context.

## Modes

### Voice Mode (on the go)
- Responses are short and conversational — 1-3 sentences max
- No markdown, no lists, no tables in spoken output
- Long results go to Discord text channel, TL;DR spoken
- Jarvis assumes you're mobile, hands-free, can't look at a screen
- Trigger: "on the go", "I'm mobile", "voice mode on", "on my AirPods"

### Text Mode (at desk)
- Full responses, full detail, markdown OK
- Longer analysis and structured output welcome
- Jarvis assumes you have a screen in front of you
- Trigger: "back at my desk", "text mode", "voice mode off", "desk mode"

## How to Use

Just say the trigger phrase naturally in conversation:

> "Jarvis, I'm heading out — on the go mode."
> "Back at my desk."
> "Voice mode on."
> "Switch to text mode."

## What Changes

| Behavior | Voice Mode | Text Mode |
|----------|-----------|-----------|
| Response length | 1-3 sentences | Full detail |
| Format | Plain speech | Markdown OK |
| Long results | TL;DR spoken + Discord | Full in chat |
| Sub-agent output | Spoken summary | Full report |

## Implementation

When voice mode is toggled on:
1. Set a session flag `VOICE_MODE=true`
2. Apply jarvis-voice-briefing pattern to all subsequent responses
3. Acknowledge: *"Voice mode on. I'll keep it brief."*

When voice mode is toggled off:
1. Clear the session flag
2. Acknowledge: *"Text mode. Full detail available."*

This mode is session-scoped — it resets when the conversation ends. For persistent mode across sessions, store the preference in hAIveMind.
