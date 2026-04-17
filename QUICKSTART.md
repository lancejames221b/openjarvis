# Jarvis Voice — Quick Start

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 22+ | `node --version` |
| `claude` CLI (Claude Code) | `~/.local/bin/claude` — install from [claude.ai/code](https://claude.ai/code), then run `claude login` |
| `ffmpeg` | `sudo apt install ffmpeg` / `brew install ffmpeg` |
| A Discord Bot token | Create at [discord.com/developers](https://discord.com/developers/applications) |

**Claude account**: You need a personal [Claude Max](https://claude.ai) subscription or a [Claude Teams](https://claude.ai/teams) seat, and the `claude` CLI authenticated to it (`claude login`). One account per human — see [docs/MULTI_ACCOUNT.md](docs/MULTI_ACCOUNT.md) if multiple people will use different channels.

Optional GPU services (Piper TTS, Whisper STT) require Python 3.10+ and are covered in [INSTALL.md](INSTALL.md).

---

## 5-minute setup

```bash
# 1. Clone and install
git clone https://github.com/your-org/jarvis-voice.git
cd jarvis-voice
npm install

# 2. Authenticate the Claude CLI (once per machine)
claude login

# 3. Configure
cp .env.example .env
# Edit .env — fill in the 8 REQUIRED vars (see below)

# 4. Start services
# Copy and enable the gateway service
cp scripts/jarvis-gateway.service ~/.config/systemd/user/
cp scripts/jarvis-voice.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now jarvis-gateway
systemctl --user enable --now jarvis-voice
```

---

## Required .env vars (8 total)

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from Discord developer portal |
| `DISCORD_GUILD_ID` | Your server/guild ID (right-click server → Copy ID) |
| `DISCORD_VOICE_CHANNEL_ID` | The voice channel ID Jarvis should join |
| `DISCORD_TEXT_CHANNEL_ID` | Text channel for responses and notifications |
| `ALLOWED_USERS` | Comma-separated Discord user IDs allowed to give commands |
| `JARVIS_GATEWAY_URL` | `http://127.0.0.1:22100` (default — no change needed) |
| `JARVIS_GATEWAY_TOKEN` | Auth token: `openssl rand -hex 32` |
| `ALERT_WEBHOOK_TOKEN` | Same or different token: `openssl rand -hex 32` |

---

## Verify it's working

```bash
# Gateway health
curl -s http://127.0.0.1:22100/health

# Quick chat test
curl -s -X POST http://127.0.0.1:22100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JARVIS_GATEWAY_TOKEN" \
  -d '{"messages":[{"role":"user","content":"say hello"}],"stream":false}'

# Watch logs
journalctl --user -u jarvis-gateway -f
journalctl --user -u jarvis-voice -f
```

Discord: Join the configured voice channel and say "Jarvis, what time is it?"

---

## Discord Bot setup

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → New Application
2. Bot tab → Reset Token → copy to `DISCORD_TOKEN`
3. Enable Privileged Intents: **Server Members**, **Message Content**
4. OAuth2 → URL Generator → scopes: `bot`, `applications.commands`
5. Bot permissions: Connect, Speak, Send Messages, Embed Links, Read Message History
6. Copy the generated URL, open it, add bot to your server

---

## Next steps

- **GPU voice quality**: See [INSTALL.md](INSTALL.md) for Piper TTS (offline, fast) and Whisper STT (accurate)
- **Multiple Claude accounts**: See [docs/MULTI_ACCOUNT.md](docs/MULTI_ACCOUNT.md)
- **Troubleshooting**: See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- **All env vars**: See [.env.example](.env.example) — everything is documented inline
