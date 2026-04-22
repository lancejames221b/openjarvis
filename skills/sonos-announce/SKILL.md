---
name: sonos-announce
description: Send a Jarvis-voiced TTS announcement to a Sonos speaker in the house. Uses Chatterbox for voice generation. Use when the user wants to send a spoken message to someone in another room via a Sonos speaker.
tier: FRIDAY
triggers:
  - "tell [name] to"
  - "announce"
  - "say on the sonos"
  - "send a message to the kitchen"
  - "send a message to the bedroom"
  - "let her know"
  - "let him know"
  - "message the speaker"
  - "play on sonos"
  - "say upstairs"
  - "say downstairs"
---

# sonos-announce — House Announcements via Jarvis Voice

Send a spoken message to any Sonos speaker in the house using the Jarvis (Chatterbox) voice.

## Examples

> "Jarvis, tell [name] to check their phone."
> "Say on the kitchen speaker: dinner is ready."
> "Announce upstairs that I'm heading out."
> "Send a message to the bedroom."

## Speakers

Speakers are configured in `.env`:

| Variable | Description |
|----------|-------------|
| `SONOS_DOWN_IP` | Downstairs speaker IP (e.g. kitchen) |
| `SONOS_UP_IP` | Upstairs speaker IP (e.g. bedroom) |
| `SONOS_DEFAULT` | Default target: `up`, `down`, or `all` |
| `GAMEZ_IP` | IP of the machine serving the audio file |
| `GAMEZ_PORT` | Port for the audio HTTP server (default: 8765) |
| `CHATTERBOX_HOST` | SSH alias for the machine running Chatterbox TTS |
| `CHATTERBOX_URL` | Chatterbox endpoint (default: http://localhost:3340/tts) |

## Routing

Location is inferred from natural language:

| User says | Target |
|-----------|--------|
| "upstairs", "bedroom", "bathroom" | `up` |
| "downstairs", "kitchen", "living room" | `down` |
| "everywhere", "all speakers", "the whole house" | `all` |
| *(no location)* | `$SONOS_DEFAULT` (default: `down`) |

## Script

```bash
sonos-say <up|down|all> "message"
```

See `SETUP.md` for installation.

## Message Style

- Speak on the user's behalf, warmly and naturally
- Default phrasing: "Hey [name], [user] [wanted/was wondering/asked me to let you know] ..."
- Keep it brief — this is a spoken announcement, not an essay
- Always use the **jarvis** voice

## Example Transformations

| User says | Jarvis announces |
|-----------|-----------------|
| "Tell [name] to check their phone" | "Hey [name], [user] was wondering if you would check your phone." |
| "Let her know dinner is ready" | "Hey [name], [user] wanted to let you know that dinner is ready." |
| "Tell her I'll be there in 5" | "Hey [name], [user] will be there in about five minutes." |
