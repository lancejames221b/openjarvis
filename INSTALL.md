# Installing Jarvis Voice

Two paths: **Docker** (recommended — portable, no dependency fiddling) or **manual** (systemd, direct install).

---

## Docker Install (recommended)

### What you need

- Docker 24+ with Compose v2
- NVIDIA Container Toolkit for GPU mode — [install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
- A Discord bot token (Step 1 below applies to both paths)
- Jarvis ONNX voice models (see [Voice Models](#voice-models) section)

### Steps

```bash
git clone https://github.com/lancejames221b/jarvis-voice.git
cd jarvis-voice

# Configure
cp .env.example .env
$EDITOR .env   # fill in DISCORD_TOKEN, CLAWDBOT_GATEWAY_URL, ALLOWED_USERS

# GPU mode (default)
docker compose up -d

# CPU-only
PLATFORM=cpu docker compose --profile cpu up -d
```

Voiceprint enrollment after the container is running:

```bash
# Copy an existing voiceprint into the named volume
docker run --rm \
  -v jarvis-voice_voiceprints:/voiceprints \
  -v ~/.jarvis:/src:ro \
  alpine cp /src/owner_voiceprint.npy /voiceprints/

# Or enroll fresh via Discord ("Jarvis, enroll my voice") — enrollment saves
# automatically to the voiceprints volume
```

To upgrade:

```bash
git pull
docker compose build --pull
docker compose up -d
```

---

## Voice Models

The Jarvis voice model (ONNX, ~170MB) is required for Piper TTS. Download before starting:

```bash
mkdir -p models/jarvis

# High quality (recommended)
wget -O models/jarvis/jarvis-high.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/jarvis/high/en_GB-jarvis-high.onnx
wget -O models/jarvis/jarvis-high.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/jarvis/high/en_GB-jarvis-high.onnx.json

# Medium quality (optional — faster synthesis)
wget -O models/jarvis/jarvis-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/jarvis/medium/en_GB-jarvis-medium.onnx
wget -O models/jarvis/jarvis-medium.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/jarvis/medium/en_GB-jarvis-medium.onnx.json
```

---

## Mac (Apple Silicon) — Test Setup

For development and testing on M1/M2/M3/M4:

```bash
cp .env.mac-test.example .env.mac-test
$EDITOR .env.mac-test   # fill in test bot token + guild IDs
./scripts/mac-test.sh
```

This starts mlx-whisper (STT), Piper TTS, and the voice bot in an isolated test environment. See `.env.mac-test.example` for all options.

---

## Manual Install (Linux/systemd)

Step-by-step setup for a generic Linux machine. Tested on Ubuntu 22.04+.

---

## What you need

- **Linux** with systemd (Ubuntu 22.04+ recommended)
- **Node.js 22+** — [nodejs.org](https://nodejs.org) or via `nvm`
- **Python 3.12+** with `venv`
- **ffmpeg** — `apt install ffmpeg`
- **NVIDIA GPU** (optional but recommended for local STT)
- **Discord bot token** — a separate bot application, not your main bot
- **OpenClaw** running locally — [openclaw.ai](https://openclaw.ai)

> **Note:** Node.js 22.12+ is required. The Discord DAVE E2EE native addon (`@snazzah/davey`) does not support older versions.

---

## Step 1 — Create a Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → name it "Jarvis Voice" (or anything you like)
3. Go to **Bot** → click **Add Bot**
4. Under **Privileged Gateway Intents**, enable:
   - `GUILD_VOICE_STATES`
   - `GUILDS`
   - `MESSAGE_CONTENT`
5. Copy the **Bot Token** — you'll need it in Step 4
6. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Permissions: `Connect`, `Speak`, `Mute Members`, `Move Members`, `Send Messages`, `Read Message History`
7. Open the generated URL in a browser and add the bot to your server

> Do **not** reuse your main OpenClaw/Clawdbot — use a dedicated bot application.

---

## Step 2 — Get your IDs

Enable **Developer Mode** in Discord: Settings → Advanced → Developer Mode.

- **Guild ID**: Right-click your server icon → Copy Server ID
- **Voice Channel ID**: Right-click your voice channel → Copy Channel ID
- **Text Channel ID**: Right-click your text/status channel → Copy Channel ID
- **Your User ID**: Right-click your name → Copy User ID

---

## Step 3 — Clone and install

```bash
git clone https://github.com/lancejames221b/jarvis-voice.git
cd jarvis-voice
npm install
```

Verify DAVE E2EE is detected:

```bash
node -e "import('@discordjs/voice').then(v => console.log(v.generateDependencyReport()))"
# Should show: DAVE Libraries → @snazzah/davey: 0.1.9
```

---

## Step 4 — Configure

```bash
cp .env.example .env
nano .env   # or your editor of choice
```

**Minimum required fields:**

```bash
DISCORD_TOKEN=           # Bot token from Step 1
DISCORD_GUILD_ID=        # Server ID from Step 2
DISCORD_VOICE_CHANNEL_ID=  # Voice channel ID from Step 2
DISCORD_TEXT_CHANNEL_ID=   # Text channel ID from Step 2
ALLOWED_USERS=           # Your Discord user ID from Step 2
CLAWDBOT_GATEWAY_URL=http://127.0.0.1:22100   # Your OpenClaw gateway
CLAWDBOT_GATEWAY_TOKEN=  # Your OpenClaw gateway token
ALERT_WEBHOOK_TOKEN=     # Generate: openssl rand -hex 32
```

All other settings have working defaults. See `.env.example` for the full annotated list.

---

## Step 5 — Install the Piper TTS binary

Jarvis Voice uses [Piper TTS](https://github.com/rhasspy/piper) for voice synthesis. Piper runs **inside** the main bot process as a persistent child process — it is spawned by `src/piper-server.js` which wraps it in an HTTP server on port 3336. No separate systemd service is needed for Piper.

Install the Piper binary:

```bash
# Option 1: pip (easiest)
pip install piper-tts

# Option 2: Download binary from GitHub releases
# https://github.com/rhasspy/piper/releases
# Place the binary at ~/.local/bin/piper (or set PIPER_BIN in .env)
```

Verify Piper is installed:

```bash
piper --version
# or: ~/.local/bin/piper --version
```

If Piper is installed somewhere other than `~/.local/bin/piper`, set `PIPER_BIN` in your `.env`.

---

## Step 6 — Download the Jarvis voice model

Jarvis Voice uses a custom British RP Piper voice clone from [jgkawell/jarvis](https://huggingface.co/jgkawell/jarvis):

```bash
mkdir -p models/jarvis

# High quality (recommended — best audio, ~3.5s synthesis)
wget "https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis/high/jarvis-high.onnx" \
  -O models/jarvis/jarvis-high.onnx
wget "https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis/high/jarvis-high.onnx.json" \
  -O models/jarvis/jarvis-high.onnx.json

# Medium quality (optional — faster synthesis, ~1.5s)
wget "https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis/medium/jarvis-medium.onnx" \
  -O models/jarvis/jarvis-medium.onnx
wget "https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis/medium/jarvis-medium.onnx.json" \
  -O models/jarvis/jarvis-medium.onnx.json
```

Or use the installer script which does this automatically:

```bash
bash skill/install.sh
```

---

## Step 7 — Install Edge TTS (fallback)

Edge TTS is the automatic fallback when Piper is unavailable. Install it:

```bash
pip install edge-tts
```

The Edge TTS binary defaults to `~/.local/bin/edge-tts`. If installed elsewhere, set `EDGE_TTS_PATH` in your `.env`.

---

## Step 8 — Install systemd service

```bash
mkdir -p ~/.config/systemd/user
cp gpu-services/jarvis-voice.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now jarvis-voice.service
```

Check it's running:

```bash
systemctl --user status jarvis-voice.service
journalctl --user -u jarvis-voice.service -f
```

You should see:
```
✅ Joined voice channel XXXXXXXXXX (default)
🗣️  Piper TTS (JARVIS) listening on 127.0.0.1:3336
```

---

## Step 9 — Test it

Join the voice channel in Discord and say:

```
"Hey Jarvis, what time is it?"
```

Jarvis should respond in 1–3 seconds in the Jarvis British voice.

---

## Optional: GPU Speech-to-Text (faster-whisper)

For the best STT accuracy and speed, run Whisper locally on an NVIDIA GPU:

```bash
./setup-gpu-env.sh

# Install and enable the Whisper STT service
cp gpu-services/jarvis-whisper-stt.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now jarvis-whisper-stt.service
```

Set in `.env`:
```bash
STT_PROVIDER=faster-whisper
WHISPER_MODEL=medium    # or large-v3 for best accuracy
```

Then restart:
```bash
systemctl --user restart jarvis-voice.service
```

---

## Optional: Speaker Verification (voiceprint auth)

Locks Jarvis to only your voice. Requires NVIDIA GPU.

```bash
# Install and enable the speaker verification service
cp gpu-services/jarvis-speaker-verify.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now jarvis-speaker-verify.service
```

Set in `.env`:
```bash
SPEAKER_VERIFY_ENABLED=true
SPEAKER_VERIFY_STRICT=false   # Set true once your voiceprint is enrolled
```

Restart, then enroll your voice by saying:
```
"Jarvis, enroll my voice"
```

Jarvis will guide you through 10 phrases. Once done, only your voice gets through.

---

## Optional: Deepgram STT (cloud, no GPU required)

If you don't have a GPU, Deepgram is the best cloud STT option:

1. Sign up at [console.deepgram.com](https://console.deepgram.com) — free $200 credit
2. Create an API key
3. Set in `.env`:
   ```bash
   STT_PROVIDER=deepgram
   DEEPGRAM_API_KEY=your_key_here
   ```

---

## Optional: MLX Whisper on Mac

If you have a Mac with Apple Silicon, you can offload STT to it for highest accuracy with the `large-v3` model:

1. Set up the MLX Whisper server on your Mac
2. Set in `.env`:
   ```bash
   STT_PROVIDER=mlx-whisper
   MLX_WHISPER_URL=http://your-mac-host:8765/transcribe
   ```

---

## All systemd services

| Service | Required | Purpose |
|---------|----------|---------|
| `jarvis-voice.service` | **Yes** | Main Discord bot + Piper TTS (in-process on port 3336) |
| `jarvis-whisper-stt.service` | Optional | GPU faster-whisper STT (port 8766) |
| `jarvis-speaker-verify.service` | Optional | ECAPA-TDNN voiceprint auth (port 8767) |

> **Note:** There is no separate Piper TTS systemd service. Piper runs inside `jarvis-voice.service` — the main bot spawns a persistent Piper child process via `src/piper-server.js`, which exposes an HTTP server on port 3336 for TTS requests.

---

## Troubleshooting

**Bot joins but doesn't respond to voice**
- Check `ALLOWED_USERS` includes your Discord user ID
- Check `CLAWDBOT_GATEWAY_URL` and `CLAWDBOT_GATEWAY_TOKEN` are correct
- Check gateway is running: `curl http://127.0.0.1:22100/health`

**No voice output (text only)**
- Check Piper binary is installed: `piper --version` or `~/.local/bin/piper --version`
- Check voice model files exist in `models/jarvis/`
- Check `PIPER_BIN` points to the actual binary location
- Jarvis will fall back to Edge TTS if Piper fails — check Edge TTS: `edge-tts --version`
- If both fail, responses degrade to text-only (no voice switch mid-conversation)

**"ENOTFOUND discord.com" on boot**
- DNS race condition. The service template uses `After=network-online.target` to fix this
- Re-copy: `cp gpu-services/jarvis-voice.service ~/.config/systemd/user/ && systemctl --user daemon-reload`

**CUDA / torch ABI mismatch (Whisper service)**
- Run: `./setup-gpu-env.sh --force` to rebuild the venv with a compatible torch version

**Voice not recognized (speaker verify rejecting you)**
- Re-enroll: say "Jarvis, enroll my voice" to redo enrollment
- Check the speaker verification service is running: `systemctl --user status jarvis-speaker-verify`

**Sub-agent /speak callbacks not reaching Jarvis**
- Set `TAILSCALE_IP` (or `ALERT_WEBHOOK_HOST`) to your machine's VPN/Tailscale IP (not `localhost`)
- Verify: `curl -X POST http://YOUR_IP:3335/speak -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"message":"test"}'`

---

## Upgrading

```bash
cd jarvis-voice
git pull
npm install
systemctl --user restart jarvis-voice.service
```

---

See [README.md](README.md) for full feature documentation.
