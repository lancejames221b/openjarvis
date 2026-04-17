# Jarvis Voice — OpenClaw Install Playbook

> This file is machine-readable. If you're using the `install-jarvis` OpenClaw skill,
> the AI will follow this playbook step by step, run commands, verify each step, and ask
> you for inputs when needed. You don't have to read this manually.

---

## Prerequisites Checklist

Before starting, verify:

```bash
node --version          # Must be 22+
python3 --version       # Must be 3.11+
openclaw gateway status # Must show running
```

Required before Step 6:
- Discord bot token (create a **separate** bot at https://discord.com/developers/applications)
- Your Discord Guild (server) ID
- The voice channel ID you want Jarvis to join
- A text channel ID for Jarvis to post transcripts and alerts

---

## Step 1: Clone the repo

```bash
git clone https://github.com/lancejames221b/jarvis-voice.git
cd jarvis-voice
```

**Verify:** `ls src/index.js` exists.

---

## Step 2: Install Node dependencies

```bash
npm install
node --check src/index.js
```

**Verify:** No errors. `node --check` exits 0.

---

## Step 3: Set up Python GPU services

The installer will detect your platform automatically:

```bash
./setup-gpu-env.sh --auto
```

This detects NVIDIA CUDA, Apple Silicon (Metal), or CPU-only and installs the right PyTorch variant.

**Verify:** `source venv/bin/activate && python3 -c "import faster_whisper; print('OK')"` prints `OK`.

**If CUDA:** Also verify `python3 -c "import torch; print(torch.cuda.is_available())"` prints `True`.

---

## Step 4: Download Piper and voice model

```bash
# Install Piper binary
pip install piper-tts

# Download the Jarvis voice model
mkdir -p models/jarvis
# High quality (recommended, ~65MB):
curl -L "https://huggingface.co/jgkawell/jarvis/resolve/main/jarvis-high.onnx" \
     -o models/jarvis/jarvis-high.onnx
curl -L "https://huggingface.co/jgkawell/jarvis/resolve/main/jarvis-high.onnx.json" \
     -o models/jarvis/jarvis-high.onnx.json
```

**Verify:** `ls models/jarvis/` shows `jarvis-high.onnx` and `jarvis-high.onnx.json`.

---

## Step 5: Configure environment

```bash
cp .env.example .env
```

The installer will prompt for each required value and write it to `.env`:

| Variable | Where to get it |
|----------|----------------|
| `DISCORD_TOKEN` | Discord Developer Portal → your bot → Token |
| `DISCORD_GUILD_ID` | Right-click your server → Copy Server ID |
| `DISCORD_VOICE_CHANNEL_ID` | Right-click voice channel → Copy Channel ID |
| `DISCORD_TEXT_CHANNEL_ID` | Right-click text channel → Copy Channel ID |
| `ALLOWED_USERS` | Right-click your Discord username → Copy User ID |
| `CLAWDBOT_GATEWAY_URL` | Usually `http://127.0.0.1:22100` |
| `CLAWDBOT_GATEWAY_TOKEN` | From your OpenClaw config |
| `ALERT_WEBHOOK_TOKEN` | Generate: `openssl rand -hex 32` |

**Verify:** `grep DISCORD_TOKEN .env` is not empty.

---

## Step 6: Configure your Discord bot

Your bot needs these settings at https://discord.com/developers/applications → your app:

**Bot → Privileged Gateway Intents:**
- [x] Server Members Intent
- [x] Message Content Intent
- [x] Presence Intent (optional)

**OAuth2 → URL Generator:**
- Scopes: `bot`, `applications.commands`
- Bot Permissions: `Connect`, `Speak`, `Use Voice Activity`, `Send Messages`, `Read Messages/View Channels`, `Embed Links`

Copy the generated URL and open it in your browser to invite the bot to your server.

**Verify:** Bot appears in your server member list.

---

## Step 7: Start the services

### Linux (systemd — recommended for production)

```bash
# Copy service files
mkdir -p ~/.config/systemd/user
cp gpu-services/*.service ~/.config/systemd/user/
systemctl --user daemon-reload

# Start in order
systemctl --user start jarvis-piper-tts
systemctl --user start jarvis-whisper-stt
systemctl --user start jarvis-speaker-verify
systemctl --user start jarvis-voice

# Enable on login
systemctl --user enable jarvis-piper-tts jarvis-whisper-stt jarvis-speaker-verify jarvis-voice
systemctl --user enable --now systemd-resolved 2>/dev/null || true
loginctl enable-linger $USER
```

### Manual (any platform)

```bash
# Terminal 1 — Piper TTS
source venv/bin/activate
python3 gpu-services/piper_tts_service.py

# Terminal 2 — Whisper STT
python3 gpu-services/whisper_stt_service.py --device cpu  # or cuda

# Terminal 3 — Speaker verification (optional)
python3 gpu-services/speaker_verify_service.py --device cpu

# Terminal 4 — Voice bot
node src/index.js
```

---

## Step 8: Verify health

```bash
curl -sf http://localhost:3336/health && echo "Piper TTS: OK"
curl -sf http://localhost:8766/health && echo "Whisper STT: OK"
curl -sf http://localhost:8767/health && echo "Speaker verify: OK"
```

**Verify:** All three print OK. If any fail, check logs:
```bash
journalctl --user -u jarvis-piper-tts -n 20
journalctl --user -u jarvis-whisper-stt -n 20
```

---

## Step 9: First voice test

Join the configured Discord voice channel. Say:

> "Hello, Jarvis."

**Expected:** Jarvis responds within ~2 seconds with a greeting.

If no response: check that the bot is in the channel, check `.env` DISCORD_VOICE_CHANNEL_ID matches where you are, check `journalctl --user -u jarvis-voice -n 50`.

---

## Step 10: Voiceprint enrollment (optional but recommended)

Voiceprint authentication means only your voice can command Jarvis. No one else in the room can give orders.

```bash
bash enroll-voice.sh
```

Follow the prompts — you'll say 3 enrollment phrases. Enrollment takes about 60 seconds.

Or say in OpenClaw: **"enroll my voice"** to use the guided skill.

Enable in `.env`:
```
SPEAKER_VERIFY_ENABLED=true
```
Restart the voice bot and speaker-verify service.

---

## Step 11: Choose your tier

| Tier | What you get | Setup time |
|------|-------------|------------|
| **REACTOR** | Voice bot + Jarvis personality + voiceprint | Done — you're already here |
| **FRIDAY** | + Morning briefing, comms check, calendar, media control | ~30 more minutes |
| **JARVIS** | + Security intel, full memory, everything | ~60 more minutes |

To install tier skills, copy them from `skills/` to your OpenClaw skills directory:

```bash
# Find your OpenClaw skills directory
openclaw skills list 2>/dev/null | head -3 || echo "Check openclaw config for skillsPath"

# Example — FRIDAY tier
cp -r skills/pulse skills/comms-check skills/roku-control skills/plex-media \
      skills/haivemind-remember skills/where-is skills/voice-audio-mode \
      skills/voice-handoff skills/jarvis-voice-briefing \
      ~/.openclaw/skills/   # adjust path to match your install
```

Then configure each skill per its `SETUP.md`.

### FRIDAY / JARVIS tier: hAIveMind required

The `haivemind-remember`, `where-is`, and `jarvis-evolve` skills require the hAIveMind MCP server — a local vector memory database that gives Jarvis persistent memory across sessions.

```bash
# Install hAIveMind
git clone https://github.com/lancejames221b/agent-hivemind.git
cd agent-hivemind
pip install -r requirements.txt
python server.py   # runs on port 8900
```

See [skills/haivemind-remember/SETUP.md](../skills/haivemind-remember/SETUP.md) for OpenClaw config and verification steps.

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Bot joins channel but doesn't hear you | Discord DAVE E2EE — use voice gateway v8 (discord.js 14.16+) |
| STT working but no response | Check CLAWDBOT_GATEWAY_URL and GATEWAY_TOKEN in .env |
| Piper TTS fails silently | Check PIPER_BIN path; `which piper` or `~/.local/bin/piper` |
| Speaker verify blocks all audio | Set SPEAKER_VERIFY_ENABLED=false until enrolled |
| High latency | Switch STT to `deepgram` for cloud speed; check GPU VRAM for Whisper |

Full debugging guide: [docs/DEBUGGING.md](docs/DEBUGGING.md)
