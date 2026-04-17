# Jarvis Voice

> Finally. Be Tony Stark.

[![Discord DAVE E2EE](https://img.shields.io/badge/Discord%20DAVE-E2EE%20Compliant-5865F2)](https://discord.com/blog/dave-end-to-end-encryption-for-audio-video)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Powered by Claude](https://img.shields.io/badge/Powered%20by-Claude-orange)](https://claude.ai)

**A Discord voice bot backed by the official Claude Code CLI.** Speak in a Discord voice channel — Jarvis hears you, routes your request through `claude -p`, and talks back. The same Claude you use day-to-day, now answering by voice in under 4 seconds.

**→ [QUICKSTART.md](QUICKSTART.md)** — clone, configure, running in 5 minutes  
**→ [docs/MULTI_ACCOUNT.md](docs/MULTI_ACCOUNT.md)** — route channels to different Claude accounts  
**→ [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** — common fixes

Not a chatbot. Not a voice assistant that sets timers. A full AI system with access to your calendar, email, code, search, databases, and every tool Claude can reach — that you talk to, out loud, and it talks back. In the right voice.

Run it hands-free over AirPods or any Bluetooth headset. **Blue team ops by voice.** Ask about live threats, pivot on IOCs, query your SIEM, run playbooks — no keyboard required. Tony Stark ran his SOC by talking to Jarvis. Now you can too.

Five TTS engines out of the box — pick the one that fits your hardware:

| Engine | Speed | Hardware | What it is |
|--------|-------|----------|------------|
| **Piper** (default) | ~1.5s | CPU | Local Jarvis voice clone. British RP accent. No cloud, no GPU, no account. |
| **Edge TTS** | ~1s | Cloud (free) | Microsoft Edge neural voices. 400+ voices, zero setup. Auto-fallback for all other providers. |
| **Kokoro** | ~150ms | CPU/GPU | OpenAI-compatible local TTS. Fastest time-to-first-word. British male voice (`bm_lewis`). |
| **Chatterbox** | ~2s first word | GPU (NVIDIA) | Resemble AI voice cloning with sentence-level streaming. Clone any voice from a 5-second sample. |
| **Qwen3** | ~2s | GPU | Alibaba's voice-design TTS. Experimental. |

Set `TTS_PROVIDER=piper|edge|kokoro|chatterbox|qwen3` in your `.env`. Default is Piper — works on any machine, sounds like Jarvis.

---

## Choose Your Build

Three tiers. Start with REACTOR and upgrade when you're ready.

|  | REACTOR | FRIDAY | JARVIS |
|--|:-------:|:------:|:------:|
| Voice in Discord | ✅ | ✅ | ✅ |
| British butler personality | ✅ | ✅ | ✅ |
| Voiceprint authentication | ✅ | ✅ | ✅ |
| Wake word + conversation window | ✅ | ✅ | ✅ |
| Morning briefing (calendar + weather + email) | | ✅ | ✅ |
| Comms check (iMessage + Signal + calls) | | ✅ | ✅ |
| Voice TV control (Roku) | | ✅ | ✅ |
| Memory system ("remember this", "where did I put...") | | ✅ | ✅ |
| Media on demand (Plex + qBittorrent) | | | ✅ |
| Full skills library | | | ✅ |
| **Setup time** | ~15 min | ~45 min | ~2 hrs |

**REACTOR** — *"Claude, now with a voice."*  
**FRIDAY** — *"Your day, briefed. Your home, controlled. All by voice."*  
**JARVIS** — *"Not a chatbot. Not a voice assistant. An AI system that runs your life."*

---

## Quick install

```bash
git clone https://github.com/your-org/jarvis-voice.git
cd jarvis-voice
npm install
claude login        # authenticate the Claude CLI once
cp .env.example .env && $EDITOR .env   # fill in 8 required vars
systemctl --user enable --now jarvis-gateway jarvis-voice
```

See **[QUICKSTART.md](QUICKSTART.md)** for full instructions including Discord bot setup.

OpenClaw will use Opus High reasoning to walk you through the complete setup interactively — Discord bot creation, Python services, voiceprint enrollment, and tier selection. One conversation, zero guessing.

The full install playbook is at [openclaw/INSTALL_PLAYBOOK.md](openclaw/INSTALL_PLAYBOOK.md) if you want to see exactly what it does.

Or follow [INSTALL.md](INSTALL.md) for manual step-by-step setup.

---

## Docker Dev (Quick Start)

No GPU required — runs with mock TTS/STT services for local development.

1. Clone the repo
2. Run `./scripts/dev-start.sh` — creates `.env` from template on first run
3. Edit `.env` with your Discord bot token and channel IDs
4. Re-run `./scripts/dev-start.sh` to start the container

---

## Skills

The [skills/](skills/) directory contains generalized OpenClaw skills that make Jarvis genuinely useful — not just a voice interface, but an AI that knows your life.

See [skills/README.md](skills/README.md) for the full catalog, dependencies, and install instructions.

Jarvis will ask you to configure anything it needs as you go.

---

## Demo

[![Jarvis Voice Demo](https://img.youtube.com/vi/o_sHNEy8gm0/maxresdefault.jpg)](https://youtube.com/shorts/o_sHNEy8gm0)

---

## What it looks like

```
You:    "Jarvis, what's hitting us on port 443 right now?"
Jarvis: "Three new IPs in the last hour. Two are Shodan crawlers,
         one is resolving to a Tor exit node in Romania. Want me
         to block it and file a ticket?"
```

```
You:    "Jarvis, check my calendar and brief me on today."
Jarvis: "You have a standup at 10, a vendor call at 2, and a PR
         review that's been waiting since yesterday. Should I
         draft a response to the PR?"
```

```
You:    "Good night, Jarvis."
Jarvis: "Good night, sir. Rest well."
         [SLEEP state — only wake word and P1/P2 critical alerts get through]
```

Any tool your OpenClaw agent has — email, Linear, GitHub, web search, VirusTotal, Shodan, your entire MCP stack — available by voice.

---

## It talks like Jarvis too

Not just the voice — the personality is built into the response layer. British butler persona, understated, dry wit, "sir" when appropriate. Responses are capped at 1-3 spoken sentences by design. No markdown, no bullet points, no chatbot energy. Plain spoken English, delivered like a briefing.

It decides instantly whether you asked a knowledge question (answers directly in 1-3 sentences) or an action request (acknowledges, spawns a sub-agent to do the work, reports back when done). You never wait while it thinks out loud.

It's a butler, not a chatbot.

The personality is also hot-swappable. Swap to Snoop Dogg for a vibe check, HAL 9000 for existential dread, or Alfred for maximum formality — all via voice command. Each persona lives in `personalities/` as a markdown file with its own name, wake words, and TTS voice. The default stays Jarvis.

---

## Architecture

```
Discord Voice Channel (you speak)
  -> Discord DAVE E2EE (voice gateway v8, mandatory March 2026)
  -> Opus decode (discord.js)
  -> Speaker Verification (Silero VAD + ECAPA-TDNN voiceprint)
  -> Per-utterance speaker filter (rejects TV/ambient even in active session)
  -> FSM state gate (ACTIVE: pass, IDLE/SLEEP: wake word only)
  -> STT backend (faster-whisper with confidence filtering)
  -> OpenClaw Gateway  <- full agent with all tools
  -> TTS backend (Piper | Edge | Kokoro | Chatterbox | Qwen3)
  -> Server mute owner -> Play audio -> Unmute owner
  -> Discord Voice Channel (Jarvis speaks)
```

### Three-Stage Speaker Verification Pipeline

```
Discord 48kHz PCM (from receiver.subscribe)
       |
  [Stage 1: Silero VAD]                (<1ms, CPU)
       |--- not speech? --> DROP
       |
  [Stage 2: ECAPA-TDNN speaker verify] (~30ms, GPU)
       |--- not owner? --> REJECT (spoken rebuff, throttled)
       |
  [Stage 3: faster-whisper + confidence] (~200-400ms, GPU)
       |--- no_speech_prob > 0.6? --> DROP
       |--- confidence < 0.35? --> DROP
       |
  Verified transcript --> wake word / brain pipeline
```

Total added latency: ~50ms for VAD + speaker verify. Whisper latency unchanged.
Total VRAM: ~4.5GB (fits easily in any modern GPU).

```
+---------------------------------------------------------+
|                  jarvis-voice (Node.js)                  |
|                                                         |
|  Discord --> Opus decode --> Speaker Verify (8767)       |
|                                      |                  |
|                        bot-state.js (FSM gate)          |
|                                      |                  |
|                              STT (faster-whisper 8766)  |
|                                      |                  |
|                                  brain.js               |
|                                      |                  |
|                               CLAWDBOT_GATEWAY          |
|                                      |                  |
|  Discord <-- mute/play/unmute <-- TTS (Piper/Edge/Kokoro/Chatterbox)  |
|                                                         |
|  alert-webhook.js <-- POST /speak /alert /handoff       |
|       |-- priority classifier (P1-P5)                   |
|       |-- FSM-aware voice delivery                      |
+---------------------------------------------------------+
```

**Key design principle:** The voice bot does not duplicate agent capabilities. Every voice request is forwarded to your OpenClaw gateway. One brain, many surfaces.

---

## What's New

### Visual Mode (Expanse-style)

All voice input still works — you talk, Jarvis listens. But instead of speaking back, responses appear as rich formatted text in Discord. Like the ship AI in The Expanse.

**Voice commands:**
- "Jarvis, visual mode" / "screen mode" / "text only" / "expanse mode" → ON
- "Jarvis, voice mode" / "talk to me" / "audio mode" → OFF
- "Jarvis, visual mode in gibson" → ON + route to specific channel

**Slash commands:**
- `/visual on` — enable visual mode from any text channel
- `/visual off` — disable (back to voice)
- `/visual status` — check current state
- `/visual channel <name>` — set target channel

When active, the brain gets a `[VISUAL]` tag so it uses full markdown formatting instead of optimizing for speech.

### Self-Mute TTS Queue

When you self-mute on Discord, Jarvis stops speaking — but keeps working. Tasks execute in the background, and any TTS output (responses, alerts, `/speak` callbacks) is captured to a text queue instead of being synthesized and played.

When you unmute, Jarvis offers a smart debrief:

```
Jarvis: "I have 3 updates while you were muted —
         2 task completions, 1 alert. Shall I brief you?"
You:    "Yes."
Jarvis: [delivers collapsed summary of all queued updates]
```

**How it works:**
- **Trigger:** `selfMute=true && serverMute=false` via Discord's `voiceStateUpdate` event
- **Tasks keep running** — only TTS output is held, not execution
- **Smart collapse:** Multiple completions are grouped by source (task/alert/reminder), not dumped one-by-one
- **Wake bypass:** On unmute, the debrief prompt doesn't require a wake word — just say "yes" or "brief me"
- **Conversation context:** Queued entries are injected into conversation history so follow-up questions ("what was the alert about?") work naturally
- **Graceful degradation:** Works without speaker verification. With it enrolled, wake bypass is even smoother.

**Architecture:**
```
Owner self-mutes
  → muteQueueActivate()
  → audioQueue.clear() (stop pending audio)
  → flushToPipeline() intercept: text → mute queue (skips TTS synthesis)
  → setSpeakCallback() intercept: /speak text → mute queue
  → Tasks continue via gateway as normal

Owner unmutes
  → muteQueueDeactivate()
  → getSummary() → synthesize → speak ("I have N updates...")
  → getContextBlock() → inject into conversation history
  → markBotResponse(followUpLikely: true) → wake bypass
  → muteQueueClear()
```

**Configuration:**

| Variable | Default | Description |
|---|---|---|
| `MUTE_QUEUE_ENABLED` | `false` | Enable self-mute TTS queue. Set to `true` to activate. |
| `MUTE_QUEUE_WAKE_BYPASS` | `true` | Skip wake word for the unmute debrief reply |
| `MUTE_QUEUE_MAX` | `20` | Maximum queued entries before low-priority items are dropped |
| `MUTE_QUEUE_TTL_MS` | `3600000` | Discard queued entries older than this (default: 1 hour) |

**Enable:**
```env
MUTE_QUEUE_ENABLED=true
MUTE_QUEUE_WAKE_BYPASS=true
```

### Self-Unmute as Implicit Wake Word

Unmuting yourself *is* authentication. You own the device, your voiceprint is enrolled — requiring you to also say "Jarvis" after unmuting is redundant friction.

When `UNMUTE_IMPLICIT_WAKE=true`, self-unmuting opens a full conversation window automatically:

```
[You self-mute — Jarvis queues any updates]
[You self-unmute]
Jarvis: "I have one update — shall I brief you?"   ← or silent if no queue
You:    "Go ahead."                                  ← no wake word needed
You:    "Also check my calendar."                    ← still in window, no wake word
[3 minutes of silence]
Jarvis: [transitions to IDLE, then SLEEP as normal]
```

**How it works:**
- On `selfMute → false`: FSM transitions to ACTIVE, conversation window opens (standard 2 min, extends to 5 min during high-velocity sessions)
- Voiceprint is still checked on the first utterance as normal — identity confirmed by voice, not bypassed
- Normal idle/sleep timers apply — goes back to sleep if you don't speak within the window
- Works with or without `MUTE_QUEUE_ENABLED`

**Configuration:**

| Variable | Default | Description |
|---|---|---|
| `UNMUTE_IMPLICIT_WAKE` | `true` | Treat self-unmute as an implicit wake word. Code checks `!== 'false'`, so default is ON. |

### Fuzzy Wake Word (Vocative Pattern Matching)

Whisper frequently mishears "Jarvis" as phonetically similar words — *Curtis*, *Gervas*, *Douglas*, *service*, *harvest*, *Harvey*. The static phrase list catches known variants, but new ones keep appearing.

Fuzzy wake word solves this structurally. Instead of maintaining an ever-growing word list, it detects the **vocative pattern**: a short word followed by a comma/pause and a sentence. When speaker verification confirms it's the owner, the pattern `"[word], [command]"` is treated as a wake word regardless of what Whisper thought the first word was.

```
Whisper hears: "Curtis, check my email"     → wake word + "check my email"
Whisper hears: "Gervas, what time is it"     → wake word + "what time is it"
Whisper hears: "Douglas, run the scan"       → wake word + "run the scan"
```

**Safety:** Common sentence starters (`so`, `but`, `well`, `actually`, `I`, etc.) are excluded — a 50+ word blocklist prevents false activations. Speaker verification is required by default, so only the enrolled owner's voice triggers the fuzzy match.

**Configuration:**

| Variable | Default | Description |
|---|---|---|
| `WAKE_WORD_FUZZY` | `false` | Enable vocative pattern matching. Set to `true` to activate. |
| `WAKE_WORD_FUZZY_MIN_SENTENCE` | `8` | Minimum characters in the sentence part (after the prefix word) |
| `WAKE_WORD_FUZZY_MAX_PREFIX` | `12` | Maximum characters in the vocative prefix word |
| `WAKE_WORD_FUZZY_REQUIRE_SPEAKER` | `true` | Require speaker verification before allowing fuzzy match. Highly recommended. |

**Enable:**
```env
WAKE_WORD_FUZZY=true
WAKE_WORD_FUZZY_REQUIRE_SPEAKER=true
```

### Discord DAVE E2EE (March 2026)

Discord now requires end-to-end encryption for all voice connections. OpenJarvis is fully compliant via `@discordjs/voice@0.19.0` and the native `@snazzah/davey` DAVE implementation. No configuration needed — DAVE activates automatically.

**Requires Node.js 22.12+** — the `@snazzah/davey` native addon does not build on older Node versions.

```
> node -e "import('@discordjs/voice').then(v => console.log(v.generateDependencyReport()))"
DAVE Libraries
- @snazzah/davey: 0.1.9  ✓
```

### Mobile / On-The-Go Mode

Narrated hands-free mode for when you're moving around without a screen.

```
You:    "I'm on the go"
Jarvis: "Mobile mode enabled, sir."
```

While active, Jarvis narrates findings as they surface instead of waiting until completion. Sub-agents send live `/speak` progress updates at kickoff, mid-task, and final summary. Responses stay concise but Jarvis keeps you informed throughout.

Disable: *"I'm at my desk"* / *"back at a screen"* / *"mobile mode off"*

Set a persistent default via `VOICE_MOBILE_MODE=true` in `.env`.

### Natural Number Speech

All TTS output runs through a number formatter (`src/number-formatter.js`) that converts technical text to natural spoken English:

- Years: `2026` → *"twenty twenty-six"*
- Times: `14:30` → *"two thirty pm"*
- Large numbers: `1,247,389` → *"one million two hundred forty-seven thousand three hundred eighty-nine"*
- Hashes/hex: `0x1a2b3c` → *"hex address"* (never spelled out)
- Percentages: `42.5%` → *"forty-two point five percent"*
- ISO dates: `2026-03-01` → *"March first, twenty twenty-six"*

### Speaker Diarization in Record Mode

Record Mode (`"Jarvis, start recording"`) labels each speaker in real time using ECAPA-TDNN embeddings — the owner is labeled by name, other voices as `Speaker 2`, `Speaker 3`, etc. Speaker labels appear in the Discord thread transcript as the meeting progresses.

### Adaptive Conversation Window

The conversation window (how long Jarvis stays active without requiring a wake word) adapts to the interaction pattern:

- **Standard window:** 2 minutes after last response (code default `CONVERSATION_WINDOW_MS=120000`)
- **Extended window:** 5 minutes when Jarvis detects a follow-up is likely (questions, lists, partial info) or when interaction velocity is high (3+ exchanges in 15 minutes)
- **Continuation phrases:** Sayings like "tell me more", "what about the first one", or "go on" bypass the wake word requirement if Jarvis has recent context (within 10 minutes)
- **Auto wake word:** When other users are in the voice channel, wake word is required even during an active conversation to avoid cross-talk

> **Note:** `.env.example` ships with `CONVERSATION_WINDOW_MS=120000` (2 min), matching the code default. The conversation window extends automatically to 5 min when follow-up is expected or interaction velocity is high.

### Personality System

Jarvis ships with four built-in personas, hot-swappable by voice. Each lives in `personalities/<name>.md` with YAML frontmatter defining its name, TTS voice, and wake words.

```
You:    "Switch to Snoop"
Jarvis: "Switching to Snoop persona."
Snoop:  "Fo real, I'm here. What's good, homie?"

You:    "Be Alfred"
Alfred: "I have assumed the role, sir. How may I be of service?"

You:    "List personas"
Jarvis: "Current persona is Jarvis. Available: snoop, alfred, hal."
```

**Bundled personas:**

| Persona | Vibe | Wake Words |
|---------|------|-----------|
| `jarvis` | British butler, dry wit (default) | `jarvis`, `hey jarvis` |
| `snoop` | West Coast laid-back, casual slang | `snoop`, `hey snoop`, `yo snoop` |
| `alfred` | Formal British butler, measured precision | `alfred`, `hey alfred` |
| `hal` | Cold, precise, slightly unsettling | `hal`, `hey hal` |

**Voice commands (admin only):**
- `"switch to [name]"` / `"be [name]"` / `"use [name]"` / `"load [name]"` / `"activate [name]"`
- `"[name] persona"` / `"[name] mode"`
- `"list personas"` / `"show personalities"`

**Add your own:** Create `personalities/mybot.md` with frontmatter and a content block describing the persona's voice and style. It loads at runtime without a restart (next persona switch picks it up).

**Frontmatter fields:**
```yaml
---
name: MyBot
voice: jarvis           # TTS voice profile to use
tts_voice_edge: en-US-GuyNeural  # Edge TTS fallback voice
wake_words: [mybot, hey mybot]
---
Your persona description here. Speak in second person...
```

**Configuration:**

| Variable | Default | Description |
|---|---|---|
| `VOICE_PERSONA` | `jarvis` | Default persona on startup. Must match a file in `personalities/`. |

### Voice Engines (TTS)

Five TTS backends, switchable via `TTS_PROVIDER` in your `.env`. All support streaming sentence-by-sentence for fast time-to-first-word.

#### Piper (default) — Local Voice Clone

The default. Runs the custom Jarvis British RP voice model locally via the Piper binary. CPU-only, no cloud account, no API key. Sounds like Jarvis out of the box.

```env
TTS_PROVIDER=piper
PIPER_MODEL=medium          # 'medium' (~1.5s) or 'high' (better quality, ~3.5s)
```

Ships with a pre-trained Jarvis voice model. Custom ONNX models work too — drop them in and point `PIPER_MODEL` at them.

#### Edge TTS — Cloud (Free)

Microsoft's neural TTS voices. 400+ voices across dozens of languages. No API key — it's free. Also serves as the automatic fallback when any other provider fails.

```env
TTS_PROVIDER=edge
EDGE_TTS_VOICE=en-AU-WilliamNeural   # Any Edge voice ID
```

#### Kokoro — Local, Fastest

OpenAI-compatible local TTS server. 114–155ms per sentence — the fastest option. British male voice (`bm_lewis`) by default. Runs on CPU or GPU.

```env
TTS_PROVIDER=kokoro
KOKORO_URL=http://localhost:8880      # Kokoro server endpoint
KOKORO_VOICE=bm_lewis                 # Any Kokoro voice ID
```

Kokoro exposes an OpenAI-compatible `/v1/audio/speech` endpoint, so it also works with any client that speaks that protocol.

#### Chatterbox — GPU Voice Cloning

GPU-accelerated TTS by Resemble AI with sentence-level streaming. Clone any voice from a 5-second audio sample. First word plays in ~2 seconds while the rest synthesizes in the background.

```env
TTS_PROVIDER=chatterbox
CHATTERBOX_VOICE=jarvis               # 'jarvis' or 'custom'
```

Start the GPU service:
```bash
systemctl --user start jarvis-chatterbox-tts.service

# Or run directly (requires NVIDIA GPU + venv):
cd ~/dev/jarvis-gpu-services
source ~/dev/voice-clones/train_venv310/bin/activate
python3 chatterbox_tts_service.py
```

The service exposes `/tts` (batch) and `/tts/stream` (sentence-level NDJSON streaming). Each sentence arrives as a WAV chunk as soon as it's synthesized — the client plays them in order while synthesis continues in the background.

**How streaming works:**
```
Request: "Today you have three meetings and one PR waiting."
 +0.0s: synthesis starts for sentence 1
 +2.1s: sentence 1 WAV arrives → starts playing
 +3.8s: sentence 2 WAV arrives → queued
 +5.4s: sentence 3 WAV arrives → queued
 Total: first audio 2.1s vs. 6s+ with batch TTS
```

| Variable | Default | Description |
|---|---|---|
| `CHATTERBOX_URL` | `http://127.0.0.1:3340` | Chatterbox TTS service URL |
| `CHATTERBOX_VOICE` | `jarvis` | Active voice (`jarvis` or `custom`) |
| `CHATTERBOX_PORT` | `3340` | Port for the Chatterbox GPU service |
| `CHATTERBOX_VOICE_JARVIS` | *(path to jarvis WAV)* | Reference audio for the Jarvis voice clone |
| `CHATTERBOX_VOICE_CUSTOM` | *(empty)* | Reference audio for your own voice clone |
| `CHATTERBOX_JARVIS_EXAGGERATION` | `0.35` | Emotion intensity (0–1) |
| `CHATTERBOX_JARVIS_CFG_WEIGHT` | `0.6` | Classifier-free guidance weight |

#### Qwen3 — Experimental

Alibaba's voice-design TTS. Experimental support. Requires a local Qwen3-TTS server.

```env
TTS_PROVIDER=qwen3
QWEN3_TTS_URL=http://localhost:8890
```

### Streaming STT Artifact Cleanup

WhisperLiveKit (used with `STT_PROVIDER=faster-whisper`) sends rolling incremental confirmations — each new confirmation is a more complete version of the same utterance, not a new sentence. The final line is the canonical transcript.

Two classes of hallucination are now cleaned automatically before the transcript reaches the command pipeline:

1. **Standalone dash tokens** — silence hallucinations like `"- - -"` or `"- ."` that appear when Whisper processes near-silence. Stripped before routing.
2. **Consecutive repeated words** — model repetition loops like `"Service Service Service checking"` or `"the the the time"`. Collapsed to a single instance.

Both are handled by `cleanTranscript()` in `src/stt-streaming.js`. No configuration needed — always on when using streaming STT.

### Why Discord?

Discord solves the hard parts of real-time voice — reliable audio delivery, Opus codec, NAT traversal, cross-platform clients, voice activity detection. Building that infrastructure from scratch is a multi-month project. Using Discord as the transport layer means all of that is handled, and the bot can focus entirely on intelligence.

The result: a production-grade voice interface in ~1000 lines of Node.js that works on desktop, mobile, browser, and AirPods — everywhere Discord runs.

---

## The OpenJarvis Voice

OpenJarvis uses **Piper TTS** with a custom Jarvis voice clone — British RP accent, runs entirely on CPU, no cloud TTS account needed.

The voice model is hosted on Hugging Face by [jgkawell](https://huggingface.co/jgkawell/jarvis). The installer downloads it automatically. Or manually:

```bash
HF_BASE="https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis"

# High quality (recommended for production)
wget "$HF_BASE/high/jarvis-high.onnx" -P models/jarvis/
wget "$HF_BASE/high/jarvis-high.onnx.json" -P models/jarvis/

# Medium quality (faster synthesis, lower memory)
wget "$HF_BASE/medium/jarvis-medium.onnx" -P models/jarvis/
wget "$HF_BASE/medium/jarvis-medium.onnx.json" -P models/jarvis/
```

[jgkawell/jarvis on Hugging Face](https://huggingface.co/jgkawell/jarvis)

| Model | Size | Quality | Use when |
|---|---|---|---|
| `jarvis-high` | 109MB | Best, lowest noise | Best quality — any modern CPU |
| `jarvis-medium` | 61MB | Good, more expressive | Low-resource machines, Pi |

**Piper runs as an in-process HTTP server** (`src/piper-server.js`) on port 3336. It starts automatically with `jarvis-voice.service` — there is no separate Piper systemd service. The Piper binary is spawned as a persistent child process with the model kept warm in memory. Each subsequent sentence synthesizes in ~600ms instead of ~2s cold start.

Edge TTS (Microsoft Neural) is the automatic fallback if Piper is unavailable. When Piper is enabled (default), the bot will **not** switch to Edge TTS mid-conversation — if Piper fails after retry, the response degrades to text-only to preserve voice identity consistency.

---

## Docker Quickstart

The fastest way to get running — no Python venv, no CUDA driver fiddling.

### Prerequisites

- Docker 24+ with [Compose v2](https://docs.docker.com/compose/install/)
- NVIDIA Container Toolkit (GPU mode) — [install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
- Jarvis ONNX voice models (see [INSTALL.md](INSTALL.md#voice-models))

```bash
git clone https://github.com/owner221b/jarvis-voice.git
cd jarvis-voice

# Configure — fill in DISCORD_TOKEN, CLAWDBOT_GATEWAY_URL, ALLOWED_USERS
cp .env.example .env
$EDITOR .env

# Start (GPU mode — default)
docker compose up -d

# CPU-only (no NVIDIA GPU required)
PLATFORM=cpu docker compose --profile cpu up -d

# Check status
docker compose ps
docker compose logs -f voice-bot
```

Service ports (bound to 127.0.0.1 only):

| Service | Port | Purpose |
|---|---|---|
| `whisper-stt` | 8766 | Faster-Whisper transcription |
| `piper-tts` | 3336 | Piper TTS synthesis |
| `speaker-verify` | 8767 | ECAPA-TDNN voiceprint auth |
| `voice-bot` | 3335 | Alert webhook receiver |

See [INSTALL.md](INSTALL.md) for full configuration, voice model download, voiceprint enrollment, and non-Docker setup.

---

## Quick Install (via OpenClaw skill)

The primary install path for OpenClaw users — handles cloning, voice model download, `.env` scaffolding, and systemd:

```bash
# In your OpenClaw chat:
/install jarvis-voice

# Or via CLI:
openclaw skill install jarvis-voice
```

OpenClaw will clone the repo, download the Jarvis voice model from Hugging Face, walk you through required env vars, and enable the systemd services. See `skill/SKILL.md` for details.

---

## Manual Install

### Requirements

- Linux with systemd (Ubuntu 22.04+ recommended)
- **Node.js 22+** (v22.12+ required for `@snazzah/davey` DAVE E2EE native addon)
- Python 3.12+ with venv
- ffmpeg
- Discord bot token (create a separate bot application — do not share with your main bot)
- OpenClaw gateway running and accessible

**Optional but recommended for persistent memory:**
- [hAIveMind](https://github.com/unit221b/haivemind) — collective memory MCP server. Enables channel-aware context, voice task history, and cross-session memory. Install and set `HAIVEMIND_URL` or ensure `mcporter` is on PATH.
- `mcporter` CLI — bridge between jarvis-voice and the hAIveMind MCP server. Install via: `pip install mcporter`
- Set `VOICE_MEMORY_ENABLED=true` in `.env` to activate (default: true when mcporter is available)

**Optional for local STT:**
- NVIDIA GPU — faster-whisper STT runs ~10x faster with CUDA

### Steps

```bash
git clone https://github.com/owner221b/jarvis-voice.git
cd jarvis-voice
npm install

# Download voice models (auto-set by installer, or manual wget above)
bash skill/install.sh
```

The installer will download the Jarvis Piper voice model (~170MB) and scaffold your `.env`.

For GPU STT setup (faster-whisper + CUDA):

```bash
./setup-gpu-env.sh
```

This installs CUDA-optimized torch and creates systemd services for the STT worker.

### `.env` configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Key settings to configure:

```env
# Required
DISCORD_TOKEN=your_bot_token
DISCORD_GUILD_ID=your_server_id
DISCORD_VOICE_CHANNEL_ID=your_voice_channel_id
CLAWDBOT_GATEWAY_URL=http://127.0.0.1:22100
CLAWDBOT_GATEWAY_TOKEN=your_gateway_token
ALLOWED_USERS=your_discord_user_id

# STT (recommended: faster-whisper with GPU)
STT_PROVIDER=faster-whisper

# TTS (Piper is default — no config needed)
# PIPER_ENABLED=true is the default in code
# PIPER_MODEL=medium is the code default (set to "high" for best quality)

# Wake word (optional)
VOICE_WAKE_WORD_ENABLED=true
VOICE_WAKE_WORD=hey jarvis
WAKE_WORD_PHRASES=hey jarvis,yo jarvis

# Speaker verification (optional, requires GPU service)
SPEAKER_VERIFY_ENABLED=true
SPEAKER_VERIFY_STRICT=true

# Webhook (change the token!)
ALERT_WEBHOOK_PORT=3335
ALERT_WEBHOOK_TOKEN=your_secure_token_here
```

### Systemd (production)

Three core services are provided in `gpu-services/`, with an optional fourth for Chatterbox TTS:

| Service | Purpose | Required? |
|---|---|---|
| `jarvis-voice.service` | Main Discord bot (includes Piper TTS in-process) | Yes |
| `jarvis-whisper-stt.service` | GPU faster-whisper STT worker (port 8766) | For `STT_PROVIDER=faster-whisper` |
| `jarvis-speaker-verify.service` | ECAPA-TDNN speaker verification (port 8767) | For `SPEAKER_VERIFY_ENABLED=true` |
| `jarvis-chatterbox-tts.service` | Chatterbox GPU TTS streaming service (port 3340) | For `TTS_PROVIDER=chatterbox` |

```bash
cp gpu-services/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now jarvis-voice.service
# Optional: enable GPU services
systemctl --user enable --now jarvis-whisper-stt.service
systemctl --user enable --now jarvis-speaker-verify.service
```

> **Note:** There is no separate Piper TTS systemd service. Piper runs inside `jarvis-voice.service` as an in-process HTTP server via `src/piper-server.js`.

---

## Bluetooth / Headset Use

OpenJarvis works great with AirPods, wireless headsets, or any Bluetooth audio device. The wake word system means you can leave Discord open in the background and just say "Jarvis" to activate — no push-to-talk, no keyboard.

**Blue team use case:** Mount a secondary monitor with your Discord voice channel open. Wear your headset. Query your toolstack hands-free while you work. Context switches kill investigations — voice keeps you in the flow.

Recommended setup:
- Wake word enabled (`VOICE_WAKE_WORD_ENABLED=true`, `VOICE_WAKE_WORD=hey jarvis`)
- 90-second conversation window (`CONVERSATION_WINDOW_MS=90000`)
- `VOICE_ACK_ENABLED=false` (no "On it" — just answers)
- Local STT for lowest latency (`STT_PROVIDER=faster-whisper` with GPU)
- Piper TTS with high model (`PIPER_ENABLED=true`, `PIPER_MODEL=high`)

---

## Speaker Verification (Voiceprint Authentication)

Jarvis can learn your voice and only respond to you. When speaker verification is enabled, a three-stage neural pipeline filters all audio before it reaches the AI:

1. **Silero VAD** -- neural voice activity detection. Rejects silence and ambient noise in <1ms on CPU.
2. **ECAPA-TDNN** -- speaker embedding model (SpeechBrain). Compares incoming voice against your enrolled voiceprint using cosine similarity. ~30ms on GPU, ~300MB VRAM.
3. **Whisper confidence filtering** -- after transcription, checks `no_speech_prob` and `avg_logprob` to catch hallucinations that slipped through.

This eliminates Whisper hallucinations ("Thank you", "Amen", phantom transcriptions from TV/music), prevents unauthorized users from issuing commands, and saves GPU time by rejecting non-owner audio before it reaches Whisper.

### Setup

```bash
# 1. Install dependencies (in jarvis-voice venv)
pip install -r requirements.txt  # adds speechbrain, torchcodec

# 2. Start the speaker verification service
python3 gpu-services/speaker_verify_service.py
# Or via systemd:
cp gpu-services/jarvis-speaker-verify.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now jarvis-speaker-verify

# 3. Enable in .env
SPEAKER_VERIFY_ENABLED=true
SPEAKER_VERIFY_STRICT=true  # Block all voice until enrolled

# 4. Enroll your voice (via Discord -- just talk to Jarvis)
# Say: "Jarvis, enroll my voice"
# Jarvis will guide you through 10 phrases to repeat
```

### Voice Enrollment (Guided)

Enrollment happens directly through Discord voice -- no microphone setup, no scripts, no recordings. Just talk.

1. Say **"Jarvis, enroll my voice"** in the Discord voice channel
2. Jarvis reads you 10 phrases one at a time — a mix of wake word variants and longer phrases
3. Each phrase is posted to the closed captions channel so you can read along
4. Each clip is validated server-side (Silero VAD speech duration + embedding consistency) — silence, ambient noise, and outlier embeddings are rejected
5. After 10 accepted clips, your voiceprint is saved automatically

Phrases include wake word variants (to train on the exact authentication trigger) and longer phrases for phonetic richness:
- "Hey Jarvis."
- "Jarvis, are you there?"
- "My voice is my passport, verify me."
- "The only winning move is not to play."
- "Jarvis, put everything we have into the thrusters."

Voice commands during enrollment:
- **"retry"** / **"again"** — repeat the current phrase
- **"retry 5"** — jump back to phrase #5
- **"start over"** — restart from #1
- **"done"** — save early (minimum 3 clips)
- **"learn mode"** — keep adding clips beyond the initial 10 to improve your voiceprint
- **"cancel"** — abort enrollment

You can also enroll from the command line:

```bash
# Record from microphone
./enroll-voice.sh

# From pre-recorded WAV files
./enroll-voice.sh --from-dir /path/to/your/wav/files

# Reset and start over
./enroll-voice.sh --reset
```

### Strict Mode

When `SPEAKER_VERIFY_STRICT=true` (recommended), Jarvis blocks all voice interaction until a voiceprint is enrolled. On first boot, any speech triggers: *"No voiceprint on file. Say 'Jarvis, enroll my voice' to set up speaker verification."*

After enrollment, only the owner's voice passes through. Non-owner voices get a randomized rebuff:
- "I'm sorry, I only respond to my principal's voice."
- "Voice not recognized. Access denied."
- "I don't recognize you. Only my principal can wake me."

Rebuffs are throttled to once per 60 seconds to prevent spam from TV or ambient noise.

### How it works

When someone speaks in the Discord voice channel:
- **Owner's voice** -- passes all three stages, transcribed normally
- **Other person's voice** -- rejected at Stage 2, Jarvis speaks a rebuff
- **TV/music/ambient** -- rejected at Stage 1 (no speech) or Stage 3 (low confidence)
- **Service down** -- graceful degradation, verification bypassed, works like before

### Configuration

| Variable | Default | Description |
|---|---|---|
| `SPEAKER_VERIFY_ENABLED` | `true` | Enable/disable speaker verification gate. Code checks `!== 'false'` so default is on. `.env.example` ships with `false`. |
| `SPEAKER_VERIFY_STRICT` | `false` | Block all voice until voiceprint enrolled. Code checks `=== 'true'`. |
| `SPEAKER_VERIFY_URL` | `http://localhost:8767/verify` | Speaker verification service URL |
| `NO_SPEECH_PROB_THRESHOLD` | `0.6` | Whisper no-speech probability cutoff |
| `CONFIDENCE_THRESHOLD` | `0.35` | Whisper confidence cutoff (exp of avg logprob) |

### Speaker Verification API

The service runs on port 8767 and exposes:

- `POST /verify` -- verify audio against enrolled voiceprint
- `POST /enroll` -- add an enrollment clip
- `POST /enroll/finalize` -- average clips and save voiceprint
- `POST /enroll/reset` -- discard accumulated enrollment clips
- `POST /diarize` -- identify speaker via online embedding clustering
- `POST /diarize/start` -- start a diarization session (for record mode)
- `POST /diarize/stop` -- stop a diarization session
- `GET /health` -- service status and configuration

---

## Intelligent Sleep (FSM)

Jarvis uses a 4-state finite state machine instead of a simple on/off sleep toggle. The system is always aware, selectively vocal -- like the real Jarvis.

The bot boots into **IDLE** state (wake word required).

```
ACTIVE ──(3 min idle)──> IDLE ──(2 min more)──> SLEEP
  ^                        ^                       |
  |   (wake word + auth)   |    (wake word)        |
  +------------------------+---< P1/P2 alert >-----+
                                    |
                                 (ALERT)
                              transient state
                            deliver then return
```

### States

| State | Mic | Voice Out | Transitions |
|---|---|---|---|
| **ACTIVE** | Full STT | All responses | 3 min idle → IDLE, or "go to sleep" → SLEEP |
| **IDLE** | Wake word only | P1-P2 alerts | Wake word → ACTIVE, 2 min more → SLEEP |
| **SLEEP** | Wake word only | P1-P2 only | Wake word → ACTIVE |
| **ALERT** | n/a (transient) | Deliver alert | Auto-return to previous state |

### Manual Sleep

Say any of these (wake word optional):
- "Good night" / "Good night, Jarvis"
- "Thank you" / "Thanks"
- "Bye" / "Goodbye"
- "Go to sleep" / "Stop listening"
- "Dismissed" / "Stand by"

Jarvis responds with a contextual farewell:
- Conversational sign-offs ("thanks", "sounds good") → "Anytime, sir." / "Of course." / "Very good, sir." / "Cheers."
- Direct sleep commands ("go to sleep", "stand by") → "Going quiet. Just say my name when you need me."

### Two-Tier Auto-Sleep

The sleep system supports embedded sign-offs in task requests:

- **Tier 1 (standalone sleep):** Pure sleep command with no task content → immediate sleep. "Good night, Jarvis."
- **Tier 2 (sign-off + task):** Sleep phrase embedded in a task request → dispatch the task, auto-sleep after response completes. "We're good, check my email." → checks email, speaks result, then transitions to SLEEP silently.

### Auto-Sleep (Two-Stage Timer)

After 3 minutes with no interaction, Jarvis transitions from ACTIVE to IDLE -- wake word required but still listening for critical alerts. After 2 more minutes of silence, transitions to full SLEEP. No announcement. The ACTIVE timeout adapts: it extends to match the effective conversation window during high-velocity sessions.

### Wake Up

Say **"Jarvis"**, **"Hey Jarvis"**, **"Jarvis, wake up"**, or **"Jarvis, I'm back"** to bring Jarvis out of SLEEP or IDLE.

### TV / Ambient Audio Filtering

When the TV is on in the background, Jarvis filters out non-owner audio using per-utterance speaker verification. Even during an active session, audio that scores below the owner threshold (low confidence tier, normalized score < 0.5) is silently dropped before reaching the wake word or command pipeline. Long transcripts (>80 chars) from non-owner embeddings are almost certainly TV dialogue and are always filtered. Combined with server-muting the owner during TTS playback, this prevents echo loops and TV dialogue from being processed.

For SLEEP state specifically, long transcripts with "Jarvis" buried deep (index > 20 chars) trigger TV noise extraction — the bot extracts just the Jarvis command from surrounding TV dialogue.

### Server Mute During Playback

When Jarvis speaks, it server-mutes the owner's microphone in Discord. This prevents the mic from picking up Jarvis's own audio (echo) and TV/ambient noise during speech output. The owner can still hear Jarvis -- only mic input is suppressed. Unmutes automatically when Jarvis finishes speaking.

---

## Feature Flags

All flags are set in `.env`. See `.env.example` for the full annotated template.

### Self-Unmute Implicit Wake

| Variable | Code Default | Description |
|---|---|---|
| `UNMUTE_IMPLICIT_WAKE` | `true` | Treat self-unmute as an implicit wake word. Opens a conversation window without requiring "Jarvis". Voiceprint still checked on first utterance. Code checks `!== 'false'`, default is ON. |

### Self-Mute TTS Queue

| Variable | Code Default | Description |
|---|---|---|
| `MUTE_QUEUE_ENABLED` | `false` | Queue TTS output when owner self-mutes; offer smart debrief on unmute. Code checks `=== 'true'`. |
| `MUTE_QUEUE_WAKE_BYPASS` | `true` | Skip wake word for the unmute debrief reply. Code checks `!== 'false'`, so default is on. |
| `MUTE_QUEUE_MAX` | `20` | Maximum queued entries before lowest-priority items are dropped |
| `MUTE_QUEUE_TTL_MS` | `3600000` | Discard queued entries older than this many ms (default: 1 hour) |

### Wake Word

| Variable | Code Default | Description |
|---|---|---|
| `VOICE_WAKE_WORD_ENABLED` | `false` | Require wake phrase before processing speech. When unset, wake word activates only if `WAKE_WORD_PHRASES` is non-empty. |
| `VOICE_WAKE_WORD` | `hey jarvis` | Primary wake word (merged into phrase list automatically) |
| `WAKE_WORD_PHRASES` | *(empty)* | Additional comma-separated trigger phrases (e.g. `hey jarvis,yo jarvis`) |
| `WAKE_WORD_AUTO` | `true` | Auto-require wake word when non-owner users are in the voice channel |
| `CONVERSATION_WINDOW_MS` | `120000` | After a response, how long (ms) before wake word is required again. Code default is 2 minutes. Extends to 5 min when follow-up is expected or interaction velocity is high. |

### Fuzzy Wake Word

| Variable | Code Default | Description |
|---|---|---|
| `WAKE_WORD_FUZZY` | `false` | Enable vocative pattern matching for Whisper mishears. Catches `"[any-word], [sentence]"` as a wake word when speaker is verified. Code checks `=== 'true'`. |
| `WAKE_WORD_FUZZY_MIN_SENTENCE` | `8` | Minimum characters in the sentence after the prefix word |
| `WAKE_WORD_FUZZY_MAX_PREFIX` | `12` | Maximum characters in the vocative prefix word |
| `WAKE_WORD_FUZZY_REQUIRE_SPEAKER` | `true` | Require speaker verification before allowing fuzzy match. Code checks `!== 'false'`, so default is on. Strongly recommended — without this, any voice saying `"[word], [sentence]"` would trigger. |

### Voice Acknowledgment

| Variable | Code Default | Description |
|---|---|---|
| `VOICE_ACK_ENABLED` | `false` | Master ack flag. When `true`, enables "On it" before spawning tool-heavy sub-agents. Index.js checks `=== 'true'`, so default is off. |
| `IMMEDIATE_ACKS_ENABLED` | `false` | Send an ultra-fast ack via the ack model before the main gateway response. Only fires when `VOICE_ACK_ENABLED` is also `true`. |

### TTS

`TTS_PROVIDER` controls which engine is used. Default is `piper` (local Jarvis voice clone, in-process). Set to `chatterbox` for GPU streaming (fastest time-to-first-word). Edge TTS is the fallback for any provider failure.

| Variable | Code Default | Description |
|---|---|---|
| `TTS_PROVIDER` | `piper` | TTS engine: `piper` (local clone) \| `chatterbox` (GPU streaming) \| `edge` (cloud) \| `kokoro` (local) \| `qwen3` (local) \| `openai` (API-compatible) |
| `PIPER_ENABLED` | `true` | Kept for backward compat. `TTS_PROVIDER` takes precedence when set. |
| `PIPER_URL` | `http://127.0.0.1:3336` | Piper in-process HTTP server URL |
| `PIPER_MODEL` | `medium` | `high` (best quality, ~3.5s) \| `medium` (faster, ~1.5s) |
| `PIPER_BIN` | `~/.local/bin/piper` | Path to the Piper binary |
| `PIPER_PORT` | `3336` | Port for the in-process Piper HTTP server |
| `PIPER_BIND` | `127.0.0.1` | Bind address for the Piper HTTP server |
| `CHATTERBOX_URL` | `http://127.0.0.1:3340` | Chatterbox GPU TTS service URL. Only used when `TTS_PROVIDER=chatterbox`. |
| `CHATTERBOX_VOICE` | `jarvis` | Active voice clone (`jarvis` or `custom`). |
| `CHATTERBOX_DEFAULT_VOICE` | `jarvis` | Default voice when none specified in request. |
| `STREAMING_TTS_ENABLED` | `true` | Sentence-level chunking — faster time-to-first-word. Code checks `!== 'false'`. Used with both Piper and Chatterbox. |
| `EDGE_TTS_PATH` | `~/.local/bin/edge-tts` | Path to the Edge TTS binary |
| `EDGE_TTS_VOICE` | `en-AU-WilliamNeural` | Fallback voice for Edge TTS |
| `MAX_SPOKEN_SECONDS` | `20` | Max seconds of spoken output before auto-truncation |

> **Note:** When `TTS_PROVIDER` is unset, routing falls back to `PIPER_ENABLED` for backward compatibility: `PIPER_ENABLED=true` → Piper primary, Edge TTS fallback; `PIPER_ENABLED=false` → Edge TTS directly.

### STT

`faster-whisper` (local GPU) is the **recommended** STT backend. The code default is `whisper` (local Whisper CLI) but `.env.example` ships with `faster-whisper`.

| Variable | Code Default | Description |
|---|---|---|
| `STT_PROVIDER` | `whisper` | STT backend: `faster-whisper` (local GPU, recommended) \| `deepgram` (cloud) \| `mlx-whisper` (remote Mac) \| `whisper` (local Whisper CLI) \| `moonshine` (local CPU) \| `vosk` (local CPU, fastest) |
| `WHISPER_MODEL` | `tiny` | Whisper model size: `tiny` (fast) \| `base` \| `small` \| `medium` (balanced) \| `large-v3` (best). Code default is `tiny`; use `medium` or higher for production. |
| `VAD_TIMEOUT` | `1500` | Silence duration (ms) before treating speech as complete |
| `WHISPER_PATH` | `~/.local/bin/whisper` | Path to local Whisper CLI binary |
| `DEEPGRAM_API_KEY` | — | Required when `STT_PROVIDER=deepgram` |
| `MLX_WHISPER_URL` | `http://localhost:8765/transcribe` | Remote MLX Whisper endpoint (set to your Mac's IP/hostname) |

> **Note:** The code default for `STT_PROVIDER` is `whisper` and `WHISPER_MODEL` is `tiny`, but `.env.example` sets `STT_PROVIDER=faster-whisper` and `WHISPER_MODEL=medium`. Use `faster-whisper` with a GPU for production.

### Streaming & Voice Model

| Variable | Code Default | Description |
|---|---|---|
| `VOICE_STREAMING` | `true` | SSE streaming from gateway. Code checks `!== 'false'`. Set to `false` for CLI-based providers that don't support SSE. |
| `VOICE_MODEL` | `anthropic-console/claude-sonnet-4-6` | Model used for voice gateway requests |
| `ACK_MODEL` | `anthropic-console/claude-sonnet-4-6` | Model used for fast acknowledgment generation |

### Mobile Mode

| Variable | Code Default | Description |
|---|---|---|
| `VOICE_MOBILE_MODE` | `false` | Persistent mobile/on-the-go mode. Toggleable by voice: "I'm on the go" / "I'm at my desk". |

### Gateway Timeout

| Variable | Code Default | Description |
|---|---|---|
| `GATEWAY_TIMEOUT_MS` | `90000` | Max time to wait for a complete voice response (90s) |
| `GATEWAY_FIRST_TOKEN_TIMEOUT_MS` | `8000` | If no streaming token in this time, Jarvis says "One moment." |

### Alert Webhook

| Variable | Code Default | Description |
|---|---|---|
| `TAILSCALE_IP` | — | Tailscale/VPN IP for webhook binding and `/speak` URL generation. Takes priority over `ALERT_WEBHOOK_HOST`. |
| `ALERT_WEBHOOK_HOST` | `localhost` | Fallback bind address if `TAILSCALE_IP` is unset. Set to `0.0.0.0` for remote access. |
| `ALERT_WEBHOOK_PORT` | `3335` | Port for the webhook HTTP server |
| `ALERT_WEBHOOK_TOKEN` | — | Bearer token callers must include. **Change this** — the default is not secure. |
| `ALERTS_ALSO_POST_TEXT` | `true` | Mirror all alerts and voice results to the text channel. Code checks `!== 'false'`. |

### Webhook Callback Mode

| Variable | Code Default | Description |
|---|---|---|
| `WEBHOOK_CALLBACK_MODE` | `false` | Fire-and-forget: voice requests go to `/hooks/agent`, response comes via `/speak`. No timeout pressure. |
| `VOICE_CALLBACK_CHANNEL_ID` | *(falls back to TEXT_CHANNEL_ID)* | Channel for webhook callback responses |

### Multi-User

| Variable | Code Default | Description |
|---|---|---|
| `MULTI_USER_ENABLED` | `false` | When `true`, listens to all users in voice channel (not just `ALLOWED_USERS`). `ALLOWED_USERS` retain admin control (stop, cancel, mode toggles). |

### Record Mode

| Variable | Code Default | Description |
|---|---|---|
| `RECORD_CHANNEL_ID` | — | Voice channel ID for auto-entering record mode when owner joins |
| `RECORD_TEXT_CHANNEL_ID` | — | Text channel for record mode transcript output |

### Activity Feed

| Variable | Code Default | Description |
|---|---|---|
| `ACTIVITY_FEED_ENABLED` | `true` | Post task lifecycle events to the activity channel. Code checks `!== 'false'`. |
| `DISCORD_ACTIVITY_CHANNEL_ID` | *(falls back to TEXT_CHANNEL_ID)* | Channel for task activity feed posts |

### Session / Gateway Identity

| Variable | Code Default | Description |
|---|---|---|
| `SESSION_USER` | `jarvis-voice-user` | OpenClaw gateway session namespace |
| `CLAWDBOT_BOT_ID` | *(empty)* | Discord user ID of the OpenClaw/Clawdbot bot (used to filter webhook callback messages) |
| `CLAWDBOT_HOOKS_TOKEN` | *(falls back to GATEWAY_TOKEN)* | Token for `/hooks/agent` webhook endpoint |

### Speaker Extras

| Variable | Code Default | Description |
|---|---|---|
| `SPEAKER_DIARIZE_URL` | `http://localhost:8767/diarize` | Speaker diarization endpoint for record mode |
| `SPEAKER_PASSPHRASE` | *(empty)* | Secret passphrase to force-authenticate without voiceprint |

### Utterance Grouping

| Variable | Code Default | Description |
|---|---|---|
| `UTTERANCE_DEBOUNCE_MS` | `2000` | Buffer window (ms) to merge rapid speech fragments before dispatching to the brain |

### Bluetooth

| Variable | Code Default | Description |
|---|---|---|
| `BT_LEAD_IN_MS` | `0` | Milliseconds of near-silent audio to prepend before first clip. Wakes Bluetooth speakers on dead air instead of clipping the first syllable. |

---

## Webhook API

The alert webhook server starts automatically with the bot. Default port: `3335`.

### POST /speak

Push text directly to the voice channel. Used by sub-agents to report back after completing a task.

```bash
curl -X POST http://localhost:3335/speak \
  -H "Authorization: Bearer $ALERT_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Deployment complete. Build passed all tests.", "source": "ci"}'
```

### POST /handoff

Queue context for voice pickup when the user next joins the voice channel.

```bash
curl -X POST http://localhost:3335/handoff \
  -H "Authorization: Bearer $ALERT_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"context": "The scan finished. Three findings, two high.", "source": "scanner"}'
```

### POST /post

Post content to Discord as a titled thread in the configured text channel.

```bash
curl -X POST http://localhost:3335/post \
  -H "Authorization: Bearer $ALERT_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Nightly Report", "body": "All systems nominal."}'
```

### POST /alert

Queue a priority alert with 5-tier classification. Voice delivery depends on the current FSM state -- critical alerts break through sleep, low-priority alerts go to text only.

```bash
# P1 Critical -- breaks through SLEEP
curl -X POST http://localhost:3335/alert \
  -H "Authorization: Bearer $ALERT_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Production database unreachable",
    "priority": "critical",
    "source": "monitoring"
  }'

# P2 Urgent -- voice in ACTIVE/IDLE, breaks through SLEEP if channel quiet
curl -X POST http://localhost:3335/alert \
  -H "Authorization: Bearer $ALERT_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "High memory on prod-01 — 94% for 10 minutes",
    "priority": "urgent",
    "fullDetails": "Top offenders: nginx 38%, postgres 31%, redis 12%.",
    "source": "monitoring"
  }'

# Explicit numeric priority (1-5)
curl -X POST http://localhost:3335/alert \
  -H "Authorization: Bearer $ALERT_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Nightly backup completed successfully",
    "priorityLevel": 5,
    "source": "cron"
  }'
```

#### Priority Tiers

| P | Name | ACTIVE | IDLE | SLEEP |
|---|---|---|---|---|
| P1 | Critical | Voice immediately | Voice immediately | Break through, voice |
| P2 | Urgent | Voice immediately | Voice immediately | Voice if quiet |
| P3 | Medium | Queue for pause | Text only | Text only |
| P4 | Low | Text only | Text only | Text only |
| P5 | Info | Text only | Text only | Text only |

Priority is auto-classified from keywords when `priorityLevel` is not set:
- **P1:** breach, compromised, down, outage, critical, emergency
- **P2:** failed, error, degraded, unreachable
- **P3:** complete, finished, done, result (default for `priority: "normal"`)
- **P4/P5:** explicit `priority: "low"` or `priority: "info"`

Fields: `message` (required), `priority` (`critical`|`urgent`|`normal`|`low`|`info`), `priorityLevel` (1-5, explicit override), `fullDetails` (optional), `source` (optional label).

### GET /health

```bash
curl http://localhost:3335/health
# {"ok":true,"service":"jarvis-voice-alerts"}
```

### GET /reminders

Returns pending reminders queued in the bot.

### GET /context/active

Returns the current active voice context (conversation state).

---

## STT Backends

### faster-whisper (local GPU) — recommended

Runs `large-v3` via CUDA on a persistent GPU service. Lowest latency, highest accuracy. Requires NVIDIA GPU.

```env
STT_PROVIDER=faster-whisper
```

Set up with `./setup-gpu-env.sh`. Runs as `jarvis-whisper-stt.service` on port 8766.

### Deepgram (cloud)

Streaming, low latency, no GPU required. Free $200 credit at console.deepgram.com. Best cloud fallback.

```env
STT_PROVIDER=deepgram
DEEPGRAM_API_KEY=your_key_here
```

### mlx-whisper (remote Mac)

Offloads to a Mac with Apple Silicon running the MLX Whisper server. Highest accuracy with `large-v3` on M-series chips.

```env
STT_PROVIDER=mlx-whisper
MLX_WHISPER_URL=http://your-mac-host:8765/transcribe
```

### whisper (local CLI)

Local Whisper via the `whisper` binary. No API calls, fully offline. Slower than faster-whisper but works on CPU.

```env
STT_PROVIDER=whisper
WHISPER_MODEL=medium
```

### moonshine (local CPU)

Fast local STT via Moonshine. CPU-friendly, good for low-resource machines.

```env
STT_PROVIDER=moonshine
```

### vosk (local CPU)

Fastest local option (~100-300ms). Lower accuracy than Whisper but near-instant. CPU-only.

```env
STT_PROVIDER=vosk
```

---

## Requirements

- Linux with systemd (Ubuntu 22.04+)
- **Node.js 22+** (v22.12+ required for `@snazzah/davey` DAVE E2EE native addon)
- Python 3.12+ with venv
- ffmpeg
- Discord bot token (separate application from your main bot)
- OpenClaw gateway

> **Note:** Node.js 18 and 20 are no longer supported. The DAVE protocol native addon (`@snazzah/davey@0.1.9`) requires Node.js 22.12+. Discord will reject voice connections without DAVE E2EE starting March 2026.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design and component overview
- [docs/DEBUGGING.md](docs/DEBUGGING.md) — troubleshooting and common issues
- [docs/ALERTS.md](docs/ALERTS.md) — alert system in depth
- [docs/DEEPGRAM_SETUP.md](docs/DEEPGRAM_SETUP.md) — Deepgram STT setup
- [docs/EXAMPLES.md](docs/EXAMPLES.md) — usage examples and curl recipes
- [docs/TESTING.md](docs/TESTING.md) — running the test suite

## Troubleshooting

### CUPTI symbol error / CUDA ABI mismatch

**Symptom:** `jarvis-whisper-stt.service` crash-loops with:
```
OSError: libtorch_cpu.so: undefined symbol: cuptiActivityEnableDriverApi
```

**Cause:** torch was built against CUDA 12.1 but the installed NVIDIA driver ships CUDA 13.x. The `libcupti.so` ABI changed between versions.

**Fix — rebuild the venv with a newer torch:**
```bash
./setup-gpu-env.sh --force
```

This deletes the existing venv and reinstalls `torch>=2.6.0` which is compatible with CUDA 13.x drivers.

**Fix — CPU-only fallback (no GPU rebuild):**
Edit `~/.config/systemd/user/jarvis-whisper-stt.service` and append `--device cpu` to `ExecStart`:
```ini
ExecStart=%h/jarvis-voice/venv/bin/python3 %h/jarvis-voice/gpu-services/whisper_stt_service.py --device cpu
```
Then: `systemctl --user daemon-reload && systemctl --user restart jarvis-whisper-stt`

---

### Service restart loop

**Symptom:** `systemctl --user status jarvis-whisper-stt` shows 800+ restarts, journal is flooding.

**Detect:**
```bash
systemctl --user status jarvis-whisper-stt | grep -E "restart|failed"
journalctl --user -u jarvis-whisper-stt -n 20
```

**Stop the storm immediately:**
```bash
systemctl --user stop jarvis-whisper-stt
```

**Permanent fix:** The service template in `gpu-services/jarvis-whisper-stt.service` uses `RestartSec=30` and `StartLimitBurst=5` to cap restart frequency. Copy it over your local unit:
```bash
cp gpu-services/jarvis-whisper-stt.service ~/.config/systemd/user/
systemctl --user daemon-reload
```

---

### DNS race on boot (ENOTFOUND discord.com)

**Symptom:** `jarvis-voice.service` fails at boot with `ENOTFOUND discord.com`, recovers after a manual restart.

**Cause:** `After=network.target` does not guarantee DNS is available. The service starts before the resolver is ready.

**Fix:** Use the service template in `gpu-services/jarvis-voice.service` which uses `After=network-online.target`:
```bash
cp gpu-services/jarvis-voice.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user restart jarvis-voice
```

---

### Venv rebuild (--force)

Any time you need a clean slate:
```bash
./setup-gpu-env.sh --force
```

This removes `venv/`, recreates it, reinstalls all Python deps, and runs the CUDA diagnostic.

---

## Contributing

Open an issue or pull request. Keep changes focused — one concern per PR.

## License

See [LICENSE](LICENSE).
