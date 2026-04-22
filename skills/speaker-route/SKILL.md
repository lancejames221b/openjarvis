---
name: speaker-route
description: Route Jarvis audio responses to a Sonos speaker. Mic stays on Discord/phone — only the output is redirected. Supports per-message routing and a persistent speaker mode that stays active until turned off.
tier: JARVIS
triggers:
  - "say that on the speaker"
  - "play that on the speaker"
  - "send that to the speaker"
  - "route to speaker"
  - "speaker mode on"
  - "speaker mode off"
  - "switch to kitchen speaker"
  - "switch to bedroom speaker"
  - "follow me to the kitchen"
  - "follow me to the bedroom"
  - "play through the speaker"
  - "say that downstairs"
  - "say that upstairs"
  - "stop speaker mode"
  - "turn off speaker mode"
---

# speaker-route — Route Jarvis Audio to Sonos

Discord/phone stays the input. Jarvis's spoken response comes out of whichever Sonos speaker you choose instead of (or in addition to) the phone.

## Examples

> "Say that on the speaker."
> "Switch to bedroom speaker."
> "Follow me to the kitchen — speaker mode on."
> "Speaker mode off."
> "Play that downstairs."

## Speaker Targets

| User says | Target | sonos-say arg |
|-----------|--------|---------------|
| "kitchen", "downstairs" | Kitchen Sonos | `down` |
| "bedroom", "upstairs", "bathroom" | Bedroom Sonos | `up` |
| "everywhere", "all speakers", "whole house" | Both | `all` |
| *(no location, mode on)* | Default (down) | `down` |

## Modes

### Per-message routing

User says "say that on the speaker" or "send that to the bedroom" — route only the current response, then return to normal.

After generating your response text:
1. Call `sonos-say <target> "<response text>"`
2. Keep the Discord text reply as normal
3. No persistent state change

### Speaker mode (persistent)

User says "speaker mode on" or "switch to [speaker]" — all subsequent Jarvis responses also play on that speaker until turned off.

1. Write the target to `/tmp/jarvis-speaker-mode` (e.g. `down`, `up`, or `all`)
2. Confirm: *"Speaker mode on — routing audio to [speaker]. Say 'speaker mode off' to stop."*
3. On every subsequent response: read `/tmp/jarvis-speaker-mode`, call `sonos-say` with the response text

To check if speaker mode is active:
```bash
cat /tmp/jarvis-speaker-mode 2>/dev/null
```
Empty or missing = mode off.

### Turn off speaker mode

User says "speaker mode off" or "stop speaker mode":
```bash
rm -f /tmp/jarvis-speaker-mode
```
Confirm: *"Speaker mode off — audio back to Discord only."*

## Response Routing

When routing to speaker, the response text should be:
- Natural spoken language (no markdown, no bullet points, no emoji)
- Concise — trim any lengthy formatted sections to a spoken summary
- The same Jarvis voice: warm, direct

Keep the full text response in Discord as usual. The speaker gets a clean spoken version.

## Script

```bash
sonos-say <up|down|all> "response text"
```

## Persistent State File

```
/tmp/jarvis-speaker-mode   — contains: up | down | all
```

Missing or empty = speaker mode off.

## Always Check on Startup

At the start of every response, check if speaker mode is active:
```bash
SPEAKER_TARGET=$(cat /tmp/jarvis-speaker-mode 2>/dev/null)
```
If non-empty, append a sonos-say call after generating your response.
