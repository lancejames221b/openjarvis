# Changelog

All notable changes to Jarvis Voice are documented here.

---

## [1.0.0] — 2026-03-05

First public release. The beginning.

### What's here

**The voice bot**
- Real-time Discord voice: speak → Whisper STT → OpenClaw gateway → Piper TTS → voice response
- Discord DAVE E2EE compliant (voice gateway v8, mandatory as of March 2026)
- 6 STT providers: faster-whisper (GPU), Deepgram, MLX Whisper (Apple Silicon), whisper CLI, Moonshine, Vosk
- Piper TTS with custom Jarvis British RP voice model (local, no cloud account)
- Speaker voiceprint authentication via ECAPA-TDNN (SpeechBrain)
- Wake word detection with fuzzy matching and conversation windows
- FSM state machine: IDLE → ACTIVE → SLEEP with alert delivery rules
- Streaming TTS (sentence-level) for sub-2s time-to-first-word
- Self-mute queue: messages buffered while you're muted, debriefed on unmute
- Implicit wake on self-unmute: first word after unmuting doesn't require "Jarvis"
- Mobile/voice mode: shorter responses for hands-free use
- Alert webhook: sub-agents and cron jobs can speak results by voice via POST /speak
- Multi-provider gateway resilience: timeout, retry, circuit breaker

**Three tiers**
- REACTOR — voice bot, personality, voiceprint (~15 min setup)
- FRIDAY — + briefings, comms check, media control, memory (~45 min)
- JARVIS — + full skills library, everything (~2 hrs)

**OpenClaw integration**
- `openclaw/INSTALL_PLAYBOOK.md` — machine-executable step-by-step install guide
- `openclaw/skills/install-jarvis/` — say "install Jarvis" to start (Opus High)
- `openclaw/skills/jarvis-enroll/` — guided voiceprint enrollment

**Skills library** (9 generalized OpenClaw skills)
- `jarvis-voice-briefing` — voice TL;DR + full report pattern
- `voice-audio-mode` — on the go / desk mode toggle
- `voice-handoff` — text → voice context handoff
- `haivemind-remember` — natural language memory
- `where-is` — item location memory
- `pulse` — daily morning briefing
- `comms-check` — unified comms (iMessage + Signal + calls)
- `roku-control` — voice TV control
- `plex-media` — media on demand
- `jarvis-evolve` — self-evolution: Jarvis recommends, generalizes, and shares skills

**Docker**
- `Dockerfile.node` — Node 22 slim
- `Dockerfile.gpu` — NVIDIA CUDA 12.1 with CPU-only build arg
- `docker-compose.yml` — all services, GPU + CPU profiles, health checks, voiceprint volume
- `requirements-cuda.txt` / `requirements-cpu.txt` / `requirements-metal.txt`

---

## What's next

This is 1.0 — the foundation. Where it goes depends on the community.

Ideas in flight:
- Claude Voice / Realtime API integration
- Automatic skill recommendation engine (pattern detection → suggest → share)
- Community skill registry (discover and install skills by voice: "Jarvis, find me a skill for X")
- OpenClaw skill marketplace integration
- Windows support
- Homelab integrations (Home Assistant, MQTT, Zigbee)
- Multi-user household mode

If you build something useful, generalize it and open a PR. That's how this gets better.
