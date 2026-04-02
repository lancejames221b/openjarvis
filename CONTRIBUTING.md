# Contributing

## Before you start

Jarvis Voice is the voice layer for [OpenClaw](https://openclaw.ai). The core pipeline is intentionally tight and opinionated — changes to the voice path (VAD, speaker verify, STT, TTS, FSM state) need a clear rationale. Other areas (new STT providers, Docker improvements, docs, platform support) are very welcome.

## What's in scope

- New STT provider integrations (OpenAI Whisper API, AssemblyAI, etc.)
- New TTS provider support (Coqui, Kokoro, OpenAI TTS, etc.)
- Docker / deployment improvements
- Mac / Windows support
- Platform-specific bug fixes (CUDA version compat, opus build issues, etc.)
- Documentation improvements
- Test coverage

## What needs discussion first

- Changes to the FSM state machine (`src/bot-state.js`)
- Changes to the voice pipeline core (`src/index.js`, `src/stt.js`, `src/tts.js`)
- New wake word mechanisms
- Discord API version changes (DAVE E2EE is mandatory as of March 2026)

Open an issue first for any of the above.

## Setup

```bash
git clone https://github.com/owner221b/jarvis-voice.git
cd jarvis-voice
npm install

# Python services (pick your platform)
./setup-gpu-env.sh --cpu    # CPU-only, no GPU needed for dev
./setup-gpu-env.sh --cuda   # NVIDIA GPU
./setup-gpu-env.sh --metal  # Apple Silicon
```

Mac development:

```bash
cp .env.mac-test.example .env.mac-test
# fill in a test bot token
./scripts/mac-test.sh
```

## Code style

- Match the surrounding code's style — don't reformat unrelated lines
- No emoji in comments or docs
- Errors logged with context, not swallowed
- No new dependencies without discussion

## Pull requests

- One logical change per PR
- Include a brief description of what changed and why
- If it touches the voice pipeline, describe how you tested it
- Reference any related issues

## Reporting bugs

Open an issue with:
- Platform (OS, GPU, Node/Python versions)
- Relevant log output (`journalctl --user -u jarvis-voice -n 100`)
- Steps to reproduce
