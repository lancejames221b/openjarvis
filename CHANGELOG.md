# Changelog

All notable changes to Jarvis Voice are documented here.

---

## [1.1.0] — 2026-04-02

Stability, security, and developer experience update.

### Bug fixes (19 resolved)
- **FSM idle timer during TTS** — idle timer no longer fires while the bot is speaking
- **Server mute flicker** — owner stays muted for the entire response, not just per-sentence
- **Reconnect storm on startup** — suppressed redundant voice state logs, added oscillation guard
- **Task ledger pruning** — orphaned/working tasks are now cleaned up properly
- **Semantic dedup threshold** — raised from 0.45 to 0.72, stops blocking valid /speak callbacks
- **Chatterbox cold start** — GPU warmup on boot, first TTS call no longer takes 34 seconds
- **Task auto-sleep** — bumped from 15s to 60s so responses arrive before sleep
- **Conversation window** — extended from 30s to 90s for natural follow-ups
- **isJustAck classifier** — no longer misclassifies real answers under 80 chars
- **Orphan detection** — now notifies user instead of just logging warnings
- **STT pipeline timing** — end-to-end timing now visible in logs
- **Gateway health check** — polling reduced from 60s to 15s for faster recovery
- **ESM require() fix** — replaced CommonJS require('fs') in voice_move handler
- **Moonshine STT** — removed JS import accidentally embedded in Python code string
- **Set memory cleanup** — stale task tracking Sets now garbage collected
- **url.parse() deprecation** — already clean (no instances found)
- **session-manager paths** — already using env vars (no change needed)
- **Dual AudioQueue** — documented intentional dual-pipeline architecture

### New features
- **Focus reads channel history** — when you say "focus on [channel]", the bot fetches the last 30 Discord messages as ground truth context before loading haivemind
- **Voice message transcripts** — voice messages (.ogg) are automatically transcribed and posted as replies, making them visible in channel history
- **Focus-switch breadcrumbs** — switching focus posts a notice to the previous channel
- **Systemd service** — ships with a user systemd unit file for production deployment

### Developer experience
- **Docker dev environment** — Dockerfile.dev + docker-compose.dev.yml + .env.dev with safe placeholders
- **Dev/live separation** — documented workflow: dev clone with Docker, live on host with systemd
- **Node 22** — Dockerfile.dev upgraded from Node 20 to 22 (discordjs/voice requirement)
- **npm audit** — @discordjs/opus upgraded 0.9→0.10 (DoS CVE fix)

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
