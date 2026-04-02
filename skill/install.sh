#!/usr/bin/env bash
# Jarvis Voice — OpenClaw Skill Installer
# Checks dependencies, scaffolds .env, installs npm packages, and creates the systemd user service.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="$HOME/.config/systemd/user"

echo "=== Jarvis Voice Installer ==="
echo "Repo: $REPO_DIR"
echo ""

# ── 1. Check dependencies ─────────────────────────────────────────────
check_dep() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: $1 not found. $2"; exit 1
  fi
}

check_dep node "Install Node.js 22+ from https://nodejs.org"
check_dep python3 "Install Python 3.12+"
check_dep ffmpeg "Run: apt install ffmpeg"

# Verify Node.js version is >= 22 (required for DAVE E2EE native addon)
if ! node -e "process.exit(parseInt(process.versions.node) < 22 ? 1 : 0)" 2>/dev/null; then
  echo "ERROR: Node.js 22+ required (found: $(node --version)). Required for Discord DAVE E2EE support."; exit 1
fi

echo "✓ node $(node --version)"
echo "✓ python3 $(python3 --version 2>&1 | cut -d' ' -f2)"
echo "✓ ffmpeg found"
echo ""

# ── 2. Install npm dependencies ───────────────────────────────────────
echo "Installing npm dependencies..."
cd "$REPO_DIR" && npm install
echo ""

# ── 2b. Download Jarvis voice models if not present ───────────────────
MODELS_DIR="$REPO_DIR/models/jarvis"
mkdir -p "$MODELS_DIR"

if [[ ! -f "$MODELS_DIR/jarvis-high.onnx" ]]; then
  echo ""
  echo "=== Downloading Jarvis voice models ==="
  echo "Fetching from Hugging Face (170MB total)..."
  HF_BASE="https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis"
  curl -L --progress-bar -o "$MODELS_DIR/jarvis-high.onnx"       "$HF_BASE/high/jarvis-high.onnx"
  curl -L --progress-bar -o "$MODELS_DIR/jarvis-high.onnx.json"  "$HF_BASE/high/jarvis-high.onnx.json"
  curl -L --progress-bar -o "$MODELS_DIR/jarvis-medium.onnx"     "$HF_BASE/medium/jarvis-medium.onnx"
  curl -L --progress-bar -o "$MODELS_DIR/jarvis-medium.onnx.json" "$HF_BASE/medium/jarvis-medium.onnx.json"
  echo "✓ Voice models downloaded."
  MODELS_DOWNLOADED=true
else
  echo "✓ Voice models already present, skipping download."
  MODELS_DOWNLOADED=false
fi
echo ""

# ── 3. Scaffold .env ──────────────────────────────────────────────────
if [[ ! -f "$REPO_DIR/.env" ]]; then
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  echo "Created .env from .env.example"
else
  echo ".env already exists, keeping your values"
fi

# ── 4. Prompt for required values ─────────────────────────────────────
# Sets a key in .env only if it is missing or still has a placeholder value.
prompt_env() {
  local key="$1"
  local prompt_text="$2"
  local default="${3:-}"

  local current
  current=$(grep -E "^${key}=" "$REPO_DIR/.env" | cut -d= -f2- || echo "")

  # Skip if already set to a real value
  if [[ -n "$current" && "$current" != "your_"* && "$current" != "change-me"* && "$current" != "" ]]; then
    echo "  $key already set, skipping"
    return
  fi

  local val
  if [[ -n "$default" ]]; then
    read -rp "  $prompt_text [$default]: " val
    val="${val:-$default}"
  else
    read -rp "  $prompt_text: " val
  fi

  # Update or append the value in .env
  if grep -qE "^${key}=" "$REPO_DIR/.env"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$REPO_DIR/.env"
  else
    echo "${key}=${val}" >> "$REPO_DIR/.env"
  fi
}

echo "=== Configuration ==="
echo "Press Enter to accept defaults where shown."
echo ""

prompt_env DISCORD_TOKEN          "Discord bot token (from developer portal)"
prompt_env DISCORD_GUILD_ID       "Discord server (guild) ID"
prompt_env DISCORD_VOICE_CHANNEL_ID "Voice channel ID to monitor"
prompt_env DISCORD_TEXT_CHANNEL_ID  "Text channel ID for transcripts/posts"
prompt_env ALLOWED_USERS          "Your Discord user ID(s), comma-separated"
prompt_env CLAWDBOT_GATEWAY_URL   "OpenClaw gateway URL" "http://127.0.0.1:22100"
prompt_env CLAWDBOT_GATEWAY_TOKEN "OpenClaw gateway token"
prompt_env ALERT_WEBHOOK_TOKEN    "Webhook API token (use a strong random value)"

# Auto-set TTS_PROVIDER=piper and PIPER_MODEL=high if models were downloaded
if [[ "$MODELS_DOWNLOADED" == "true" ]]; then
  if grep -qE "^TTS_PROVIDER=" "$REPO_DIR/.env"; then
    sed -i "s|^TTS_PROVIDER=.*|TTS_PROVIDER=piper|" "$REPO_DIR/.env"
  else
    echo "TTS_PROVIDER=piper" >> "$REPO_DIR/.env"
  fi
  if grep -qE "^PIPER_MODEL=" "$REPO_DIR/.env"; then
    sed -i "s|^PIPER_MODEL=.*|PIPER_MODEL=high|" "$REPO_DIR/.env"
  else
    echo "PIPER_MODEL=high" >> "$REPO_DIR/.env"
  fi
  echo "  ✓ TTS_PROVIDER set to piper (jarvis-high model)"
fi

echo ""

# ── 5. Create systemd user service ────────────────────────────────────
mkdir -p "$SERVICE_DIR"

NODE_BIN="$(which node)"

cat > "$SERVICE_DIR/jarvis-voice.service" <<EOF
[Unit]
Description=Jarvis Voice Discord Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=$NODE_BIN $REPO_DIR/src/index.js
EnvironmentFile=$REPO_DIR/.env
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable jarvis-voice

echo "=== Done! ==="
echo ""
echo "Start the bot:    systemctl --user start jarvis-voice"
echo "Check status:     systemctl --user status jarvis-voice"
echo "View logs:        journalctl --user -u jarvis-voice -f"
echo ""
echo "Join your voice channel and speak — your OpenClaw agent will respond."
