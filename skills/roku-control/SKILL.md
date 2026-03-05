---
name: roku-control
description: Control Roku devices via the ECP (External Control Protocol). Supports playback commands (play, pause, home, back) and launching content from Plex, Netflix, Disney+, and other channels. Use when controlling TV playback, launching shows or movies on a specific TV, or managing multi-room media by voice.
tier: FRIDAY
triggers:
  - "pause the TV"
  - "play"
  - "pause"
  - "resume"
  - "stop"
  - "go home"
  - "go back"
  - "play X on Plex"
  - "launch Netflix"
  - "turn on the TV"
  - "on the projector"
  - "in the bedroom"
  - "in the living room"
  - "on the TV"
---

# roku-control — Voice TV Control

Pause the game. Resume the show. Launch Plex. All by voice.

Talks to Roku devices directly via their built-in HTTP API (ECP — External Control Protocol). No cloud required, no Roku account needed. Just your local network.

## Examples

> "Jarvis, pause the TV."  
> "Resume."  
> "Play The Expanse on Plex, on the projector."  
> "Go home on the bedroom TV."  
> "Launch Netflix in the living room."  
> "Turn it off."

## How It Works

Roku exposes a simple HTTP API on port 8060. Jarvis sends commands directly:

```
POST http://ROKU_IP:8060/keypress/Play
POST http://ROKU_IP:8060/keypress/Pause
POST http://ROKU_IP:8060/launch/2285   # Plex channel ID
```

No authentication required on your local network.

## Available Commands

| Command | What happens |
|---------|-------------|
| play / resume | Resume playback |
| pause | Pause playback |
| stop | Stop playback |
| home | Go to Roku home screen |
| back | Go back one screen |
| up/down/left/right | Navigate |
| select | Select current item |
| launch [app] | Open an app by name |
| play [content] on [app] | Search and launch content |

## Multi-Room Support

Configure named rooms for natural language:

> "in the bedroom", "on the projector", "in the living room", "on the main TV"

Map room names to Roku IPs in `SETUP.md`.

If no room specified, commands go to the default Roku.

## Content Search

When you say "play X on Plex", Jarvis:
1. Launches the Plex app on the Roku
2. Uses Plex's search to find X (requires Plex skill or Plex URL configured)
3. Starts playback

For other apps (Netflix, Disney+, etc.), Jarvis launches the app — search within the app is done on the Roku itself.

## Setup

See `SETUP.md` for Roku IP discovery and room configuration.
