---
name: jarvis-voice
description: Install and configure Jarvis Voice — a real-time Discord voice assistant for OpenClaw. Speak in a Discord voice channel and your OpenClaw agent responds by voice.
---

# Jarvis Voice Skill

This skill installs [Jarvis Voice](https://github.com/lancejames221b/jarvis-voice) — a Discord bot that bridges voice channels to your OpenClaw gateway agent.

## What it does

Speak in a Discord voice channel. The bot transcribes your speech, sends it to your OpenClaw gateway (the same agent handling your text channels, with all its tools), and speaks the response back in the channel.

## Prerequisites

- Linux with systemd (Ubuntu 22.04+ recommended)
- Node.js 18+
- Python 3.12+ (for local Whisper STT)
- ffmpeg (`apt install ffmpeg`)
- A Discord bot token ([create one here](https://discord.com/developers/applications)) — must be a separate bot from your main OpenClaw bot
- Your OpenClaw gateway URL and token

## Install

```bash
bash skill/install.sh
```

The installer checks dependencies, scaffolds your `.env`, installs npm packages, and creates the systemd user service.

## After Install

1. `systemctl --user start jarvis-voice`
2. Join your configured Discord voice channel
3. Speak — your OpenClaw agent responds by voice

## Feature Flags

Key flags in `.env`:

| Flag | Default | Effect |
|------|---------|--------|
| `WAKE_WORD_ENABLED` | `false` | Require "Jarvis" before each command |
| `VOICE_ACK_ENABLED` | `false` | Say "On it" before thinking (adds ~1s latency) |
| `STT_PROVIDER` | `faster-whisper` | faster-whisper / deepgram / mlx-whisper / whisper |
| `TTS_PROVIDER` | `edge` | edge (free) / openai (paid) / piper (local) |
| `STREAMING_TTS_ENABLED` | `true` | Sentence-by-sentence TTS for faster first word |

See `.env.example` for all flags with descriptions.

## Webhook API

The bot exposes a webhook server (default port 3335) for pushing alerts and content to voice. See [README.md](../README.md#webhook-api) for full docs.
